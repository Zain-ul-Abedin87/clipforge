import { loadLlmSettings, saveLlmSettings, STAGES as LLM_STAGES, stageModel } from "../../lib/agents/llm/settings.js";
import { readGpuTimes } from "../../lib/models/loader.js";
import { approve, chat, ChatSession, loadSession } from "../../lib/orchestrator/agent.js";
import { listProjects, PIPELINE_STAGES, PipelineStage, readConfig, readState, runPipeline, runStage, saveConfig, STAGE_LABELS, stageSteps } from "../../lib/orchestrator/pipeline.js";

/**
 * Full-pipeline API:
 *   GET  /api/dashboard                    all projects: stage statuses, QA score, outputs, GPU time
 *   GET  /api/pipeline/:project            config + per-stage state + the CLI steps of each stage
 *   PUT  /api/pipeline/:project/config     {topic, products[], words?, seeds?, channel?}
 *   POST /api/pipeline/:project/run        {stage} one stage, or {from} the rest (background)
 *   GET  /api/models                       per-stage local models (llm_settings.json stages) + GPU time
 *   PUT  /api/models                       {stages: {plan: {model, numCtx}}, models: {...}, qwen: {...}}
 *   GET  /api/chat/:id                     a chat session
 *   POST /api/chat                         {id?, message}
 *   POST /api/chat/:id/approve             {approve: boolean}
 */

const running = new Set<string>();
const live = new Map<string, ChatSession>();
const session = (id?: string | null) => {
  if (id && live.has(id)) return live.get(id)!;
  const s = loadSession(id);
  live.set(s.id, s);
  return s;
};

const valid = (n: string) => /^[\w.\- ]{1,80}$/.test(n) && !n.includes("..");

export async function pipelineRoute(parts: string[], method: string, body: () => Promise<string>): Promise<{ status: number; body: unknown } | null> {
  const json = async () => JSON.parse((await body()) || "{}") as Record<string, unknown>;

  if (parts[1] === "dashboard" && method === "GET") {
    const gpu = readGpuTimes();
    return { status: 200, body: { projects: listProjects(), gpu, stages: PIPELINE_STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s] })) } };
  }

  if (parts[1] === "models") {
    if (method === "PUT") {
      const b = await json();
      saveLlmSettings({ ...(b.stages ? { stages: b.stages } : {}), ...(b.models ? { models: b.models } : {}), ...(b.qwen ? { qwen: b.qwen } : {}) });
    } else if (method !== "GET") return { status: 405, body: { error: "GET or PUT" } };
    const s = loadLlmSettings();
    return { status: 200, body: { qwen: s.qwen, models: s.models, stages: LLM_STAGES.map((id) => ({ id, own: s.stages[id] ?? null, text: stageModel(id, false, s), vision: id === "vision" ? stageModel(id, true, s) : null })), gpu: readGpuTimes() } };
  }

  if (parts[1] === "pipeline" && parts[2]) {
    const project = parts[2];
    if (!valid(project)) return { status: 400, body: { error: "invalid project name" } };
    if (method === "GET" && !parts[3]) {
      const cfg = readConfig(project);
      return { status: 200, body: { project, config: cfg, state: readState(project), running: running.has(project), stages: PIPELINE_STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s], steps: stageSteps(s, project, cfg).map((a) => a.join(" ")) })) } };
    }
    if (method === "PUT" && parts[3] === "config") {
      const b = await json();
      const products = Array.isArray(b.products) ? b.products.map(String) : String(b.products ?? "").split(",");
      const seeds = Array.isArray(b.seeds) ? b.seeds.map(String) : b.seeds ? String(b.seeds).split(",") : undefined;
      return { status: 200, body: saveConfig(project, { topic: String(b.topic ?? ""), products, words: b.words ? Number(b.words) : undefined, seeds, channel: b.channel ? String(b.channel) : undefined }) };
    }
    if (method === "POST" && parts[3] === "run") {
      if (running.has(project)) return { status: 409, body: { error: "this project is already running" } };
      const b = await json();
      const stage = PIPELINE_STAGES.find((s) => s === b.stage);
      const from = PIPELINE_STAGES.find((s) => s === b.from);
      const until = PIPELINE_STAGES.find((s) => s === b.until);
      if (!stage && !from) return { status: 400, body: { error: `stage or from must be one of ${PIPELINE_STAGES.join(", ")}` } };
      running.add(project);
      const job = stage ? runStage(project, stage as PipelineStage, { log: (m) => console.log(m) }) : runPipeline(project, from as PipelineStage, { log: (m) => console.log(m), until });
      void job.finally(() => running.delete(project));
      return { status: 202, body: { ok: true, project, stage: stage ?? null, from: from ?? null } };
    }
    return { status: 404, body: { error: "unknown pipeline route" } };
  }

  if (parts[1] === "chat") {
    if (method === "GET" && parts[2]) return { status: 200, body: session(parts[2]) };
    if (method === "POST" && !parts[2]) {
      const b = await json();
      const text = String(b.message ?? "").trim().slice(0, 2000);
      if (!text) return { status: 400, body: { error: "message is required" } };
      const s = session(typeof b.id === "string" ? b.id : null);
      if (s.running) return { status: 409, body: { error: "a step is running; wait for it to finish" } };
      return { status: 200, body: await chat(s, text, { log: (m) => console.log(m) }) };
    }
    if (method === "POST" && parts[2] && parts[3] === "approve") {
      const b = await json();
      const s = session(parts[2]);
      return { status: 200, body: await approve(s, b.approve === true, { log: (m) => console.log(m) }) };
    }
    return { status: 404, body: { error: "unknown chat route" } };
  }
  return null;
}
