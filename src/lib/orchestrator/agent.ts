import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { paths } from "../paths.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";
import { withStage } from "../models/loader.js";
import { loadFeatures } from "../settings/features.js";
import { listProjects, PIPELINE_STAGES, PipelineStage, readConfig, readState, runStage, saveConfig, STAGE_LABELS, StepRunner } from "./pipeline.js";

/**
 * Chat orchestrator: the local model (stage "orchestrator", qwen2.5:7b) reads the conversation and
 * the project's pipeline state and answers with a reply plus at most ONE tool call (JSON schema:
 * works the same on a local Qwen and on Claude). Read-only tools run at once; every tool that does
 * work (create a project, run a stage) waits for the user's approval (features.json
 * orchestrator.approveEachStep). After a stage finishes, the next pending stage is proposed, so a
 * video goes from niche to render one approved step at a time. Without a model, a small rule
 * parser understands the same commands.
 */

export const TOOLS = ["list_projects", "pipeline_status", "create_project", "run_stage", "none"] as const;
export type ToolName = (typeof TOOLS)[number];
const READ_ONLY: ToolName[] = ["list_projects", "pipeline_status"];

export interface ToolCall {
  id: string;
  tool: ToolName;
  args: { project?: string; topic?: string; products?: string[]; words?: number; stage?: string; channel?: string; seeds?: string[] };
  status: "proposed" | "running" | "done" | "failed" | "rejected";
  result?: string;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  at: string;
  call?: ToolCall;
}

export interface ChatSession {
  id: string;
  project: string | null;
  messages: ChatMessage[];
  pending: ToolCall | null;
  running: ToolCall | null;
}

const Answer = z.object({
  reply: z.string(),
  tool: z.enum(TOOLS),
  args: z.object({
    project: z.string().optional(),
    topic: z.string().optional(),
    products: z.array(z.string()).optional(),
    words: z.number().optional(),
    stage: z.string().optional(),
    channel: z.string().optional(),
    seeds: z.array(z.string()).optional(),
  }),
});

const SYSTEM = `You are the ClipForge assistant. You run a faceless-YouTube video pipeline for the user, one step at a time.
Stages in order: research (outliers + titles), writing (script), voice (TTS + align), visuals (plan + footage), avatar, edit (timeline), render (video + QA + Shorts).
Tools (pick at most one per answer; "none" when you only reply):
- list_projects {}
- pipeline_status {project}
- create_project {project, topic, products (countdown order, last = #1), words?, channel?, seeds?}
- run_stage {project, stage}
Rules: run stages in order; propose the next pending stage when the user wants to continue; never invent results; keep replies short and in plain English. Project names: lowercase letters, digits, dashes.`;

const sessionsDir = () => env("CHAT_DIR", "") || path.join(paths.root, "cache", "chat");
const nowIso = () => new Date().toISOString();
const newId = () => crypto.randomBytes(6).toString("hex");

export function loadSession(id?: string | null): ChatSession {
  const f = id ? path.join(sessionsDir(), `${id.replace(/[^\w-]/g, "")}.json`) : "";
  if (f && fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")) as ChatSession;
  return { id: newId(), project: null, messages: [], pending: null, running: null };
}

export function saveSession(s: ChatSession): void {
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(), `${s.id}.json`), JSON.stringify(s, null, 1));
}

const say = (s: ChatSession, role: ChatMessage["role"], content: string, call?: ToolCall) => s.messages.push({ role, content, at: nowIso(), ...(call ? { call } : {}) });

export const validProject = (n?: string) => !!n && /^[a-z0-9][a-z0-9-]{1,60}$/.test(n);

/** Status text of a project's pipeline (for the model and the user). */
export function statusText(project: string): string {
  const st = readState(project);
  const cfg = readConfig(project);
  const rows = PIPELINE_STAGES.map((s) => {
    const x = st.stages[s];
    return `${STAGE_LABELS[s]}: ${x.status}${x.ms ? ` (${(x.ms / 1000).toFixed(0)} s, GPU ${((x.gpuMs ?? 0) / 1000).toFixed(0)} s)` : ""}${x.error ? ` - ${x.error}` : ""}`;
  });
  return `${project}${cfg?.topic ? ` "${cfg.topic}"` : ""}: ${rows.join("; ")}`;
}

/** Next stage to run: the first that is not done / skipped. */
export function nextStage(project: string): PipelineStage | null {
  const st = readState(project);
  return PIPELINE_STAGES.find((s) => st.stages[s].status !== "done" && st.stages[s].status !== "skipped") ?? null;
}

/** Rule parser (no model): "status", "projects", "next"/"continue", "run <stage> [for <project>]", "create <name> topic: ... products: a, b". */
export function ruleAnswer(text: string, s: ChatSession): z.infer<typeof Answer> {
  const t = text.trim();
  const proj = /\b(?:for|project)\s+([a-z0-9][a-z0-9-]+)/i.exec(t)?.[1]?.toLowerCase() ?? s.project ?? undefined;
  // The whole name token ("My_Video" -> "my-video" after normalising in chat(), never cut to "my").
  const create = /\bcreate\s+(?:project\s+)?(\S+)/i.exec(t);
  if (create) {
    const topic = /topic[:=]\s*([^;\n]+?)(?=\s+products[:=]|;|$)/i.exec(t)?.[1]?.trim();
    const products = /products[:=]\s*([^;\n]+)/i.exec(t)?.[1]?.split(",").map((x) => x.trim()).filter(Boolean);
    return { reply: `I'll create project ${create[1].toLowerCase()}.`, tool: "create_project", args: { project: create[1].toLowerCase(), topic, products } };
  }
  if (/\b(projects|list)\b/i.test(t)) return { reply: "Here are your projects.", tool: "list_projects", args: {} };
  const stage = PIPELINE_STAGES.find((x) => new RegExp(`\\b${x}\\b`, "i").test(t));
  if (/\brun\b/i.test(t) && stage && proj) return { reply: `Ready to run ${STAGE_LABELS[stage]} for ${proj}.`, tool: "run_stage", args: { project: proj, stage } };
  if (/\b(next|continue|go on|proceed)\b/i.test(t) && proj) {
    const n = nextStage(proj);
    return n ? { reply: `Next step for ${proj}: ${STAGE_LABELS[n]}.`, tool: "run_stage", args: { project: proj, stage: n } } : { reply: `${proj} is complete.`, tool: "none", args: {} };
  }
  if (/\bstatus\b/i.test(t) && proj) return { reply: `Status of ${proj}:`, tool: "pipeline_status", args: { project: proj } };
  return { reply: 'I can list projects, create one ("create my-video topic: best budget 9mm pistols products: A, B, C"), show the status, or run the next step ("next").', tool: "none", args: {} };
}

async function modelAnswer(s: ChatSession): Promise<z.infer<typeof Answer> | null> {
  if (!llmAvailable()) return null;
  const context = s.project ? `Current project: ${statusText(s.project)}` : `Projects: ${listProjects().slice(0, 10).map((p) => `${p.name} (${p.current})`).join(", ") || "none"}`;
  const history = s.messages.slice(-12).map((m) => ({ role: m.role === "assistant" ? ("assistant" as const) : ("user" as const), content: m.role === "tool" ? `[tool result] ${m.content}` : m.content }));
  try {
    const res = await withStage("orchestrator", () =>
      llm().messages.parse({
        model: env("LLM_MODEL", "claude-haiku-4-5"),
        max_tokens: 800,
        output_config: { format: zodOutputFormat(Answer) },
        system: `${SYSTEM}\n\n${context}`,
        messages: history.length ? history : [{ role: "user", content: "hello" }],
      }),
    );
    return res.parsed_output ?? null;
  } catch {
    return null;
  }
}

/** Executes a tool call (after approval when needed). */
export async function execute(s: ChatSession, call: ToolCall, o: { runner?: StepRunner; log?: (m: string) => void } = {}): Promise<void> {
  call.status = "running";
  s.running = call;
  saveSession(s);
  try {
    if (call.tool === "list_projects") call.result = listProjects().map((p) => `${p.name}: ${p.current}${p.qa ? `, QA ${p.qa.pass} pass / ${p.qa.warn} warn / ${p.qa.fail} fail` : ""}`).join("\n") || "no projects yet";
    else if (call.tool === "pipeline_status") call.result = statusText(call.args.project!);
    else if (call.tool === "create_project") {
      const c = saveConfig(call.args.project!, { topic: call.args.topic ?? "", products: call.args.products ?? [], words: call.args.words, channel: call.args.channel, seeds: call.args.seeds });
      s.project = call.args.project!;
      call.result = `Project ${call.args.project} created: "${c.topic}", ${c.products.length} product(s), channel ${c.channel}.`;
    } else if (call.tool === "run_stage") {
      const st = await runStage(call.args.project!, call.args.stage as PipelineStage, o);
      s.project = call.args.project!;
      call.result = `${STAGE_LABELS[call.args.stage as PipelineStage]} ${st.status} in ${((st.ms ?? 0) / 1000).toFixed(0)} s (GPU ${((st.gpuMs ?? 0) / 1000).toFixed(1)} s)${st.error ? `: ${st.error}` : ""}`;
      if (st.status === "failed") throw new Error(call.result);
    }
    call.status = "done";
  } catch (err) {
    call.status = "failed";
    call.result ??= String((err as Error).message);
  }
  s.running = null;
  say(s, "tool", call.result ?? "", call);
  // Keep going: after a finished stage, propose the next one (needs approval again).
  if (call.status === "done" && (call.tool === "run_stage" || call.tool === "create_project") && s.project) {
    const n = nextStage(s.project);
    if (n) propose(s, { tool: "run_stage", args: { project: s.project, stage: n } }, `${call.result} Next: ${STAGE_LABELS[n]}. Approve to run it.`);
    else say(s, "assistant", `${call.result} All stages are done: the video, QA report and Shorts are in the output folder.`);
  }
  saveSession(s);
}

function propose(s: ChatSession, c: Pick<ToolCall, "tool" | "args">, reply: string): ToolCall {
  const call: ToolCall = { id: newId(), tool: c.tool, args: c.args, status: "proposed" };
  s.pending = call;
  say(s, "assistant", reply, call);
  return call;
}

/** Problems with a tool call's arguments (shown instead of running it). */
export function checkArgs(c: Pick<ToolCall, "tool" | "args">): string | null {
  if (c.tool === "pipeline_status" || c.tool === "run_stage") {
    if (!validProject(c.args.project)) return `Which project? (lowercase name, e.g. "budget-9mm")`;
  }
  if (c.tool === "run_stage" && !PIPELINE_STAGES.includes(c.args.stage as PipelineStage)) return `Unknown stage "${c.args.stage}". Stages: ${PIPELINE_STAGES.join(", ")}.`;
  if (c.tool === "create_project") {
    if (!validProject(c.args.project)) return `Project names use lowercase letters, digits and dashes (got "${c.args.project ?? ""}").`;
    if (!c.args.topic) return "What is the video topic?";
    if (!c.args.products?.length) return "Which products, in countdown order (last = #1)?";
  }
  return null;
}

/**
 * One user message. Returns the session; a proposed tool call waits in session.pending for
 * approve(); read-only tools have already run.
 */
export async function chat(s: ChatSession, text: string, o: { runner?: StepRunner; log?: (m: string) => void } = {}): Promise<ChatSession> {
  say(s, "user", text);
  if (s.pending) {
    s.pending.status = "rejected";
    s.pending = null;
  }
  const a = (await modelAnswer(s)) ?? ruleAnswer(text, s);
  if (a.args.project) a.args.project = a.args.project.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  if (a.tool === "none") {
    say(s, "assistant", a.reply);
    saveSession(s);
    return s;
  }
  const problem = checkArgs(a);
  if (problem) {
    say(s, "assistant", problem);
    saveSession(s);
    return s;
  }
  if (READ_ONLY.includes(a.tool) || !loadFeatures().orchestrator.approveEachStep) {
    say(s, "assistant", a.reply);
    await execute(s, { id: newId(), tool: a.tool, args: a.args, status: "proposed" }, o);
  } else propose(s, a, `${a.reply} Approve to continue.`);
  saveSession(s);
  return s;
}

/** The user's answer to the pending tool call. Running a stage happens in the background (`wait` for tests). */
export async function approve(s: ChatSession, yes: boolean, o: { runner?: StepRunner; log?: (m: string) => void; wait?: boolean } = {}): Promise<ChatSession> {
  const call = s.pending;
  if (!call) return s;
  s.pending = null;
  if (!yes) {
    call.status = "rejected";
    say(s, "assistant", "OK, not running it. Tell me what to do instead.");
    saveSession(s);
    return s;
  }
  const job = execute(s, call, o);
  if (o.wait) await job;
  else saveSession(s);
  return s;
}
