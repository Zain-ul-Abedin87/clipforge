import { AsyncLocalStorage } from "node:async_hooks";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { paths } from "../paths.js";
import type { Stage } from "../agents/llm/settings.js";

/**
 * Per-stage model loader for local Ollama models (hardware: 8 GB VRAM, one model at a time).
 *
 *  - Before a stage's model is used, every OTHER loaded model is unloaded (Ollama keep_alive 0), so a
 *    text model and the vision model are never in VRAM together (that split a 7B model ~36% to the CPU).
 *  - VRAM guard: free VRAM is read with nvidia-smi before loading; below the minimum the loader waits
 *    for the unloads to land, then logs a warning (it never blocks the pipeline).
 *  - A model the user has not pulled falls back to the stage's fallback model (logged).
 *  - Every load / request is logged with model, stage, load time and GPU time; totals per stage are
 *    written to cache/gpu_time.json (the UI shows them as "GPU time" cost).
 *
 * Disabled in unit tests (NODE_TEST_CONTEXT) and with MODEL_LOADER=off; tests drive the class directly.
 */

export interface LoaderDeps {
  /** Ollama base URL without /v1 (http://localhost:11434). */
  baseUrl: () => string;
  fetch: typeof fetch;
  /** Free / total VRAM in MB, or null when there is no NVIDIA GPU / nvidia-smi. */
  vram: () => Promise<{ freeMb: number; totalMb: number } | null>;
  log: (m: string) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Where per-stage GPU time totals are written (null = not written). */
  statsFile: string | null;
}

export interface StageTime {
  stage: string;
  model: string;
  requests: number;
  loads: number;
  loadMs: number;
  gpuMs: number;
  cpuMs: number;
}

/** nvidia-smi free/total VRAM (MB) of the first GPU. */
export function nvidiaSmiVram(): Promise<{ freeMb: number; totalMb: number } | null> {
  return new Promise((resolve) => {
    execFile("nvidia-smi", ["--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"], { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(parseNvidiaSmi(String(stdout)));
    });
  });
}

export function parseNvidiaSmi(out: string): { freeMb: number; totalMb: number } | null {
  const line = out.split(/\r?\n/).find((l) => /\d/.test(l));
  if (!line) return null;
  const [free, total] = line.split(",").map((x) => Number(x.trim()));
  return Number.isFinite(free) && Number.isFinite(total) ? { freeMb: free, totalMb: total } : null;
}

/**
 * Rough VRAM a model needs (MB) from its name: Q4 weights + KV cache for an 8K context. Used only by
 * the guard's warning; Ollama itself decides the real split.
 */
export function estimateVramMb(model: string, numCtx = 8192): number {
  const m = /(\d+(?:\.\d+)?)b\b/i.exec(model);
  const b = m ? Number(m[1]) : 7;
  const weights = b * 620; // ~Q4_K_M
  const kv = (numCtx / 8192) * (b >= 7 ? 1100 : 600);
  return Math.round(weights + kv + 400);
}

const stageStore = new AsyncLocalStorage<Stage>();
let defaultStage: Stage | undefined;

/** Stage of the running pipeline command (cli preAction), used when no withStage() is active. */
export const setDefaultStage = (s: Stage | undefined) => (defaultStage = s);
export const currentStage = (): Stage | undefined => stageStore.getStore() ?? defaultStage;
/** Runs `fn` with `stage` as the current stage (its local model + context, logged per stage). */
export const withStage = <T>(stage: Stage, fn: () => Promise<T>): Promise<T> => stageStore.run(stage, fn);

/** CLI command -> stage (commands that never call a local LLM map to undefined). */
export function stageForCommand(cmd: string): Stage | undefined {
  const map: Record<string, Stage> = { plan: "plan", assets: "assets", visuals: "assets", timeline: "labels", qa: "qa", research: "niche", titles: "titles", script: "script", shorts: "titles" };
  return map[cmd];
}

export class ModelLoader {
  /** Model this loader last made resident, and for which stage. */
  current: { model: string; stage: string } | null = null;
  private installed: Set<string> | null = null;
  readonly times = new Map<string, StageTime>();

  constructor(private deps: LoaderDeps) {}

  private async api(pathname: string, body?: unknown): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.deps.fetch(`${this.deps.baseUrl()}${pathname}`, body === undefined ? { signal: AbortSignal.timeout(5000) } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
      return res.ok ? ((await res.json().catch(() => ({}))) as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  /** Names of the models Ollama has in memory now (/api/ps). */
  async loaded(): Promise<string[]> {
    const r = await this.api("/api/ps");
    return ((r?.models as { name?: string; model?: string }[] | undefined) ?? []).map((m) => String(m.name ?? m.model ?? "")).filter(Boolean);
  }

  /** Unloads one model now (keep_alive 0). Embedding models unload through /api/embed. */
  async unload(model: string): Promise<void> {
    const t0 = this.deps.now();
    await this.api("/api/generate", { model, keep_alive: 0 });
    this.deps.log(`[models] unloaded ${model} (${this.deps.now() - t0} ms)`);
    if (this.current?.model === model) this.current = null;
  }

  /** Whether `model` is pulled (/api/tags). Unknown (Ollama not answering) counts as installed. */
  async isInstalled(model: string): Promise<boolean> {
    if (!this.installed) {
      const r = await this.api("/api/tags");
      if (!r) return true;
      this.installed = new Set(((r.models as { name?: string }[] | undefined) ?? []).flatMap((m) => [String(m.name), String(m.name).replace(/:latest$/, "")]));
    }
    return this.installed.has(model) || this.installed.has(model.replace(/:latest$/, ""));
  }

  /**
   * Makes `model` the only resident model for `stage`: unloads the others, checks free VRAM.
   * Returns the model to use (`fallback` when `model` is not pulled).
   */
  async ensure(model: string, stage: string, opts: { fallback?: string; numCtx?: number; minFreeMb?: number; oneModel?: boolean } = {}): Promise<string> {
    let use = model;
    if (opts.fallback && opts.fallback !== model && !(await this.isInstalled(model))) {
      this.deps.log(`[models] ${model} is not pulled (ollama pull ${model}); stage ${stage} uses ${opts.fallback}`);
      use = opts.fallback;
    }
    if (this.current?.model === use) {
      this.current.stage = stage;
      return use;
    }
    if (opts.oneModel !== false) {
      for (const other of await this.loaded()) if (other !== use && other.replace(/:latest$/, "") !== use) await this.unload(other);
    }
    // VRAM guard.
    const need = Math.max(opts.minFreeMb ?? 0, Math.min(estimateVramMb(use, opts.numCtx), 7600));
    let v = await this.deps.vram();
    for (let i = 0; v && v.freeMb < need && i < 5; i++) {
      await this.deps.sleep(1000);
      v = await this.deps.vram();
    }
    if (v && v.freeMb < need) this.deps.log(`[models] VRAM guard: ${v.freeMb} MB free of ${v.totalMb} MB, ${use} needs ~${need} MB; it may spill to the CPU (close other GPU apps)`);
    else if (v) this.deps.log(`[models] VRAM guard ok: ${v.freeMb} MB free for ${use} (~${need} MB)`);
    this.current = { model: use, stage };
    return use;
  }

  /** One finished request: Ollama's own load / eval durations (ns) when known, else wall time. */
  record(model: string, stage: string, r: { loadNs?: number; totalNs?: number; wallMs: number; cpu: boolean }): void {
    const key = `${stage}|${model}`;
    const t = this.times.get(key) ?? { stage, model, requests: 0, loads: 0, loadMs: 0, gpuMs: 0, cpuMs: 0 };
    const loadMs = Math.round((r.loadNs ?? 0) / 1e6);
    const runMs = r.totalNs ? Math.round(r.totalNs / 1e6) - loadMs : r.wallMs;
    t.requests++;
    if (loadMs > 200) t.loads++;
    t.loadMs += loadMs;
    if (r.cpu) t.cpuMs += Math.max(0, runMs);
    else t.gpuMs += Math.max(0, runMs);
    this.times.set(key, t);
    this.deps.log(`[models] stage=${stage} model=${model} ${r.cpu ? "cpu" : "gpu"} load=${loadMs} ms ${r.cpu ? "cpu" : "gpu"}_time=${Math.max(0, runMs)} ms`);
    this.save();
  }

  /** Per-stage totals, merged into the stats file (each pipeline step runs in its own process). */
  save(): void {
    const f = this.deps.statsFile;
    if (!f) return;
    try {
      const all: Record<string, StageTime> = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
      // Adds what changed since this process last saved (other steps' totals are kept).
      for (const [k, t] of this.times) {
        const last = this.saved.get(k);
        const out = { ...t };
        for (const n of NUMS) out[n] = (all[k]?.[n] ?? 0) + t[n] - (last?.[n] ?? 0);
        all[k] = out;
        this.saved.set(k, { ...t });
      }
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, JSON.stringify(all, null, 1));
    } catch {
      /* stats are best effort */
    }
  }
  private saved = new Map<string, StageTime>();

  summary(): string {
    return [...this.times.values()].map((t) => `${t.stage}: ${t.model} ${t.requests} req, gpu ${(t.gpuMs / 1000).toFixed(1)} s, cpu ${(t.cpuMs / 1000).toFixed(1)} s, load ${(t.loadMs / 1000).toFixed(1)} s`).join("; ");
  }

  /** End of a pipeline command: frees the VRAM for the next step (Whisper, TTS, render). */
  async release(): Promise<void> {
    if (this.times.size) this.deps.log(`[models] GPU time this step: ${this.summary()}`);
    if (this.current) await this.unload(this.current.model);
  }
}

const NUMS = ["requests", "loads", "loadMs", "gpuMs", "cpuMs"] as const;

export const gpuTimeFile = () => env("GPU_TIME_FILE", "") || path.join(paths.root, "cache", "gpu_time.json");

let shared: ModelLoader | null = null;

/** Process-wide loader for the local Ollama (null in tests / MODEL_LOADER=off). */
export function modelLoader(baseUrl: () => string): ModelLoader | null {
  if (process.env.NODE_TEST_CONTEXT || env("MODEL_LOADER", "on").toLowerCase() === "off") return null;
  shared ??= new ModelLoader({
    baseUrl,
    fetch: (...a) => fetch(...a),
    vram: nvidiaSmiVram,
    log: (m) => process.stderr.write(m + "\n"),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    statsFile: gpuTimeFile(),
  });
  return shared;
}

/** The loader if one was created in this process (for release at the end of a command). */
export const activeLoader = (): ModelLoader | null => shared;

/** Reads cache/gpu_time.json (UI / pipeline view). */
export function readGpuTimes(file = gpuTimeFile()): StageTime[] {
  try {
    return fs.existsSync(file) ? Object.values(JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, StageTime>) : [];
  } catch {
    return [];
  }
}
