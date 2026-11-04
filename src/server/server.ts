import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { env, hasKey, reloadEnv } from "../lib/env.js";
import { paths } from "../lib/paths.js";
import { listChannels, loadStyle } from "../lib/style.js";
import { listNiches } from "../lib/niche.js";
import { addPresskitFile, listPresskit, removePresskitFile } from "../lib/assets/presskit.js";
import { engineStatus, setEngine } from "../lib/agents/llm/engine.js";
import { applyCandidate, applyManualFile, loadCandidates, saveCandidates, searchAlternatives } from "../lib/assets/review.js";
import { FOOTAGE_MODE_LABELS, FOOTAGE_MODES, loadNiche, loadProjectNiche } from "../lib/niche.js";
import { cleanQueries, savePlanEdit } from "../lib/planEdits.js";
import { youtubeStatus } from "../lib/assets/youtube.js";
import { approval, gateState, planEstimate, ProjectLike } from "./planGate.js";
import { saveWordEdit } from "../lib/wordEdits.js";
import { importFile, listLibrary, removeLibraryFile } from "../lib/assets/library.js";
import { parseMusicChoice, trackPath } from "../lib/music.js";
import { CAPTION_PRESETS } from "../lib/render/captionPresets.js";
import { createChannel, listMusic, musicDir, removeLogo, removeMusic, saveLogo, saveMusic, updateStyle } from "../lib/channels.js";
import { BatchQueue, type VideoQueue } from "./queue.js";
import { MemoryJobStore, RedisJobStore, type JobStore, type StoredState } from "./jobStore.js";
import { createDispatcher, LocalDispatcher, RedisBatchQueue, workerStages, type Dispatcher, type PipelineJob, type Stage, type StageResult } from "./pipelineQueue.js";
import { redis } from "../lib/redis.js";
import { importOfficial } from "../lib/assets/official.js";
import { parseScriptHtml, scriptSections, scriptText } from "../lib/scriptImport.js";
import { footageSummary, listReview, reviewThumb, swapShot } from "../lib/sceneReview.js";
import { ALL_CARDS, CARD_FONTS } from "../lib/stylePreset.js";
import { buildUiNiche, keyStatus, loadAppSettings, runEnv, saveAppSettings, UiNiche } from "./simpleUi.js";
import { ttsStatus } from "../lib/tts.js";
import { INPUT_MODE_LABELS, InputMode, modeFromVoiceMode, resolveInputMode } from "../lib/inputMode.js";
import { loadResolutions, saveResolution } from "../commands/align.js";
import { RESOLUTIONS, Resolution } from "../lib/align.js";
import { ensureProductRecords, readResearch, updateProductRecord } from "../lib/productResearch.js";
import { readVerifications, saveVerification } from "../lib/qaGate.js";
import { listVaults, vaultName } from "../lib/agents/youtube/ytExtractor.js";
import { genericStockAllowed } from "../lib/assets/sources.js";
import { detectAndWriteNiche } from "../lib/nicheDetect.js";
import { ProjectStore } from "./state/projectStore.js";
import { createEditorAPI } from "./routes/editorAPI.js";
import { researchRoute } from "./routes/research.js";
import { pipelineRoute } from "./routes/pipeline.js";
import { wizardRoute } from "./routes/wizard.js";
import { makeRoute } from "./routes/make.js";
import { resolvePage } from "./pages.js";
import { aistyleRoute } from "./routes/aistyle.js";
import { saveRef } from "../lib/assets/aiStyle.js";
import { setRecording, tutorialDir, VIDEO_EXT } from "../lib/formats/tutorial.js";
import { defaultBrief, hasBrief, loadBrief, saveBrief, targetWords } from "../lib/channelBrief.js";
import { clipsDir, LONG_VIDEO_EXT, readClipsInput, setClipsSource } from "../lib/shorts/longform.js";
import { storyboard, storyThumb } from "./storyboard.js";
import { poolConfig } from "../lib/assets/productPool.js";
import { activeProvider, testProvider } from "../lib/agents/llm/llm.js";
import { enableProvider, loadLlmSettings, PROVIDERS, providerOrder, providerStatus, ProviderName, qwenKey, QWEN_PRESETS, saveLlmSettings } from "../lib/agents/llm/settings.js";

const WEB_DIR = path.join(paths.root, "web");
const CARDS_PUBLIC = path.join(paths.root, "cards", "public");
const TSX_CLI = path.join(paths.root, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = path.join(paths.root, "src", "cli.ts");

const STEPS = ["transcribe", "align", "plan", "assets", "timeline", "render", "qa"] as const;
type Step = (typeof STEPS)[number];
const STEP_OUTPUT: Record<Step, string> = { transcribe: "words.json", align: "aligned.json", plan: "scenes.json", assets: "assets.json", timeline: "timeline.json", render: "render_report.json", qa: "qa_report.json" };
const READABLE = new Set(["decisions.json", "translation_report.json", "licenses.json", "discrepancies.json", "product_research.json", "preflight.json", "tts.json", "model_verifications.json", "chapters.json", "facts.json", "candidates.json", "qa_report.json", "approval.json", "words.json", "aligned.json", "scenes.json", "sections.json", "plan_report.json", "drift_report.json", "assets.json", "assets_report.json", "timeline.json", "render_report.json"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a"]);
const MANUAL_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".jpg", ".jpeg", ".png", ".webp"]);
/** "tts" (Mode B narration) runs before transcribe; it is not one of the 7 stepper steps. */
type RunStep = Step | "tts";
/** Extra CLI flags for one run, e.g. render --scene 12. */
type ExtraArgs = Partial<Record<RunStep, string[]>>;

interface Job {
  running: boolean;
  step: RunStep | null;
  failedStep: RunStep | null;
  log: string[];
  startedAt: number;
  finishedAt?: number;
  /** Stopped after the plan: waiting for the user to approve it. */
  awaitingApproval?: boolean;
  /** Stopped after the timeline: waiting for the user to review scenes and press Render. */
  awaitingReview?: boolean;
  /** The user pressed Stop: failedStep is where Continue picks up. */
  stoppedByUser?: boolean;
}
const jobs = new Map<string, Job>();
/** The step process each project is running here (Stop kills it); projects whose Stop was pressed. */
const children = new Map<string, ChildProcess>();
const stopAsked = new Set<string>();

/** Ends a step process and everything it started (Python workers, FFmpeg). */
function killTree(child: ChildProcess): void {
  if (!child.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
  // Elsewhere: the step's Python workers read their requests from its pipes and exit with it.
  else child.kill("SIGTERM");
}

/** Where Continue starts: the step that was stopped or failed, else the first step not done yet. */
function continueFrom(name: string): Step | null {
  const j = jobs.get(name);
  if (j?.failedStep && (STEPS as readonly string[]).includes(j.failedStep)) return j.failedStep as Step;
  const st = stepStatus(name);
  return STEPS.find((x) => st[x] !== "done") ?? null;
}

// ---------- Job state persistence (Redis when REDIS_URL is set, else this process only) ----------
let store: JobStore = new MemoryJobStore();
let dispatcher: Dispatcher = new LocalDispatcher();
/**
 * Projects this process is starting or running right now: their map entry is the freshest state
 * and a refresh from Redis must not replace it. A count, because the enqueue in runJob and the
 * in-process worker's runSteps can overlap.
 */
const localActive = new Map<string, number>();
const hold = (n: string) => localActive.set(n, (localActive.get(n) ?? 0) + 1);
const release = (n: string) => {
  const c = (localActive.get(n) ?? 1) - 1;
  if (c <= 0) localActive.delete(n);
  else localActive.set(n, c);
};
/** Per-project write chain, so state saves and log lines reach Redis in order. */
const chains = new Map<string, Promise<unknown>>();
const pendingLines = new Map<string, string[]>();
function persist(name: string, fn: () => Promise<unknown>): void {
  if (store.kind === "memory") return;
  const next = (chains.get(name) ?? Promise.resolve()).then(fn).catch((e) => console.warn(`[jobs] ${name}: ${String(e?.message ?? e).slice(0, 160)}`));
  chains.set(name, next);
}
const stateOf = ({ log: _log, ...rest }: Job): StoredState => rest;
/** Saves this job object (the runner's own, never a map lookup a refresh may have replaced). */
function saveJob(name: string, job: Job | undefined = jobs.get(name)): void {
  if (job) persist(name, () => store.save(name, stateOf(job)));
}
/** Log lines are batched (CLI steps print fast) and flushed after 200 ms or before a state save. */
function logLine(name: string, line: string): void {
  if (store.kind === "memory") return;
  const buf = pendingLines.get(name) ?? [];
  buf.push(line);
  if (buf.length === 1) {
    pendingLines.set(name, buf);
    setTimeout(() => flushLog(name), 200);
  }
}
function flushLog(name: string): void {
  const buf = pendingLines.get(name);
  if (!buf?.length) return;
  pendingLines.delete(name);
  persist(name, () => store.append(name, buf));
}
/** Pulls the shared state of these projects into the map (Redis mode; workers may run elsewhere). */
async function refreshJobs(names: string[]): Promise<void> {
  if (store.kind === "memory" || !names.length) return;
  const got = await store.loadMany(names.filter((n) => !localActive.has(n))).catch(() => new Map<string, StoredState>());
  // Checked again after the await: a run may have started here while Redis was being read.
  for (const [n, st] of got) if (!localActive.has(n)) jobs.set(n, { ...(st as Omit<Job, "log">), log: jobs.get(n)?.log ?? [] });
}

const validName = (n: string) => /^[A-Za-z0-9_-]{1,64}$/.test(n);
const projDir = (n: string) => path.join(paths.workspace, n);

function readProject(name: string): Record<string, unknown> | null {
  const f = path.join(projDir(name), "project.json");
  if (!fs.existsSync(f)) return null;
  // Notepad / PowerShell write a BOM; one unreadable file must not break the project list.
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, ""));
  } catch (err) {
    console.error(`[server] ${f}: ${(err as Error).message}`);
    return { name, broken: true };
  }
}

function writeProject(name: string, patch: Record<string, unknown>): void {
  fs.mkdirSync(projDir(name), { recursive: true });
  const cur = readProject(name) ?? { name };
  // Never overwrite a file that could not be parsed: the user's settings are still in it.
  if (cur.broken) throw new Error(`${name}/project.json is not valid JSON; fix or delete it first`);
  fs.writeFileSync(path.join(projDir(name), "project.json"), JSON.stringify({ ...cur, ...patch }, null, 2));
}

function stepStatus(name: string): Record<Step, "done" | "pending" | "running" | "failed"> {
  const job = jobs.get(name);
  const out = {} as Record<Step, "done" | "pending" | "running" | "failed">;
  for (const s of STEPS) {
    if (job?.running && job.step === s) out[s] = "running";
    else if (!job?.running && (job?.failedStep === s || (job?.failedStep === "tts" && s === "transcribe"))) out[s] = "failed";
    else out[s] = fs.existsSync(path.join(projDir(name), STEP_OUTPUT[s])) ? "done" : "pending";
  }
  return out;
}

function summary(name: string) {
  const p = readProject(name) ?? {};
  const job = jobs.get(name);
  return {
    name,
    audio: p.audio ? path.basename(String(p.audio)) : null,
    hasScript: fs.existsSync(path.join(projDir(name), "script.txt")),
    channel: p.channel ?? "default",
    niche: p.niche ?? null,
    footage: p.footage ?? "stock_cc",
    planGate: gateState(projDir(name), p as ProjectLike),
    createdAt: p.createdAt ?? null,
    voiceMode: p.voiceMode ?? null,
    inputMode: inputModeOf(name),
    steps: stepStatus(name),
    running: job?.running ?? false,
    stoppedByUser: !job?.running && !!job?.stoppedByUser,
    continueFrom: job?.running ? null : continueFrom(name),
  };
}

/** Mode A / B / C of a project: stored at Go time, else derived from what was uploaded. */
function inputModeOf(name: string): InputMode | null {
  const p = readProject(name) ?? {};
  if (p.inputMode === "A" || p.inputMode === "B" || p.inputMode === "C") return p.inputMode;
  const hasScript = fs.existsSync(path.join(projDir(name), "script.txt"));
  return modeFromVoiceMode(p.voiceMode) ?? resolveInputMode({ hasUploadedAudio: !!p.audio && p.voiceMode !== "tts", hasScript });
}

function cliArgs(name: string, step: RunStep, force: boolean, useLlm: boolean, extra: ExtraArgs = {}): string[] {
  const p = readProject(name) ?? {};
  const args = [step, "--project", name, ...(extra[step] ?? [])];
  if (step === "transcribe") args.push("--audio", String(p.audio));
  if (step === "align") {
    const script = path.join(projDir(name), "script.txt");
    if (fs.existsSync(script)) args.push("--script", script);
    else args.push("--no-script-mode");
  }
  if (step === "plan") {
    args.push("--channel", String(p.channel ?? "default"));
    if (!useLlm) args.push("--no-llm");
  }
  // QA always re-checks everything and has no --force option.
  if (force && step !== "qa") args.push("--force");
  return args;
}

/**
 * Starts a pipeline run. Local mode: runs the steps here to the end (as before). BullMQ mode: the
 * project is marked queued and the first stage goes to its queue; workers run the stages.
 */
async function runJob(name: string, steps: RunStep[], force: boolean, useLlm: boolean, gate = true, extra: ExtraArgs = {}): Promise<void> {
  const job: PipelineJob = { project: name, steps, force, useLlm, gate, extra: extra as Record<string, string[]>, stageIndex: 0 };
  if (dispatcher.kind !== "bullmq") return dispatcher.start(job);
  // Visible (and 409-protected) at once, before a worker picks it up.
  hold(name);
  try {
    const queued: Job = { running: true, step: null, failedStep: null, log: ["=== queued ==="], startedAt: Date.now() };
    jobs.set(name, queued);
    persist(name, () => store.clearLog(name));
    saveJob(name, queued);
    logLine(name, "=== queued ===");
    flushLog(name);
    await (chains.get(name) ?? Promise.resolve());
    await dispatcher.start(job);
  } finally {
    release(name);
  }
}

/** Stage runner: one job's steps (all of them in local mode, one stage's in BullMQ mode). */
async function stageRunner(p: PipelineJob, steps: string[], final: boolean): Promise<StageResult> {
  const name = p.project;
  if (p.batchId && p.stageIndex === 0 && dispatcher.kind === "bullmq") await RedisBatchQueue.update(redis()!, p.batchId, { status: "running", startedAt: new Date().toISOString() });
  return runSteps(name, steps as RunStep[], p.force, p.useLlm, p.gate, p.extra as ExtraArgs, { continueLog: p.stageIndex > 0, final });
}

/** Runs steps as child CLI processes so a crash in one never takes the web server down. */
async function runSteps(
  name: string,
  steps: RunStep[],
  force: boolean,
  useLlm: boolean,
  gate = true,
  extra: ExtraArgs = {},
  opts: { continueLog?: boolean; final?: boolean } = {},
): Promise<StageResult> {
  reloadEnv();
  const final = opts.final ?? true;
  const prev = jobs.get(name);
  const job: Job = { running: true, step: null, failedStep: null, log: opts.continueLog && prev ? prev.log : [], startedAt: opts.continueLog && prev ? prev.startedAt : Date.now() };
  jobs.set(name, job);
  if (!opts.continueLog) stopAsked.delete(name);
  hold(name);
  try {
    if (!opts.continueLog && dispatcher.kind === "local") persist(name, () => store.clearLog(name));
    saveJob(name, job);
    const push = (line: string) => {
      job.log.push(line);
      if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
      logLine(name, line);
    };

    for (const step of steps) {
      if (stopAsked.has(name)) {
        Object.assign(job, { stoppedByUser: true, failedStep: step });
        break;
      }
      // Plan approval gate: footage is only fetched for a plan the user has approved.
      if (gate && step === "assets" && gateState(projDir(name), (readProject(name) ?? {}) as ProjectLike) === "waiting") {
        job.awaitingApproval = true;
        push("=== plan ready ===");
        push("Review the scene plan, change searches if you like, then press \"Approve plan & make video\".");
        break;
      }
      job.step = step;
      saveJob(name, job);
      push(`=== ${step} ===`);
      const code = await new Promise<number>((resolve) => {
        const child = spawn(process.execPath, [TSX_CLI, CLI, ...cliArgs(name, step, force, useLlm, extra)], {
          cwd: paths.root,
          windowsHide: true,
          // Simple UI settings (web crawl on/off and mode) reach every step.
          env: { ...process.env, ...runEnv(loadAppSettings()) },
        });
        children.set(name, child);
        child.on("close", () => children.delete(name));
        let buf = "";
        const onData = (d: Buffer) => {
          buf += d.toString();
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            // Hugging Face / tqdm noise is not useful in the UI.
            if (line.trim() && !/UserWarning|warnings\.warn|symlink|developer mode|HF_TOKEN/i.test(line)) push(line);
          }
        };
        child.stdout.on("data", onData);
        child.stderr.on("data", onData);
        child.on("close", (c) => resolve(c ?? 1));
        child.on("error", (e) => {
          push(String(e));
          resolve(1);
        });
      });
      if (code !== 0 && stopAsked.has(name)) {
        Object.assign(job, { stoppedByUser: true, failedStep: step });
        break;
      }
      if (code !== 0) {
        job.failedStep = step;
        push(step === "tts" && code === 2 ? "!!! tts: no TTS provider configured - see the message above (set TTS_PROVIDER in .env or upload a voiceover)" : `!!! ${step} failed (exit ${code})`);
        break;
      }
      // Scene review gate: projects created with "review before render" stop after the timeline.
      const pj = readProject(name) ?? {};
      if (step === "timeline" && steps.includes("render") && pj.review === true && !pj.reviewDone && !extra.render) {
        job.awaitingReview = true;
        push("=== review ===");
        push("Scenes ready: review / swap clips, then press Render.");
        break;
      }
    }
    const stopped = !!(job.awaitingApproval || job.awaitingReview);
    job.step = null;
    if (final || job.failedStep || stopped) {
      job.running = false;
      job.finishedAt = Date.now();
      if (job.stoppedByUser) push(`=== stopped by you during ${job.failedStep} === Press Continue to pick up from there.`);
      else if (!stopped) push(job.failedStep ? "Stopped." : "All steps finished.");
    } else push("=== next stage queued ===");
    flushLog(name);
    saveJob(name, job);
    await (chains.get(name) ?? Promise.resolve());
    return { failedStep: job.failedStep, stopped };
  } finally {
    release(name);
  }
}

/** Model-vault harvests run as child CLI processes (one per model), independent of projects. */
const harvestJobs = new Map<string, { running: boolean; failed: boolean; log: string[] }>();

/** Block-based timeline editor: JSON-RPC on POST /api/editor (src/server/routes/editorAPI.ts). */
const editorApi = createEditorAPI({
  store: new ProjectStore(projDir),
  dirOf: projDir,
  validProject: validName,
  musicLibrary: (name) => {
    const channel = String(readProject(name)?.channel ?? "default");
    return listMusic(channel).map((t) => ({ ...t, path: path.join(musicDir(channel), t.name) }));
  },
  isBusy: (name) => jobs.get(name)?.running === true,
  // Incremental: only edited scenes re-render, the rest are stitched from the segment cache.
  render: (name) => {
    writeProject(name, { reviewDone: true });
    void runJob(name, ["render", "qa"], false, true, false);
  },
  categoryOf: (name) => {
    const p = (readProject(name) ?? {}) as ProjectLike;
    return env("HARVEST_CATEGORY", "") || poolConfig(loadProjectNiche(p, loadStyle(String(p.channel ?? "default")))).category || "lawn mower";
  },
});
function runHarvest(name: string, args: string[]): void {
  reloadEnv();
  const job = { running: true, failed: false, log: [`=== harvest ${args.slice(1).join(" ")} ===`] };
  harvestJobs.set(name, job);
  const child = spawn(process.execPath, [TSX_CLI, CLI, ...args], { cwd: paths.root, windowsHide: true, env: process.env });
  let buf = "";
  const onData = (d: Buffer) => {
    buf += d.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.trim() && !/UserWarning|warnings\.warn|HF_TOKEN/i.test(line)) job.log.push(line);
      if (job.log.length > 1000) job.log.splice(0, job.log.length - 1000);
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("close", (code) => Object.assign(job, { running: false, failed: code !== 0 }));
  child.on("error", (e) => (job.log.push(String(e)), Object.assign(job, { running: false, failed: true })));
}

// Batch queue: one video at a time through every step; waits while any manual run is busy.
let queue: VideoQueue;
let ytStatus: Promise<{ ok: boolean; detail: string }> | undefined;

// ---------- HTTP helpers ----------

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json"): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** Streams a file with HTTP Range support (needed for seeking in <audio>). */
function streamFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }
}

// ---------- Routes ----------

const FULL_PAGES = ["new", "make", "brief", "research", "pipeline", "dashboard", "tools", "chat"];

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? "GET";

  if (parts[0] !== "api") {
    // One UI (web/simple). Old classic / editor links land on it (the studio has the editor).
    if (url.pathname === "/index.html" || url.pathname === "/editor.html") {
      const p = url.searchParams.get("project");
      res.writeHead(302, { Location: p && validName(p) ? `/app#/project/${encodeURIComponent(p)}` : "/" });
      return void res.end();
    }
    // The five tabs and /app (src/server/pages.ts); old addresses redirect.
    const tab = resolvePage(url.pathname, url.search);
    if (tab && "redirect" in tab) {
      res.writeHead(302, { Location: tab.redirect });
      return void res.end();
    }
    if (tab) return send(res, 200, fs.readFileSync(path.join(WEB_DIR, tab.file)), "text/html; charset=utf-8");
    // Full-pipeline pages (web/<name>.html): the wizard, other video types, pipeline details, chat.
    const page = FULL_PAGES.find((p) => url.pathname === `/${p}` || url.pathname === `/${p}/`);
    if (page && fs.existsSync(path.join(WEB_DIR, `${page}.html`))) return send(res, 200, fs.readFileSync(path.join(WEB_DIR, `${page}.html`)), "text/html; charset=utf-8");
    // The Remotion cards' fonts and photos (cards/public), for the studio's live preview.
    const inCards = url.pathname.startsWith("/cards-static/");
    const root = inCards ? CARDS_PUBLIC : WEB_DIR;
    const rel = url.pathname === "/" ? "simple/index.html" : inCards ? url.pathname.slice("/cards-static/".length) : url.pathname.slice(1);
    const file = path.resolve(root, rel);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] ?? "application/octet-stream");
  }

  if (parts[1] === "status" && method === "GET") {
    reloadEnv(); // keys added to .env while the server runs show up without a restart
    ytStatus ??= youtubeStatus();
    return send(res, 200, { anthropicKey: hasKey("ANTHROPIC_API_KEY"), storyblocksKey: hasKey("STORYBLOCKS_PUBLIC_KEY") && hasKey("STORYBLOCKS_PRIVATE_KEY"), pexelsKey: hasKey("PEXELS_API_KEY"), pixabayKey: hasKey("PIXABAY_API_KEY"), unsplashKey: hasKey("UNSPLASH_ACCESS_KEY"), youtubeCC: await ytStatus });
  }

  if (parts[1] === "app-settings") {
    reloadEnv();
    if (method === "PUT") return send(res, 200, { settings: saveAppSettings(JSON.parse((await readBody(req)) || "{}")), keys: keyStatus() });
    if (method === "GET") return send(res, 200, { settings: loadAppSettings(), keys: keyStatus() });
  }

  if (parts[1] === "style-meta" && method === "GET") return send(res, 200, { cards: ALL_CARDS, fonts: CARD_FONTS, captionStyles: CAPTION_PRESETS.map(({ id, label, description }) => ({ id, label, description })) });

  if (parts[1] === "footage-modes" && method === "GET") {
    return send(res, 200, FOOTAGE_MODES.map((m) => ({ name: m, label: FOOTAGE_MODE_LABELS[m] })));
  }

  // Own clips / photos uploaded from the computer (tier 1 footage), with a source note per file.
  if (parts[1] === "library") {
    const channel = url.searchParams.get("channel") ?? "default";
    if (!listChannels().includes(channel)) return send(res, 400, { error: "unknown channel" });
    const lroot = url.searchParams.get("root") === "presskit" ? "presskit" : "footage";
    if (method === "GET") return send(res, 200, listLibrary(channel, lroot));
    if (method === "POST") {
      const label = decodeURIComponent(String(req.headers["x-label"] ?? "")).trim();
      const note = decodeURIComponent(String(req.headers["x-note"] ?? "")).trim();
      const filename = decodeURIComponent(String(req.headers["x-filename"] ?? ""));
      if (!note) return send(res, 400, { error: "write where the file comes from (source / permission)" });
      try {
        return send(res, 200, { ok: true, ...(await importFile(req, channel, lroot, label, filename, note)) });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (method === "DELETE") {
      removeLibraryFile(channel, lroot, String(url.searchParams.get("folder")), String(url.searchParams.get("file")));
      return send(res, 200, { ok: true });
    }
  }

  if (parts[1] === "presskit") {
    const channel = url.searchParams.get("channel") ?? "default";
    if (!listChannels().includes(channel)) return send(res, 400, { error: "unknown channel" });
    // Official photo importer: product names -> manufacturer product pages -> press kit.
    if (parts[2] === "official" && method === "POST") {
      reloadEnv();
      const body = JSON.parse((await readBody(req)) || "{}");
      const products = (Array.isArray(body.products) ? body.products : []).map((p: unknown) => String(p).trim()).filter(Boolean).slice(0, 30);
      if (!products.length) return send(res, 400, { error: "no product names" });
      const niche = loadNiche(typeof body.niche === "string" ? body.niche : "guns");
      const lines: string[] = [];
      const results = await importOfficial(channel, products, niche, (m) => lines.push(m), !!body.force);
      return send(res, 200, { results, log: lines });
    }
    if (method === "GET") return send(res, 200, listPresskit(channel));
    if (method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.product?.trim() || !body.url?.trim()) return send(res, 400, { error: "product and link are required" });
      try {
        const r = await addPresskitFile(channel, body.product.trim(), body.url.trim(), (body.license || "Manufacturer press kit (editorial/review use)").trim());
        return send(res, 200, { ok: true, ...r });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (method === "DELETE") {
      removePresskitFile(channel, String(url.searchParams.get("folder")), String(url.searchParams.get("file")));
      return send(res, 200, { ok: true });
    }
  }

  // ----- exact-model vaults (workspace/models/<brand>_<model>/): list, harvest, thumbnails -----
  // ----- The "AI engine" switch (wizard start, editor): local / api / both + video API keys -----
  if (parts[1] === "engine") {
    reloadEnv();
    if (method === "PUT") {
      const e = JSON.parse((await readBody(req)) || "{}").engine;
      if (e !== "local" && e !== "api" && e !== "both" && e !== "hybrid") return send(res, 400, { error: "engine must be local, api, both or hybrid" });
      setEngine(e);
    }
    if (method === "GET" || method === "PUT") return send(res, 200, await engineStatus());
  }

  // ----- AI model: Claude / Qwen, backup order, credit budget, auto-disable (Settings page) -----
  if (parts[1] === "llm") {
    reloadEnv();
    const state = () => ({
      settings: loadLlmSettings(),
      status: Object.fromEntries(PROVIDERS.map((p) => [p, providerStatus(p)])),
      order: providerOrder(),
      active: activeProvider(),
      presets: QWEN_PRESETS,
      keys: { claude: hasKey("ANTHROPIC_API_KEY"), qwen: !!qwenKey() },
    });
    if (method === "GET" && !parts[2]) return send(res, 200, state());
    if (method === "PUT" && !parts[2]) {
      saveLlmSettings(JSON.parse((await readBody(req)) || "{}"));
      return send(res, 200, state());
    }
    const body = method === "POST" ? JSON.parse((await readBody(req)) || "{}") : {};
    const p = body.provider as ProviderName;
    if (!(PROVIDERS as readonly string[]).includes(p)) return send(res, 400, { error: "provider must be claude or qwen" });
    if (method === "POST" && parts[2] === "enable") {
      enableProvider(p, body.resetSpent === true);
      return send(res, 200, state());
    }
    if (method === "POST" && parts[2] === "test") return send(res, 200, { ...(await testProvider(p)), state: state() });
    return send(res, 404, { error: "unknown llm route" });
  }

  if (parts[1] === "editor") {
    if (method === "POST" && !parts[2]) {
      const out = await editorApi.handle(await readBody(req, 4 * 1024 * 1024));
      if (!out) {
        res.writeHead(204);
        res.end();
        return;
      }
      return send(res, 200, out);
    }
    if (method === "GET" && parts[2] === "thumb") {
      const f = await editorApi.thumb(url.searchParams.get("project") ?? "", url.searchParams.get("clip") ?? "").catch(() => null);
      return f ? streamFile(req, res, f) : send(res, 404, { error: "no thumbnail" });
    }
    if (method === "GET" && parts[2] === "voice-sample") {
      const f = editorApi.voiceSampleFile(url.searchParams.get("project") ?? "", url.searchParams.get("name") ?? "");
      return f ? streamFile(req, res, f) : send(res, 404, { error: "no such sample" });
    }
    if (method === "GET" && parts[2] === "flow-file") {
      const f = editorApi.flowAsset(url.searchParams.get("project") ?? "", url.searchParams.get("name") ?? "");
      return f ? streamFile(req, res, f) : send(res, 404, { error: "no such file" });
    }
    if (method === "POST" && parts[2] === "flow-upload") {
      try {
        const name = await editorApi.flowUpload(url.searchParams.get("project") ?? "", req, decodeURIComponent(String(req.headers["x-filename"] ?? "")));
        return send(res, 200, { name });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (method === "GET" && parts[2] === "media") {
      let f: string | null = null;
      try {
        f = editorApi.media(url.searchParams.get("project") ?? "", url.searchParams.get("clip") ?? "");
      } catch {}
      return f ? streamFile(req, res, f) : send(res, 404, { error: "no media" });
    }
    return send(res, 404, { error: "unknown editor route" });
  }

  if (parts[1] === "vaults") {
    if (method === "GET" && !parts[2]) {
      const list = listVaults().map((v) => ({
        name: v.name,
        brand: v.manifest.brand,
        model: v.manifest.model,
        clips: v.manifest.items.filter((i) => i.kind === "video").length,
        stills: v.manifest.items.filter((i) => i.kind === "image").length,
        stats: v.manifest.stats,
        features: v.manifest.features,
        updatedAt: v.manifest.updatedAt,
        sample: v.manifest.items.filter((i) => i.kind === "image").slice(0, 6).map((i) => i.id),
      }));
      const running = [...harvestJobs.entries()].map(([name, j]) => ({ name, running: j.running, failed: j.failed, last: j.log[j.log.length - 1] ?? "" }));
      return send(res, 200, { vaults: list, jobs: running, genericStock: genericStockAllowed() });
    }
    if (method === "POST" && parts[2] === "harvest") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const brand = String(body.brand ?? "").trim().slice(0, 60);
      const model = String(body.model ?? "").trim().slice(0, 80);
      if (!brand || !model) return send(res, 400, { error: "brand and exact model are required" });
      const name = vaultName(brand, model);
      if (harvestJobs.get(name)?.running) return send(res, 409, { error: "already harvesting this model" });
      const args = ["harvest-model", "--brand", brand, "--model", model];
      if (String(body.features ?? "").trim()) args.push("--features", String(body.features).slice(0, 300));
      if (String(body.category ?? "").trim()) args.push("--category", String(body.category).slice(0, 60));
      if (body.rescore === true) args.push("--rescore");
      runHarvest(name, args);
      return send(res, 200, { ok: true, name });
    }
    const v = parts[2] ? listVaults().find((x) => x.name === parts[2]) : undefined;
    if (method === "GET" && parts[3] === "log") {
      const j = harvestJobs.get(parts[2]);
      return send(res, 200, { running: j?.running ?? false, failed: j?.failed ?? false, lines: j?.log ?? [] });
    }
    if (method === "GET" && parts[3] === "thumb" && v && parts[4]) {
      // A vault item's still: the image item itself, or the still saved with the clip.
      const key = parts[4].replace(/_[vi]$/, "");
      const still = v.manifest.items.find((i) => i.kind === "image" && i.id.replace(/_i$/, "") === key);
      const f = still ? path.join(v.dir, still.file) : null;
      return f && fs.existsSync(f) ? streamFile(req, res, f) : send(res, 404, { error: "no still for this clip" });
    }
    return send(res, 404, { error: "unknown vault route" });
  }

  if (parts[1] === "niches" && method === "GET") {
    return send(res, 200, listNiches().map((n) => ({ name: n.name, label: n.label, description: n.description ?? "", scenes: n.scenes ?? null })));
  }

  if (parts[1] === "channels" && method === "GET" && !parts[2]) {
    return send(res, 200, listChannels().map((c) => {
      const b = loadBrief(c);
      return { name: c, style: loadStyle(c), brief: b ? { name: b.name, tone: b.tone, targetMinutes: b.targetMinutes, wpm: b.wpm, words: targetWords(b) } : null };
    }));
  }

  // ----- channel profiles -----
  if (parts[1] === "channels" && method === "POST" && !parts[2]) {
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      const id = createChannel(String(body.name ?? ""), listChannels().includes(body.copyFrom) ? body.copyFrom : "default");
      return send(res, 200, { ok: true, name: id });
    } catch (err) {
      return send(res, 400, { error: String((err as Error).message ?? err) });
    }
  }
  if (parts[1] === "channels" && parts[2]) {
    const ch = parts[2];
    if (!listChannels().includes(ch)) return send(res, 404, { error: "unknown channel" });
    const what = parts[3];
    if (what === "style" && method === "PUT") return send(res, 200, updateStyle(ch, JSON.parse((await readBody(req)) || "{}")));
    if (what === "sops" && method === "GET") {
      const { listSops, loadSop } = await import("../lib/agents/sop/extract.js");
      const newest = loadSop(ch);
      return send(res, 200, listSops(ch).map((c) => loadSop(ch, c)).filter((s): s is NonNullable<typeof s> => !!s).map((s) => ({ competitor: s.competitor, videos: s.stats.videos, builtAt: s.builtAt, rehookEverySec: s.stats.rehookEverySec, hookType: s.hookFormula.type, hookSteps: s.hookFormula.steps, beats: s.beats, rules: s.rules, newest: newest?.competitor === s.competitor && newest?.builtAt === s.builtAt })));
    }
    if (what === "brief" && method === "GET") return send(res, 200, { brief: loadBrief(ch) ?? defaultBrief(ch), saved: hasBrief(ch) });
    if (what === "brief" && method === "PUT") {
      try {
        return send(res, 200, { brief: saveBrief(ch, JSON.parse((await readBody(req, 64 * 1024)) || "{}")), saved: true });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (what === "logo" && method === "POST") {
      try {
        return send(res, 200, { ok: true, path: await saveLogo(req, ch, decodeURIComponent(String(req.headers["x-filename"] ?? ""))) });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (what === "logo" && method === "DELETE") {
      removeLogo(ch);
      return send(res, 200, { ok: true });
    }
    if (what === "logo" && method === "GET") {
      const p = (loadStyle(ch).logo as { path?: string } | undefined)?.path;
      return p && fs.existsSync(p) ? streamFile(req, res, p) : send(res, 404, { error: "no logo" });
    }
    if (what === "music" && method === "GET") {
      const file = url.searchParams.get("file");
      if (!file) return send(res, 200, listMusic(ch));
      const f = trackPath(musicDir(ch), file);
      return f ? streamFile(req, res, f) : send(res, 404, { error: "no such track" });
    }
    if (what === "music" && method === "POST") {
      try {
        const name = await saveMusic(req, ch, decodeURIComponent(String(req.headers["x-filename"] ?? "")), decodeURIComponent(String(req.headers["x-note"] ?? "")));
        return send(res, 200, { ok: true, name });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (what === "music" && method === "DELETE") {
      removeMusic(ch, String(url.searchParams.get("file")));
      return send(res, 200, { ok: true });
    }
  }

  // ----- batch queue -----
  if (parts[1] === "queue") {
    if (method === "GET") return send(res, 200, await queue.list());
    const body = JSON.parse((await readBody(req)) || "{}");
    if (method === "POST" && parts[2] === "pause") return (await queue.setPaused(true), send(res, 200, { ok: true }));
    if (method === "POST" && parts[2] === "resume") return (await queue.setPaused(false), send(res, 200, { ok: true }));
    if (method === "POST" && parts[2] === "clear") return (await queue.clearFinished(), send(res, 200, { ok: true }));
    if (method === "POST" && parts[2] === "retry") return send(res, (await queue.retry(String(body.id))) ? 200 : 400, { ok: true });
    if (method === "POST" && !parts[2]) {
      const names: string[] = (body.projects ?? []).filter((n: string) => validName(n) && readProject(n)?.audio);
      if (!names.length) return send(res, 400, { error: "no uploaded projects to queue" });
      return send(res, 200, { ok: true, added: await queue.add(names, body.useLlm !== false) });
    }
    if (method === "DELETE" && parts[2]) return send(res, (await queue.remove(parts[2])) ? 200 : 400, { ok: true });
  }

  if (parts[1] === "glossary") {
    const file = path.join(paths.inputs, "glossary.txt");
    if (method === "GET") return send(res, 200, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", "text/plain; charset=utf-8");
    if (method === "PUT") {
      fs.writeFileSync(file, await readBody(req));
      return send(res, 200, { ok: true });
    }
  }

  // AI image style: a reference picture (at most 15 MB) into channels/<ch>/ai_style/.
  if (parts[1] === "aistyle" && parts[3] === "ref" && method === "POST") {
    const ch = parts[2] ?? "";
    if (!listChannels().includes(ch)) return send(res, 400, { error: "unknown channel" });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 15 * 1024 * 1024) return send(res, 413, { error: "The picture is larger than 15 MB." });
      chunks.push(c as Buffer);
    }
    try {
      return send(res, 200, { file: saveRef(ch, decodeURIComponent(String(req.headers["x-filename"] ?? "ref.png")), Buffer.concat(chunks)) });
    } catch (err) {
      return send(res, 400, { error: (err as Error).message });
    }
  }

  // Shorts from a long video: the creator's video, streamed to workspace/<project>/clips/.
  if (parts[1] === "make" && parts[3] === "longvideo" && method === "POST") {
    const name = parts[2];
    if (!validName(name) || !readClipsInput(name)) return send(res, 404, { error: "create the Shorts project first" });
    const fname = decodeURIComponent(String(req.headers["x-filename"] ?? "video.mp4"));
    const ext = path.extname(fname).toLowerCase();
    if (!LONG_VIDEO_EXT.has(ext)) return send(res, 400, { error: "the video must be mp4, mov, mkv, webm or m4v" });
    fs.mkdirSync(clipsDir(name), { recursive: true });
    // One long video per project: an earlier upload is replaced.
    for (const f of fs.readdirSync(clipsDir(name))) if (/^source\./.test(f)) fs.rmSync(path.join(clipsDir(name), f), { force: true });
    const dest = path.join(clipsDir(name), `source${ext}`);
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on("finish", () => resolve());
      ws.on("error", reject);
    });
    setClipsSource(name, path.basename(dest));
    return send(res, 200, { ok: true, bytes: fs.statSync(dest).size });
  }

  // Tutorial: the creator's screen recording, streamed to workspace/<project>/tutorial/.
  if (parts[1] === "make" && parts[3] === "recording" && method === "POST") {
    const name = parts[2];
    if (!validName(name) || !fs.existsSync(path.join(projDir(name), "tutorial.json"))) return send(res, 404, { error: "create the tutorial first" });
    const fname = decodeURIComponent(String(req.headers["x-filename"] ?? "recording.mp4"));
    const ext = path.extname(fname).toLowerCase();
    if (!VIDEO_EXT.has(ext)) return send(res, 400, { error: "the recording must be mp4, mov, webm or mkv" });
    fs.mkdirSync(tutorialDir(name), { recursive: true });
    const dest = path.join(tutorialDir(name), `recording${ext}`);
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on("finish", () => resolve());
      ws.on("error", reject);
    });
    setRecording(name, path.basename(dest));
    return send(res, 200, { ok: true, bytes: fs.statSync(dest).size });
  }

  {
    const r = (await researchRoute(parts, method, () => readBody(req))) ?? (await pipelineRoute(parts, method, () => readBody(req))) ?? (await wizardRoute(parts, method, () => readBody(req, 8 * 1024 * 1024))) ?? (await makeRoute(parts, method, () => readBody(req, 1024 * 1024))) ?? (await aistyleRoute(parts, method, () => readBody(req, 64 * 1024), url.searchParams));
    const file = r && "file" in r ? (r as { file?: string }).file : undefined;
    if (file) return streamFile(req, res, file);
    if (r) return send(res, r.status, r.body);
  }

  if (parts[1] !== "projects") return send(res, 404, { error: "unknown route" });

  if (parts.length === 2 && method === "GET") {
    const names = fs.existsSync(paths.workspace)
      ? fs.readdirSync(paths.workspace).filter((n) => validName(n) && fs.existsSync(path.join(projDir(n), "project.json")))
      : [];
    await refreshJobs(names);
    const list = names.map(summary).sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    return send(res, 200, list);
  }

  const name = parts[2];
  if (!name || !validName(name)) return send(res, 400, { error: "project name: letters, digits, - and _ only" });
  const action = parts[3];
  await refreshJobs([name]);

  if (!action && method === "GET") {
    if (!readProject(name)) return send(res, 404, { error: "no such project" });
    return send(res, 200, { ...summary(name), project: readProject(name) });
  }

  if (action === "audio" && method === "POST") {
    const fname = String(req.headers["x-filename"] ?? "voiceover.mp3");
    const ext = path.extname(fname).toLowerCase();
    if (!AUDIO_EXT.has(ext)) return send(res, 400, { error: "audio must be mp3, wav or m4a" });
    if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
    fs.mkdirSync(projDir(name), { recursive: true });
    const dest = path.join(projDir(name), `voiceover${ext}`);
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on("finish", () => resolve());
      ws.on("error", reject);
    });
    // New audio invalidates everything downstream.
    for (const f of [...Object.values(STEP_OUTPUT), "sections.json", "plan_report.json", "segments.json", "assets_report.json", "license_log.csv", "plan_edits.json"]) {
      fs.rmSync(path.join(projDir(name), f), { force: true });
    }
    writeProject(name, { name, audio: dest, originalFilename: fname, createdAt: readProject(name)?.createdAt ?? new Date().toISOString() });
    return send(res, 200, { ok: true, bytes: fs.statSync(dest).size });
  }

  if (action === "audio" && method === "GET") {
    const p = readProject(name);
    if (!p?.audio || !fs.existsSync(String(p.audio))) return send(res, 404, { error: "no audio" });
    return streamFile(req, res, String(p.audio));
  }

  if (action === "script") {
    const file = path.join(projDir(name), "script.txt");
    if (method === "GET") return send(res, 200, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", "text/plain; charset=utf-8");
    if (method === "PUT") {
      const text = (await readBody(req, 8 * 1024 * 1024)).trim();
      const secFile = path.join(projDir(name), "script_sections.json");
      if (/^<(!doctype|html)/i.test(text)) {
        // Script HTML page: spoken text + beats as sections + product hints + glossary names.
        const imported = parseScriptHtml(text);
        fs.writeFileSync(file, scriptText(imported));
        fs.writeFileSync(secFile, JSON.stringify(scriptSections(imported), null, 1));
        fs.writeFileSync(path.join(projDir(name), "products.json"), JSON.stringify(imported.products, null, 1));
        const gfile = path.join(paths.inputs, "glossary.txt");
        const have = fs.existsSync(gfile) ? fs.readFileSync(gfile, "utf8") : "";
        const add = imported.products.map((p) => p.name).filter((n) => !have.split(/\r?\n/).includes(n));
        if (add.length) fs.appendFileSync(gfile, (have.endsWith("\n") || !have ? "" : "\n") + add.join("\n") + "\n");
        return send(res, 200, { ok: true, hasScript: true, imported: { title: imported.title, beats: imported.beats.length, products: imported.products.length, glossaryAdded: add.length } });
      }
      fs.rmSync(secFile, { force: true });
      if (text) fs.writeFileSync(file, text + "\n");
      else fs.rmSync(file, { force: true });
      return send(res, 200, { ok: true, hasScript: !!text });
    }
  }

  if (action === "settings" && method === "PUT") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (body.channel && listChannels().includes(body.channel)) writeProject(name, { channel: body.channel });
    if (body.niche && listNiches().some((n) => n.name === body.niche)) writeProject(name, { niche: body.niche });
    if ((FOOTAGE_MODES as readonly string[]).includes(body.footage)) writeProject(name, { footage: body.footage });
    if (typeof body.planGate === "boolean") writeProject(name, { planGate: body.planGate });
    if (body.music !== undefined) writeProject(name, { music: parseMusicChoice(body.music) });
    // Creative brief from the home prompt ("dark atmosphere, archival footage..."): steers the footage agent.
    if (typeof body.brief === "string") writeProject(name, { brief: body.brief.trim().slice(0, 2000) });
    return send(res, 200, { ok: true });
  }

  // ----- plan review: estimate, edit a scene's searches, approve -----
  if (action === "plan") {
    const dir = projDir(name);
    const p = (readProject(name) ?? {}) as ProjectLike;
    if (!fs.existsSync(path.join(dir, "scenes.json"))) return send(res, 400, { error: "no plan yet - run the pipeline first" });
    if (parts[4] === "estimate" && method === "GET") return send(res, 200, { ...planEstimate(dir, p), gate: gateState(dir, p) });
    if (parts[4] === "scene" && parts[5] !== undefined && method === "PUT") {
      if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        return send(res, 200, { ok: true, scene: savePlanEdit(dir, Number(parts[5]), cleanQueries(body.queries)) });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (parts[4] === "approve" && method === "POST") {
      if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
      writeProject(name, { planApproval: approval(dir) });
      const body = JSON.parse((await readBody(req)) || "{}");
      void runJob(name, [...STEPS.slice(STEPS.indexOf("assets"))], false, body.useLlm !== false);
      return send(res, 200, { ok: true });
    }
  }

  // Simple UI: one button. Script and/or voiceover; no voiceover -> default Windows TTS voice.
  if (action === "go" && method === "POST") {
    if (jobs.get(name)?.running) return send(res, 409, { error: "already running" });
    const body = JSON.parse((await readBody(req)) || "{}");
    const st = loadAppSettings();
    const p00 = readProject(name);
    const channel = typeof body.channel === "string" && listChannels().includes(body.channel) ? body.channel : String(p00?.channel ?? "auto");
    const chNiche = String(loadStyle(channel).niche ?? "");
    const dir = projDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const scriptFile = path.join(dir, "script.txt");
    const script = typeof body.script === "string" ? body.script.trim() : "";
    if (script) fs.writeFileSync(scriptFile, script + "\n");
    else fs.rmSync(scriptFile, { force: true });
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : String(p00?.title ?? "");
    const p0 = readProject(name);
    const hasAudio = !!p0?.audio && fs.existsSync(String(p0.audio)) && !(p0.voiceMode === "tts" && script);
    if (!hasAudio && !script) return send(res, 400, { error: "Paste a script or upload a voiceover" });
    // Mode B needs a real TTS provider; never fake the narration.
    if (!hasAudio) {
      const t = ttsStatus();
      if (!t.configured) return send(res, 400, { error: `Mode B (script only) needs TTS: ${t.detail}` });
    }
    // Auto channel (or niche=auto): detect category/hints/pacing from script and write project niche.json.
    const wantsAuto = channel === "auto" || chNiche === "auto" || body.niche === "auto";
    let nicheName: string;
    let uiNiche: string;
    let detectMeta: { source?: string; category?: string; targetShotSec?: number } = {};
    if (wantsAuto) {
      const scriptForDetect = script || (fs.existsSync(scriptFile) ? fs.readFileSync(scriptFile, "utf8") : "");
      const { niche, meta } = await detectAndWriteNiche(dir, { title, script: scriptForDetect }, console.log);
      nicheName = niche.name || "auto";
      uiNiche = "auto";
      detectMeta = meta;
    } else {
      const niche: UiNiche = body.niche === "tech" || body.niche === "guns" ? body.niche : chNiche === "tech" ? "tech" : chNiche === "guns" ? "guns" : st.defaultNiche;
      nicheName = buildUiNiche(niche, st);
      uiNiche = niche;
    }
    writeProject(name, {
      name,
      channel,
      title,
      review: body.review === true,
      reviewDone: false,
      niche: nicheName,
      uiNiche,
      detectedCategory: detectMeta.category ?? null,
      nicheSource: detectMeta.source ?? null,
      targetShotSec: detectMeta.targetShotSec ?? null,
      planGate: false,
      createdAt: p0?.createdAt ?? new Date().toISOString(),
      voiceMode: hasAudio ? (script ? "both" : "voice") : "tts",
      inputMode: resolveInputMode({ hasUploadedAudio: hasAudio, hasScript: !!script }),
      ...(body.music !== undefined ? { music: parseMusicChoice(body.music) } : {}),
    });
    if (channel !== "auto") updateStyle(channel, { captions: { enabled: st.captions } });
    else updateStyle(channel, { captions: { enabled: st.captions }, pacing: { targetShotSec: detectMeta.targetShotSec ?? 2.3 } });
    if (!hasAudio) for (const f of Object.values(STEP_OUTPUT)) fs.rmSync(path.join(dir, f), { force: true });
    void runJob(name, hasAudio ? [...STEPS] : ["tts", ...STEPS], !!body.force, true, false);
    return send(res, 200, { ok: true, niche: nicheName, detectedCategory: detectMeta.category ?? null, nicheSource: detectMeta.source ?? null });
  }

  // Stop: ends the running step; finished steps keep their files, so Continue resumes from it.
  if (action === "stop" && method === "POST") {
    if (!jobs.get(name)?.running) return send(res, 400, { error: "nothing is running for this project" });
    const child = children.get(name);
    if (!child && dispatcher.kind === "bullmq") return send(res, 409, { error: "this project runs in a separate worker; stop that worker window instead" });
    stopAsked.add(name);
    if (child) killTree(child);
    return send(res, 200, { ok: true });
  }

  if (action === "continue" && method === "POST") {
    if (jobs.get(name)?.running) return send(res, 409, { error: "already running" });
    if (!readProject(name)?.audio) return send(res, 400, { error: "upload audio first" });
    const from = continueFrom(name);
    if (!from) return send(res, 400, { error: "every step is already done" });
    const steps = STEPS.slice(STEPS.indexOf(from));
    void runJob(name, [...steps], false, true);
    return send(res, 200, { ok: true, from, steps });
  }

  // Delete a project: its workspace folder and rendered video. Not while it runs.
  if (!action && method === "DELETE") {
    if (jobs.get(name)?.running) return send(res, 409, { error: "stop the project first" });
    if (!fs.existsSync(projDir(name))) return send(res, 404, { error: "no such project" });
    fs.rmSync(projDir(name), { recursive: true, force: true });
    for (const f of [`${name}.mp4`]) fs.rmSync(path.join(paths.output, f), { force: true });
    jobs.delete(name);
    persist(name, () => store.clearLog(name));
    return send(res, 200, { ok: true });
  }

  if (action === "run" && method === "POST") {
    if (!readProject(name)?.audio) return send(res, 400, { error: "upload audio first" });
    if (jobs.get(name)?.running) return send(res, 409, { error: "already running" });
    const body = JSON.parse((await readBody(req)) || "{}");
    const from: Step = STEPS.includes(body.from) ? body.from : "transcribe";
    const only: boolean = !!body.only;
    const steps = only ? [from] : STEPS.slice(STEPS.indexOf(from));
    void runJob(name, [...steps], !!body.force, body.useLlm !== false);
    return send(res, 200, { ok: true, steps });
  }

  if (action === "log" && method === "GET") {
    const job = jobs.get(name);
    const since = Number(url.searchParams.get("since") ?? 0);
    // Redis mode: the shared log (lines written by any worker, also before a restart).
    const shared = store.kind === "redis" ? await store.logSince(name, since).catch(() => null) : null;
    return send(res, 200, {
      running: job?.running ?? false,
      step: job?.step ?? null,
      failedStep: job?.failedStep ?? null,
      awaitingApproval: job?.awaitingApproval ?? false,
      awaitingReview: (job?.awaitingReview ?? false) && !job?.running,
      planGate: gateState(projDir(name), (readProject(name) ?? {}) as ProjectLike),
      total: shared ? shared.total : job?.log.length ?? 0,
      lines: shared ? shared.lines : job ? job.log.slice(since) : [],
      steps: stepStatus(name),
    });
  }

  if (action === "media" && method === "GET") {
    // Streams a scene's asset (or its thumbnail). Paths come from our own assets.json.
    const assetsFile = path.join(projDir(name), "assets.json");
    if (!fs.existsSync(assetsFile)) return send(res, 404, { error: "no assets yet" });
    const a = JSON.parse(fs.readFileSync(assetsFile, "utf8"))[parts[4]];
    const file = a && (url.searchParams.has("thumb") ? a.thumb : a.path);
    if (!file || !fs.existsSync(file)) return send(res, 404, { error: "missing file" });
    return streamFile(req, res, file);
  }

  if (action === "video" && method === "GET") {
    const file = path.join(paths.output, `${name}.mp4`);
    if (!fs.existsSync(file)) return send(res, 404, { error: "not rendered yet" });
    if (url.searchParams.has("download")) {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": fs.statSync(file).size, "Content-Disposition": `attachment; filename="${name}.mp4"` });
      fs.createReadStream(file).pipe(res);
      return;
    }
    return streamFile(req, res, file);
  }

  if (action === "license" && method === "GET") {
    const file = path.join(projDir(name), "license_log.csv");
    if (!fs.existsSync(file)) return send(res, 404, { error: "not generated yet" });
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}_license_log.csv"` });
    res.end(fs.readFileSync(file));
    return;
  }

  // ----- scene review before render (simple UI) -----
  // ----- studio: live storyboard while the video cooks -----
  if (action === "storyboard" && method === "GET") {
    const dir = projDir(name);
    if (parts[4] === "thumb") {
      const f = await storyThumb(dir, Number(url.searchParams.get("scene")));
      return f ? streamFile(req, res, f) : send(res, 404, { error: "no thumbnail yet" });
    }
    const job = jobs.get(name);
    return send(res, 200, storyboard(name, dir, job?.startedAt ?? Date.now() - 6 * 3600_000));
  }

  if (action === "review") {
    const dir = projDir(name);
    if (!fs.existsSync(path.join(dir, "timeline.json"))) return send(res, 404, { error: "no timeline yet" });
    if (method === "GET" && !parts[4]) {
      const p = readProject(name) ?? {};
      return send(res, 200, { awaiting: !!jobs.get(name)?.awaitingReview && !jobs.get(name)?.running, review: p.review === true, reviewDone: p.reviewDone === true, footage: footageSummary(dir), scenes: listReview(dir) });
    }
    if (method === "GET" && parts[4] === "thumb") {
      const alt = url.searchParams.get("alt");
      const f = alt ? await reviewThumb(dir, { alt }) : await reviewThumb(dir, { scene: Number(url.searchParams.get("scene")), shot: Number(url.searchParams.get("shot") ?? 0) });
      return f ? streamFile(req, res, f) : send(res, 404, { error: "no thumbnail" });
    }
    if (method === "POST" && parts[4] === "swap") {
      if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        swapShot(dir, Number(body.scene), Number(body.shot ?? 0), String(body.alt ?? ""));
        return send(res, 200, { ok: true, scene: listReview(dir).find((s) => s.id === Number(body.scene)) });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (method === "POST" && parts[4] === "render") {
      if (jobs.get(name)?.running) return send(res, 409, { error: "already running" });
      writeProject(name, { reviewDone: true });
      void runJob(name, ["render", "qa"], false, true, false);
      return send(res, 200, { ok: true });
    }
  }

  // ----- publish pack (title, description, thumbnails) -----
  if (action === "publish" && method === "GET") {
    const pub = path.join(projDir(name), "publish");
    if (parts[4]) {
      const f = path.join(pub, path.basename(parts[4]));
      if (!/^[A-Za-z0-9_.-]+\.(jpg|txt|json)$/.test(parts[4]) || !fs.existsSync(f)) return send(res, 404, { error: "missing file" });
      return streamFile(req, res, f);
    }
    const f = path.join(pub, "publish.json");
    return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f)) : send(res, 404, { error: "not generated yet" });
  }

  // ----- review page: swap a scene's footage, fix a caption word -----

  if (action === "candidates" && parts[4] !== undefined) {
    const sceneId = String(Number(parts[4]));
    const all = loadCandidates(projDir(name));
    if (method === "GET" && !parts[5]) return send(res, 200, all[sceneId] ?? []);
    if (method === "POST" && parts[5] === "search") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!String(body.query ?? "").trim()) return send(res, 400, { error: "type something to search for" });
      const p = readProject(name) ?? {};
      const niche = loadProjectNiche(p as ProjectLike, loadStyle(String(p.channel ?? "default")));
      const found = await searchAlternatives(String(body.query).trim(), niche);
      // Keep searched options so a later swap request can find them by id.
      const existing = all[sceneId] ?? [];
      all[sceneId] = [...existing, ...found.filter((c) => !existing.some((e) => e.id === c.id))];
      saveCandidates(projDir(name), all);
      return send(res, 200, found);
    }
  }

  if (action === "swap" && parts[4] !== undefined && method === "POST") {
    if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
    const sceneId = Number(parts[4]);
    const body = JSON.parse((await readBody(req)) || "{}");
    const cand = (loadCandidates(projDir(name))[String(sceneId)] ?? []).find((c) => c.id === body.candId);
    if (!cand) return send(res, 404, { error: "unknown option for this scene" });
    try {
      const asset = await applyCandidate(projDir(name), sceneId, cand);
      // Only the swapped scene's segment re-renders; every other segment comes from the cache.
      void runJob(name, ["timeline", "render"], false, false);
      return send(res, 200, { ok: true, asset });
    } catch (err) {
      return send(res, 400, { error: String((err as Error).message ?? err) });
    }
  }

  if (action === "words" && parts[4] !== undefined && method === "PUT") {
    const index = Number(parts[4]);
    const file = path.join(projDir(name), "aligned.json");
    if (!fs.existsSync(file)) return send(res, 404, { error: "run Align first" });
    const aligned = JSON.parse(fs.readFileSync(file, "utf8"));
    const w = aligned.words?.[index];
    const body = JSON.parse((await readBody(req)) || "{}");
    const to = String(body.word ?? "").trim();
    if (!w || !to || /\s/.test(to)) return send(res, 400, { error: "one word, no spaces" });
    saveWordEdit(projDir(name), w.start, w.word, to);
    w.word = to;
    w.edited = true;
    for (const st of aligned.sentences ?? []) {
      if (index >= st.firstWord && index <= st.lastWord) st.text = aligned.words.slice(st.firstWord, st.lastWord + 1).map((x: { word: string }) => x.word).join(" ");
    }
    fs.writeFileSync(file, JSON.stringify(aligned, null, 1));
    return send(res, 200, { ok: true, word: to });
  }

  // ----- input modes (A voiceover / B script + TTS / C script + voiceover) -----
  if (action === "inputs" && method === "GET") {
    const mode = inputModeOf(name);
    const p = readProject(name) ?? {};
    return send(res, 200, {
      mode,
      label: mode ? INPUT_MODE_LABELS[mode] : "no voiceover or script yet",
      hasAudio: !!p.audio && fs.existsSync(String(p.audio)),
      hasScript: fs.existsSync(path.join(projDir(name), "script.txt")),
      tts: ttsStatus(),
    });
  }

  // Mode B: narrate the saved script with the configured TTS provider, then run the pipeline.
  if (action === "tts" && method === "POST") {
    if (jobs.get(name)?.running) return send(res, 409, { error: "already running" });
    if (!fs.existsSync(path.join(projDir(name), "script.txt"))) return send(res, 400, { error: "save a script first (Mode B reads the script)" });
    const t = ttsStatus();
    if (!t.configured) return send(res, 400, { error: t.detail });
    writeProject(name, { inputMode: "B", createdAt: readProject(name)?.createdAt ?? new Date().toISOString() });
    const body = JSON.parse((await readBody(req)) || "{}");
    void runJob(name, ["tts", ...STEPS], !!body.force, body.useLlm !== false);
    return send(res, 200, { ok: true, provider: t.provider });
  }

  // ----- Mode C discrepancies: list, resolve (kept in project.json), apply by re-aligning -----
  if (action === "discrepancies") {
    const dir = projDir(name);
    const file = path.join(dir, "discrepancies.json");
    if (method === "GET") {
      const items = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).items ?? [] : [];
      const chosen = loadResolutions(dir);
      return send(res, 200, { resolutions: RESOLUTIONS, items: items.map((d: { id: string }) => ({ ...d, resolution: chosen[d.id] ?? null })) });
    }
    if (method === "PUT" && parts[4]) {
      if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
      const body = JSON.parse((await readBody(req)) || "{}");
      const r = body.resolution === null ? null : String(body.resolution);
      if (r !== null && !(RESOLUTIONS as readonly string[]).includes(r)) return send(res, 400, { error: `resolution must be one of ${RESOLUTIONS.join(", ")}` });
      saveResolution(dir, parts[4], r as Resolution | null);
      return send(res, 200, { ok: true });
    }
    if (method === "POST" && parts[4] === "apply") {
      if (jobs.get(name)?.running) return send(res, 409, { error: "already running" });
      // Re-align with the choices; later steps reuse their caches where nothing changed.
      void runJob(name, [...STEPS.slice(STEPS.indexOf("align"))], false, true);
      return send(res, 200, { ok: true });
    }
  }

  // ----- product research: identity, Amazon URL / ASIN (affiliate kept apart), spec pages -----
  if (action === "products") {
    const dir = projDir(name);
    if (method === "GET") {
      const scenesFile = path.join(dir, "scenes.json");
      const names = fs.existsSync(scenesFile)
        ? [...new Set((JSON.parse(fs.readFileSync(scenesFile, "utf8")) as { product_name?: string }[]).map((s) => s.product_name).filter((x): x is string => !!x))]
        : [];
      return send(res, 200, names.length ? ensureProductRecords(dir, names) : readResearch(dir));
    }
    if (method === "PUT") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!String(body.name ?? "").trim()) return send(res, 400, { error: "product name required" });
      try {
        return send(res, 200, updateProductRecord(dir, String(body.name), body));
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
  }

  // ----- per-scene: single-scene rerender, manual clip replacement, human model verification -----
  if (action === "scenes" && parts[4] !== undefined && parts[5]) {
    const dir = projDir(name);
    const sceneId = Number(parts[4]);
    if (!Number.isInteger(sceneId) || sceneId < 0) return send(res, 400, { error: "bad scene id" });
    if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
    const rerender = () => runJob(name, ["timeline", "render"], false, false, false, { render: ["--scene", String(sceneId)] });
    if (parts[5] === "rerender" && method === "POST") {
      if (!fs.existsSync(path.join(dir, "timeline.json"))) return send(res, 400, { error: "no timeline yet" });
      void rerender();
      return send(res, 200, { ok: true });
    }
    if (parts[5] === "replace" && method === "POST") {
      const fname = path.basename(String(req.headers["x-filename"] ?? ""));
      const note = decodeURIComponent(String(req.headers["x-source-note"] ?? "")).trim();
      const ext = path.extname(fname).toLowerCase();
      if (!MANUAL_EXT.has(ext)) return send(res, 400, { error: "use mp4, mov, m4v, webm, mkv, jpg, png or webp" });
      if (!note) return send(res, 400, { error: "say where the file comes from (source / licence note)" });
      const manualDir = path.join(dir, "manual");
      fs.mkdirSync(manualDir, { recursive: true });
      const dest = path.join(manualDir, `scene_${sceneId}_${Date.now().toString(36)}${ext}`);
      await new Promise<void>((resolve, reject) => {
        const ws = fs.createWriteStream(dest);
        req.pipe(ws);
        ws.on("finish", () => resolve());
        ws.on("error", reject);
      });
      try {
        const asset = await applyManualFile(dir, sceneId, dest, note);
        void rerender();
        return send(res, 200, { ok: true, asset });
      } catch (err) {
        fs.rmSync(dest, { force: true });
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (parts[5] === "verify" && method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      const verdict = body.verdict === "match" || body.verdict === "conflict" ? body.verdict : null;
      const assetsFile = path.join(dir, "assets.json");
      const a = fs.existsSync(assetsFile) ? JSON.parse(fs.readFileSync(assetsFile, "utf8"))[String(sceneId)] : null;
      if (!a?.path) return send(res, 404, { error: "scene has no asset yet" });
      saveVerification(dir, a.path, verdict);
      return send(res, 200, { ok: true, verifications: readVerifications(dir) });
    }
  }

  // Pre-render gate (no video needed): files, reuse, product models, licences, discrepancies.
  if (action === "preflight" && method === "POST") {
    if (jobs.get(name)?.running) return send(res, 409, { error: "already running" });
    void runJob(name, ["qa"], false, false, false, { qa: ["--preflight"] });
    return send(res, 200, { ok: true });
  }

  // Human review gate: approval is tied to the exact rendered file (its modification time).
  if (action === "approve") {
    const file = path.join(projDir(name), "approval.json");
    const qaFile = path.join(projDir(name), "qa_report.json");
    if (method === "POST") {
      if (!fs.existsSync(qaFile)) return send(res, 400, { error: "run QA first" });
      const qaRep = JSON.parse(fs.readFileSync(qaFile, "utf8"));
      if (qaRep.summary.fail > 0) return send(res, 400, { error: "QA has failures - fix them (or re-run QA) before approving" });
      const video = path.join(paths.output, `${name}.mp4`);
      const body = JSON.parse((await readBody(req)) || "{}");
      const approval = { approvedAt: new Date().toISOString(), note: String(body.note ?? "").slice(0, 500), videoMtime: fs.statSync(video).mtimeMs };
      fs.writeFileSync(file, JSON.stringify(approval, null, 2));
      return send(res, 200, { ok: true, ...approval });
    }
    if (method === "DELETE") {
      fs.rmSync(file, { force: true });
      return send(res, 200, { ok: true });
    }
    if (method === "GET") {
      if (!fs.existsSync(file)) return send(res, 200, { approved: false });
      const ap = JSON.parse(fs.readFileSync(file, "utf8"));
      const video = path.join(paths.output, `${name}.mp4`);
      // A re-render after approval invalidates it: the reviewer has not seen the new file.
      const stale = !fs.existsSync(video) || Math.abs(fs.statSync(video).mtimeMs - ap.videoMtime) > 1;
      return send(res, 200, { approved: !stale, stale, ...ap });
    }
  }

  if (action === "file" && method === "GET") {
    const f = parts[4];
    if (!READABLE.has(f)) return send(res, 400, { error: "not readable" });
    const file = path.join(projDir(name), f);
    if (!fs.existsSync(file)) return send(res, 404, { error: "not generated yet" });
    return send(res, 200, fs.readFileSync(file));
  }

  return send(res, 404, { error: "unknown route" });
}

/** Picks local or BullMQ dispatch (REDIS_URL) and starts this process's stage workers. */
async function initPipeline(stages: Stage[]): Promise<void> {
  dispatcher = createDispatcher();
  if (dispatcher.kind === "bullmq") store = new RedisJobStore(redis()!);
  await dispatcher.startWorkers(stages, stageRunner, onPipelineDone);
  if (dispatcher.kind === "bullmq") console.log(`[queue] BullMQ on ${process.env.REDIS_URL?.replace(/\/\/[^@]*@/, "//***@")}: ${stages.length ? `working on ${stages.join(", ")}` : "no workers in this process (QUEUE_WORKERS=none)"}`);
}

/** Batch items run by BullMQ: record the outcome (any worker, any machine). */
async function onPipelineDone(p: PipelineJob, r: StageResult): Promise<void> {
  if (!p.batchId || dispatcher.kind !== "bullmq") return;
  const qaFile = path.join(projDir(p.project), "qa_report.json");
  const qa = !r.failedStep && fs.existsSync(qaFile) ? JSON.parse(fs.readFileSync(qaFile, "utf8")).summary : undefined;
  await RedisBatchQueue.update(redis()!, p.batchId, {
    status: r.failedStep ? "failed" : "done",
    finishedAt: new Date().toISOString(),
    ...(r.failedStep ? { error: `stopped at step: ${r.failedStep}` } : {}),
    ...(qa ? { qa } : {}),
  });
}

/**
 * After a restart: a run marked running in Redis that has no waiting or active stage job anywhere
 * was cut off (e.g. the server died before the job was queued). It is marked stopped so the
 * project is not blocked forever; finished steps are cached, so Go continues where it stopped.
 */
async function reconcileJobs(): Promise<void> {
  const names = fs.existsSync(paths.workspace) ? fs.readdirSync(paths.workspace).filter(validName) : [];
  await refreshJobs(names);
  const active = await dispatcher.activeProjects();
  for (const n of names) {
    const j = jobs.get(n);
    if (!j?.running || active.has(n) || localActive.has(n)) continue;
    Object.assign(j, { running: false, failedStep: j.step ?? j.failedStep ?? null, step: null, finishedAt: Date.now() });
    logLine(n, "!!! interrupted: no queued or running job was left after a restart. Press Go to continue (finished steps are cached).");
    flushLog(n);
    saveJob(n);
  }
}

/** `clipforge worker`: stage workers only (no web server), for extra machines sharing the workspace. */
export async function runWorkers(stages: Stage[]): Promise<void> {
  if (!redis()) throw new Error("clipforge worker needs REDIS_URL (the queues live in Redis)");
  fs.mkdirSync(paths.workspace, { recursive: true });
  await initPipeline(stages);
  await new Promise(() => {});
}

export async function serve(port: number): Promise<void> {
  fs.mkdirSync(paths.workspace, { recursive: true });
  await initPipeline(workerStages());
  if (dispatcher.kind === "bullmq") {
    queue = new RedisBatchQueue(redis()!, dispatcher, () => [...STEPS]);
    await reconcileJobs();
  } else {
    queue = new BatchQueue(
      async (project, useLlm) => {
        // Batch runs unattended: no plan approval stop.
        await runJob(project, [...STEPS], false, useLlm, false);
        return { failedStep: jobs.get(project)?.failedStep ?? null };
      },
      () => [...jobs.values()].some((j) => j.running),
    );
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: String(err?.message ?? err) });
    });
  });
  // HOST=0.0.0.0 inside a container (the published port is the boundary). The app has no login:
  // never expose it to the internet without a reverse proxy that adds one.
  const host = env("HOST", "127.0.0.1");
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  console.log(`ClipForge web app: http://localhost:${port}${host !== "127.0.0.1" ? ` (listening on ${host})` : ""}  (Ctrl+C to stop)`);
  await new Promise(() => {});
}
