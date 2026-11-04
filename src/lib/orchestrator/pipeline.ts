import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";
import { projectDir, readJson, writeJson } from "../project.js";
import { readGpuTimes } from "../models/loader.js";
import { friendlyHint, Hint } from "./friendly.js";

/**
 * The full pipeline as 7 stages, each a list of CLI steps run as child processes (a crash in one
 * never takes the server down):
 *   Research -> Writing -> Voice -> Visuals -> Avatar -> Edit -> Render
 * Per project: <project>/pipeline.json (inputs: topic, products, words, seeds, channel) and
 * <project>/pipeline_state.json (per stage: pending / running / done / failed / skipped, duration,
 * GPU time measured from cache/gpu_time.json before and after the stage, log tail).
 */

export const PIPELINE_STAGES = ["research", "writing", "voice", "visuals", "avatar", "edit", "render"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export const STAGE_LABELS: Record<PipelineStage, string> = { research: "Research", writing: "Writing", voice: "Voice", visuals: "Visuals", avatar: "Avatar", edit: "Edit", render: "Render" };

export type StageStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface StageState {
  status: StageStatus;
  startedAt?: string;
  endedAt?: string;
  ms?: number;
  /** GPU / CPU model time and model load time used by this stage (local models, avatar engines). */
  gpuMs?: number;
  cpuMs?: number;
  loadMs?: number;
  steps?: string[];
  error?: string;
  /** Plain-English problem + fix for a failed stage (src/lib/orchestrator/friendly.ts). */
  hint?: Hint | null;
  log?: string[];
}

/** ranked = the product countdown (the original pipeline); explainer / tutorial = src/lib/formats. */
export type VideoType = "ranked" | "explainer" | "tutorial" | "documentary";
export const VIDEO_TYPES: VideoType[] = ["ranked", "explainer", "tutorial", "documentary"];

export interface PipelineConfig {
  type?: VideoType;
  topic: string;
  products: string[];
  words?: number;
  seeds?: string[];
  channel?: string;
}

export interface PipelineState {
  project: string;
  updatedAt: string;
  stages: Record<PipelineStage, StageState>;
}

const stateFile = (dir: string) => path.join(dir, "pipeline_state.json");
const configFile = (dir: string) => path.join(dir, "pipeline.json");

export function readConfig(project: string): PipelineConfig | null {
  const f = configFile(projectDir(project));
  return fs.existsSync(f) ? readJson<PipelineConfig>(f) : null;
}

export function saveConfig(project: string, c: PipelineConfig): PipelineConfig {
  const dir = projectDir(project);
  fs.mkdirSync(dir, { recursive: true });
  const clean: PipelineConfig = {
    ...(c.type && c.type !== "ranked" && VIDEO_TYPES.includes(c.type) ? { type: c.type } : {}),
    topic: String(c.topic ?? "").trim().slice(0, 160),
    products: (c.products ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 20),
    ...(c.words ? { words: Math.max(200, Math.min(6000, Math.round(Number(c.words)))) } : {}),
    ...(c.seeds?.length ? { seeds: c.seeds.map((s) => String(s).trim()).filter(Boolean).slice(0, 12) } : {}),
    channel: String(c.channel ?? "default").replace(/[^\w.-]/g, "") || "default",
  };
  writeJson(configFile(dir), clean);
  // The CLI steps read the channel from project.json.
  const pf = path.join(dir, "project.json");
  const p = fs.existsSync(pf) ? readJson<Record<string, unknown>>(pf) : { name: project, createdAt: new Date().toISOString() };
  writeJson(pf, { ...p, name: project, channel: clean.channel, title: p.title ?? clean.topic });
  return clean;
}

export function readState(project: string): PipelineState {
  const f = stateFile(projectDir(project));
  const blank = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, { status: "pending" }])) as Record<PipelineStage, StageState>;
  if (!fs.existsSync(f)) return { project, updatedAt: "", stages: blank };
  const s = readJson<PipelineState>(f);
  return { ...s, stages: { ...blank, ...s.stages } };
}

function writeState(project: string, st: PipelineState): void {
  st.updatedAt = new Date().toISOString();
  writeJson(stateFile(projectDir(project)), st);
}

/** CLI steps of a stage (argv after `clipforge`). */
export function stageSteps(stage: PipelineStage, project: string, cfg: PipelineConfig | null): string[][] {
  const dir = projectDir(project);
  const p = fs.existsSync(path.join(dir, "project.json")) ? readJson<{ audio?: string; voiceMode?: string; channel?: string; sourceProject?: string }>(path.join(dir, "project.json")) : {};
  // A language version (src/lib/localize/versions.ts): no research of its own, and its script is
  // translated from the original instead of written.
  const version = !!p.sourceProject;
  // Explainer / tutorial videos: their own tools make the whole picture; ClipForge writes, checks
  // and runs QA (stages without work are skipped).
  if (cfg?.type === "explainer" || cfg?.type === "tutorial") {
    const t = cfg.type;
    if (stage === "writing") return [[t, "-p", project, "--write"]];
    if (stage === "render") return [[t, "-p", project, "--render"], ["qa", "-p", project]];
    return [];
  }
  // Documentary: researched + fact-checked writing, then the normal voice / footage / edit / render.
  if (cfg?.type === "documentary") {
    if (stage === "research") return [];
    if (stage === "writing") return version ? [["translate", "-p", project]] : [["documentary", "-p", project, "--write"]];
    // AI image style: every footage scene becomes a picture in the channel's look (no stock search).
    const din = path.join(dir, "documentary.json");
    if (stage === "visuals" && fs.existsSync(din) && readJson<{ visuals?: string }>(din).visuals === "ai") {
      const ch = cfg.channel ?? p.channel ?? "default";
      return [["plan", "-p", project, "--channel", ch], ["aistyle", "-p", project, "--channel", ch]];
    }
  }
  switch (stage) {
    case "research":
      if (version) return [];
      return [["research", ...(cfg?.seeds?.length ? ["-s", cfg.seeds.join(",")] : [])], ...(cfg?.topic ? [["titles", "-t", cfg.topic]] : [])];
    case "writing":
      if (version) return [["translate", "-p", project]];
      if (!cfg?.topic || !cfg.products.length) return [];
      return [["script", "-p", project, "-t", cfg.topic, "--products", cfg.products.join(","), ...(cfg.words ? ["-w", String(cfg.words)] : [])]];
    case "voice": {
      // An uploaded recording (not a TTS one) is kept: only transcribe + align then. The upload
      // route sets no voiceMode, so the file name also counts (the AI voice is voiceover_tts.wav).
      const own = !!p.audio && fs.existsSync(p.audio) && p.voiceMode !== "tts" && !/voiceover_tts\.wav$/i.test(p.audio);
      const script = path.join(dir, "script.txt");
      return [...(own ? [] : [["tts", "-p", project]]), ["transcribe", "-p", project, "--audio", "{audio}"], ["align", "-p", project, ...(fs.existsSync(script) ? ["--script", script] : ["--no-script-mode"])]];
    }
    case "visuals":
      return [["plan", "-p", project, "--channel", cfg?.channel ?? p.channel ?? "default"], ["assets", "-p", project], ["visuals", "-p", project, "--apply"]];
    case "avatar":
      return [["avatar", "-p", project]];
    case "edit":
      return [["timeline", "-p", project]];
    case "render":
      return [["render", "-p", project], ["qa", "-p", project], ["shorts", "-p", project]];
  }
}

export type StepRunner = (argv: string[], onLine: (l: string) => void) => Promise<number>;

const TSX_CLI = path.join(paths.root, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = path.join(paths.root, "src", "cli.ts");

/** Runs `clipforge <argv>` as a child process. */
export const cliRunner: StepRunner = (argv, onLine) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI, ...argv], { cwd: paths.root, windowsHide: true, env: process.env });
    let buf = "";
    const data = (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        onLine(buf.slice(0, i).replace(/\r$/, ""));
        buf = buf.slice(i + 1);
      }
    };
    child.stdout.on("data", data);
    child.stderr.on("data", data);
    child.on("error", (e) => (onLine(`[pipeline] ${e.message}`), resolve(-1)));
    child.on("close", (code) => resolve(code ?? -1));
  });

const totals = () => {
  const t = { gpuMs: 0, cpuMs: 0, loadMs: 0 };
  for (const x of readGpuTimes()) {
    t.gpuMs += x.gpuMs;
    t.cpuMs += x.cpuMs;
    t.loadMs += x.loadMs;
  }
  return t;
};

/** Runs one stage; its state (and GPU time) is saved as it goes. */
export async function runStage(project: string, stage: PipelineStage, o: { runner?: StepRunner; log?: (m: string) => void } = {}): Promise<StageState> {
  const runner = o.runner ?? cliRunner;
  const cfg = readConfig(project);
  const st = readState(project);
  const steps = stageSteps(stage, project, cfg);
  const s: StageState = { status: "running", startedAt: new Date().toISOString(), steps: steps.map((x) => x[0]), log: [] };
  st.stages[stage] = s;
  writeState(project, st);
  const t0 = Date.now();
  const g0 = totals();
  const line = (l: string) => {
    s.log!.push(l);
    if (s.log!.length > 200) s.log!.splice(0, s.log!.length - 200);
    o.log?.(l);
  };
  if (!steps.length) {
    s.status = "skipped";
    line(`[pipeline] ${STAGE_LABELS[stage]}: nothing to do${stage === "research" || cfg?.type ? "" : " (set topic and products first)"}`);
  } else {
    s.status = "done";
    for (const argv of steps) {
      const pj = path.join(projectDir(project), "project.json");
      const audio = fs.existsSync(pj) ? String(readJson<{ audio?: string }>(pj).audio ?? "") : "";
      const real = argv.map((a) => (a === "{audio}" ? audio : a));
      line(`=== ${real[0]} ===`);
      const code = await runner(real, line);
      // Exit 2 from script/shorts/translate = finished with warnings (report written); anything else non-zero fails.
      if (code !== 0 && !(code === 2 && (real[0] === "script" || real[0] === "shorts" || real[0] === "translate" || real[0] === "explainer" || real[0] === "documentary"))) {
        s.status = "failed";
        s.error = `${real[0]} exited with code ${code}`;
        s.hint = friendlyHint(s.log ?? [], s.error);
        break;
      }
      writeState(project, st);
    }
  }
  const g1 = totals();
  Object.assign(s, { endedAt: new Date().toISOString(), ms: Date.now() - t0, gpuMs: g1.gpuMs - g0.gpuMs, cpuMs: g1.cpuMs - g0.cpuMs, loadMs: g1.loadMs - g0.loadMs });
  writeState(project, st);
  o.log?.(`[pipeline] ${project}: ${STAGE_LABELS[stage]} ${s.status} in ${((s.ms ?? 0) / 1000).toFixed(1)} s, GPU ${((s.gpuMs ?? 0) / 1000).toFixed(1)} s`);
  return s;
}

/** Runs stages in order from `from`, stopping at the first failure. */
export async function runPipeline(project: string, from: PipelineStage = "research", o: { runner?: StepRunner; log?: (m: string) => void; until?: PipelineStage } = {}): Promise<PipelineState> {
  const start = PIPELINE_STAGES.indexOf(from);
  const end = o.until ? PIPELINE_STAGES.indexOf(o.until) : PIPELINE_STAGES.length - 1;
  for (const stage of PIPELINE_STAGES.slice(start, end + 1)) {
    const s = await runStage(project, stage, o);
    if (s.status === "failed") break;
  }
  return readState(project);
}

export interface ProjectSummary {
  name: string;
  title: string;
  channel: string;
  stages: Record<PipelineStage, StageStatus>;
  current: string;
  qa: { pass: number; warn: number; fail: number } | null;
  outputs: { video: string | null; shorts: string[] };
  gpuMs: number;
  updatedAt: string;
}

/** Dashboard rows: every project in the workspace. */
export function listProjects(): ProjectSummary[] {
  if (!fs.existsSync(paths.workspace)) return [];
  const out: ProjectSummary[] = [];
  for (const name of fs.readdirSync(paths.workspace)) {
    const dir = path.join(paths.workspace, name);
    if (!fs.statSync(dir).isDirectory() || !fs.existsSync(path.join(dir, "project.json"))) continue;
    const p = readJson<{ title?: string; channel?: string }>(path.join(dir, "project.json"));
    const st = readState(name);
    const qaFile = path.join(dir, "qa_report.json");
    const qa = fs.existsSync(qaFile) ? readJson<{ summary: { pass: number; warn: number; fail: number } }>(qaFile).summary : null;
    const video = path.join(paths.output, `${name}.mp4`);
    const shorts = fs.existsSync(paths.output) ? fs.readdirSync(paths.output).filter((f) => f.startsWith(`${name}_short_`) && f.endsWith(".mp4")) : [];
    const statuses = Object.fromEntries(PIPELINE_STAGES.map((s) => [s, st.stages[s].status])) as Record<PipelineStage, StageStatus>;
    const running = PIPELINE_STAGES.find((s) => statuses[s] === "running");
    const failed = PIPELINE_STAGES.find((s) => statuses[s] === "failed");
    const next = PIPELINE_STAGES.find((s) => statuses[s] === "pending");
    out.push({
      name,
      title: p.title ?? name,
      channel: p.channel ?? "default",
      stages: statuses,
      current: running ? `${STAGE_LABELS[running]} running` : failed ? `${STAGE_LABELS[failed]} failed` : next ? `next: ${STAGE_LABELS[next]}` : "complete",
      qa,
      outputs: { video: fs.existsSync(video) ? `${name}.mp4` : null, shorts },
      gpuMs: PIPELINE_STAGES.reduce((a, s) => a + (st.stages[s].gpuMs ?? 0), 0),
      updatedAt: st.updatedAt || fs.statSync(path.join(dir, "project.json")).mtime.toISOString(),
    });
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
