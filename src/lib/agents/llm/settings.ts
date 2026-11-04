import fs from "node:fs";
import path from "node:path";
import { env, hasKey } from "../../env.js";
import { paths } from "../../paths.js";

/**
 * Which AI model runs the pipeline's text / vision steps, and how much credit each may spend.
 *
 * llm_settings.json (repo root, edited in the simple UI's Settings page):
 *   primary   "claude" | "qwen" | "off"      off = no AI, every step uses its free rule-based path
 *   fallback  "qwen" | "claude" | "none"     used when the primary is not configured, disabled or out of budget
 *   qwen      cloud (Alibaba Model Studio, QWEN_API_KEY) or local (Ollama on this PC, free)
 *   budget    per provider: credit you have left + "stop below" amount
 *
 * cache/llm_usage.json: spend counted from every call's token usage, and auto-disable state.
 * A normal API key cannot read the account's credit balance, so the budget is counted locally from
 * token usage; a "credit balance too low" answer from the API also disables the provider at once.
 * Both files are re-read on every call: each pipeline step runs in its own process.
 */

export const PROVIDERS = ["claude", "qwen"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

export interface QwenSettings {
  mode: "cloud" | "local";
  baseUrl: string;
  model: string;
  visionModel: string;
  /** USD per 1M input / output tokens (0 for a local model). */
  priceIn: number;
  priceOut: number;
  /** Local only: auto = GPU, switching to the CPU when the GPU returns garbage; gpu / cpu = always. */
  device: "auto" | "gpu" | "cpu";
  /**
   * Local only: context window sent with every request (Ollama options.num_ctx). Ollama's own default
   * is 4096 and it silently cuts longer prompts, which makes a 7B model answer "@@@@". 8192 keeps a
   * 7B model 100% on an 8 GB GPU (16384 spilled ~36% of the model to the CPU).
   */
  numCtx: number;
  /** Local only: most items (scenes, lines) one request may carry; bigger jobs are split. */
  maxBatch: number;
  /** Local only: most images one vision request may carry (1-2 fit an 8K context with room for the answer). */
  maxImages: number;
}

/**
 * Pipeline stages that call a local model. Each stage may name its own Ollama model and context
 * (llm_settings.json "stages"); a stage without an entry uses qwen.model / qwen.visionModel.
 * Only one model is kept in VRAM: switching stage unloads the previous model (src/lib/models/loader.ts).
 */
export const STAGES = ["niche", "titles", "script", "plan", "labels", "assets", "vision", "qa", "embed", "orchestrator"] as const;
export type Stage = (typeof STAGES)[number];
export interface StageModel {
  model?: string;
  numCtx?: number;
}

/** Model loader / VRAM guard settings (local Ollama only). */
export interface ModelSettings {
  /** Unload every other model before a stage loads its own (Ollama keep_alive 0). */
  oneModelInVram: boolean;
  /** Unload the stage's model when a pipeline command ends (frees VRAM for Whisper / TTS / render). */
  unloadAfterStage: boolean;
  /** VRAM guard: minimum free MB (nvidia-smi) before a model loads; below it the loader waits, then warns. */
  minFreeVramMb: number;
}

export interface Budget {
  /** Credit left when this budget was set (USD); null = no limit. */
  creditUsd: number | null;
  /** Stop using the provider when the estimated remainder drops below this (USD). */
  stopBelowUsd: number;
}

export interface LlmSettings {
  primary: ProviderName | "off";
  fallback: ProviderName | "none";
  qwen: QwenSettings;
  budget: Record<ProviderName, Budget>;
  stages: Partial<Record<Stage, StageModel>>;
  models: ModelSettings;
}

/**
 * Defaults per stage (hardware: RTX 3070 Ti Laptop, 8 GB VRAM). Plan / labels / vision keep the
 * user's qwen.model / qwen.visionModel unless a stage entry is set in llm_settings.json.
 */
export const DEFAULT_STAGES: Partial<Record<Stage, StageModel>> = {
  niche: { model: "qwen3:8b", numCtx: 8192 },
  titles: { model: "qwen3:8b", numCtx: 8192 },
  script: { model: "qwen3:8b", numCtx: 8192 },
  plan: { numCtx: 8192 },
  labels: { numCtx: 8192 },
  embed: { model: "nomic-embed-text" },
  orchestrator: { model: "qwen2.5:7b", numCtx: 8192 },
};

export const QWEN_PRESETS: Record<QwenSettings["mode"], Omit<QwenSettings, "mode" | "device" | "numCtx" | "maxBatch" | "maxImages">> = {
  // Alibaba Cloud Model Studio, OpenAI-compatible endpoint (international region).
  cloud: { baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", model: "qwen-plus", visionModel: "qwen-vl-plus", priceIn: 0, priceOut: 0 },
  // Ollama on this PC (http://localhost:11434), OpenAI-compatible endpoint; free.
  local: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b", visionModel: "qwen2.5vl:7b", priceIn: 0, priceOut: 0 },
};

/** Overridable (tests): LLM_SETTINGS_FILE / LLM_USAGE_FILE, read at call time. */
export const settingsFile = () => env("LLM_SETTINGS_FILE", "") || path.join(paths.root, "llm_settings.json");
export const usageFile = () => env("LLM_USAGE_FILE", "") || path.join(paths.root, "cache", "llm_usage.json");

const defaults = (): LlmSettings => ({
  primary: "claude",
  fallback: "qwen",
  qwen: { mode: "cloud", ...QWEN_PRESETS.cloud, device: "auto", numCtx: DEFAULT_NUM_CTX, maxBatch: 15, maxImages: 2 },
  budget: { claude: { creditUsd: null, stopBelowUsd: 0.5 }, qwen: { creditUsd: null, stopBelowUsd: 0.1 } },
  stages: {},
  models: { oneModelInVram: true, unloadAfterStage: true, minFreeVramMb: 1500 },
});

/** Context window of a local model when nothing else is set: 16384 did not fit a 7B model in 8 GB. */
export const DEFAULT_NUM_CTX = 8192;

const readJsonFile = <T>(f: string): T | null => {
  try {
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) as T) : null;
  } catch {
    return null;
  }
};

export function loadLlmSettings(file = settingsFile()): LlmSettings {
  const d = defaults();
  const s = readJsonFile<Partial<LlmSettings>>(file) ?? {};
  return {
    primary: s.primary ?? d.primary,
    fallback: s.fallback ?? d.fallback,
    qwen: { ...d.qwen, ...(s.qwen ?? {}) },
    budget: { claude: { ...d.budget.claude, ...(s.budget?.claude ?? {}) }, qwen: { ...d.budget.qwen, ...(s.budget?.qwen ?? {}) } },
    stages: { ...(s.stages ?? {}) },
    models: { ...d.models, ...(s.models ?? {}) },
  };
}

/** Model + context a stage uses (stage entry -> built-in stage default -> qwen settings). */
export function stageModel(stage: Stage | undefined, vision: boolean, s = loadLlmSettings()): { model: string; numCtx: number } {
  const own = stage ? s.stages[stage] : undefined;
  const builtIn = stage ? DEFAULT_STAGES[stage] : undefined;
  const visionOwn = s.stages.vision;
  if (vision) return { model: visionOwn?.model || s.qwen.visionModel, numCtx: visionOwn?.numCtx || s.qwen.numCtx || DEFAULT_NUM_CTX };
  return { model: own?.model || builtIn?.model || s.qwen.model, numCtx: own?.numCtx || s.qwen.numCtx || builtIn?.numCtx || DEFAULT_NUM_CTX };
}

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
const text = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);

/** Validated partial update. Changing a provider's credit amount restarts its spend count. */
export function saveLlmSettings(patch: Record<string, unknown>, file = settingsFile(), usageFile_ = usageFile()): LlmSettings {
  const cur = loadLlmSettings(file);
  const next: LlmSettings = JSON.parse(JSON.stringify(cur));
  if (patch.primary === "claude" || patch.primary === "qwen" || patch.primary === "off") next.primary = patch.primary;
  if (patch.fallback === "claude" || patch.fallback === "qwen" || patch.fallback === "none") next.fallback = patch.fallback;
  const q = (patch.qwen ?? {}) as Record<string, unknown>;
  if (q.mode === "cloud" || q.mode === "local") {
    // Switching mode loads that mode's preset (the user can still edit the fields).
    if (q.mode !== next.qwen.mode) next.qwen = { ...next.qwen, mode: q.mode, ...QWEN_PRESETS[q.mode] };
  }
  if (q.device === "auto" || q.device === "gpu" || q.device === "cpu") next.qwen.device = q.device;
  if (text(q.baseUrl) && /^https?:\/\//.test(String(q.baseUrl))) next.qwen.baseUrl = text(q.baseUrl)!.replace(/\/+$/, "");
  if (text(q.model, 80)) next.qwen.model = text(q.model, 80)!;
  if (text(q.visionModel, 80)) next.qwen.visionModel = text(q.visionModel, 80)!;
  next.qwen.numCtx = num(q.numCtx, 2048, 131072) ?? next.qwen.numCtx;
  next.qwen.maxBatch = num(q.maxBatch, 1, 200) ?? next.qwen.maxBatch;
  next.qwen.maxImages = num(q.maxImages, 1, 20) ?? next.qwen.maxImages;
  const st = (patch.stages ?? {}) as Record<string, Record<string, unknown>>;
  for (const k of STAGES) {
    const v = st[k];
    if (!v) continue;
    const cur = { ...(next.stages[k] ?? {}) };
    if (v.model === "" || v.model === null) delete cur.model;
    else if (text(v.model, 80)) cur.model = text(v.model, 80)!;
    if (v.numCtx === null) delete cur.numCtx;
    else cur.numCtx = num(v.numCtx, 2048, 131072) ?? cur.numCtx;
    next.stages[k] = cur;
  }
  const mo = (patch.models ?? {}) as Record<string, unknown>;
  if (typeof mo.oneModelInVram === "boolean") next.models.oneModelInVram = mo.oneModelInVram;
  if (typeof mo.unloadAfterStage === "boolean") next.models.unloadAfterStage = mo.unloadAfterStage;
  next.models.minFreeVramMb = num(mo.minFreeVramMb, 0, 64000) ?? next.models.minFreeVramMb;
  next.qwen.priceIn = num(q.priceIn, 0, 100) ?? next.qwen.priceIn;
  next.qwen.priceOut = num(q.priceOut, 0, 500) ?? next.qwen.priceOut;
  const b = (patch.budget ?? {}) as Record<string, Record<string, unknown>>;
  for (const p of PROVIDERS) {
    const pb = b[p];
    if (!pb) continue;
    if (pb.creditUsd === null || num(pb.creditUsd, 0, 100000) !== undefined) {
      const credit = pb.creditUsd === null ? null : (pb.creditUsd as number);
      if (credit !== next.budget[p].creditUsd) resetSpend(p, usageFile_);
      next.budget[p].creditUsd = credit;
    }
    next.budget[p].stopBelowUsd = num(pb.stopBelowUsd, 0, 1000) ?? next.budget[p].stopBelowUsd;
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

// ---------------------------------------------------------------------------------------------
// Usage / auto-disable

export interface ProviderUsage {
  spentUsd: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  since: string;
  lastModel?: string;
  disabled?: { reason: string; at: string; auto: boolean };
}
export type UsageState = Record<ProviderName, ProviderUsage>;

const freshUsage = (): ProviderUsage => ({ spentUsd: 0, calls: 0, inputTokens: 0, outputTokens: 0, since: new Date().toISOString() });

export function readUsage(file = usageFile()): UsageState {
  const u = readJsonFile<Partial<UsageState>>(file) ?? {};
  return { claude: { ...freshUsage(), ...(u.claude ?? {}) }, qwen: { ...freshUsage(), ...(u.qwen ?? {}) } };
}

function writeUsage(u: UsageState, file = usageFile()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(u, null, 2));
  fs.renameSync(tmp, file);
}

export function recordUsage(p: ProviderName, model: string, inputTokens: number, outputTokens: number, usd: number, file = usageFile()): ProviderUsage {
  const u = readUsage(file);
  const x = u[p];
  x.calls++;
  x.inputTokens += inputTokens;
  x.outputTokens += outputTokens;
  x.spentUsd = Math.round((x.spentUsd + usd) * 1e6) / 1e6;
  x.lastModel = model;
  writeUsage(u, file);
  return x;
}

export function disableProvider(p: ProviderName, reason: string, auto = true, file = usageFile()): void {
  const u = readUsage(file);
  u[p].disabled = { reason, at: new Date().toISOString(), auto };
  writeUsage(u, file);
}

/** Re-enable (e.g. after topping up credit). Also clears the spend count when asked. */
export function enableProvider(p: ProviderName, resetSpent = false, file = usageFile()): void {
  const u = readUsage(file);
  delete u[p].disabled;
  if (resetSpent) u[p] = { ...freshUsage() };
  writeUsage(u, file);
}

function resetSpend(p: ProviderName, file = usageFile()): void {
  const u = readUsage(file);
  u[p] = { ...freshUsage(), ...(u[p].disabled && !u[p].disabled.auto ? { disabled: u[p].disabled } : {}) };
  writeUsage(u, file);
}

// ---------------------------------------------------------------------------------------------
// Status

export const qwenKey = () => env("QWEN_API_KEY", env("DASHSCOPE_API_KEY", ""));

export interface ProviderStatus {
  provider: ProviderName;
  configured: boolean;
  /** Why it cannot be used right now (missing key, disabled, budget). */
  blocked: string | null;
  spentUsd: number;
  remainingUsd: number | null;
  calls: number;
  disabled: ProviderUsage["disabled"] | null;
}

export function providerStatus(p: ProviderName, s = loadLlmSettings(), u = readUsage()): ProviderStatus {
  const configured = p === "claude" ? hasKey("ANTHROPIC_API_KEY") : s.qwen.mode === "local" || !!qwenKey();
  const b = s.budget[p];
  const remaining = b.creditUsd === null ? null : Math.round((b.creditUsd - u[p].spentUsd) * 100) / 100;
  let blocked: string | null = null;
  if (!configured) blocked = p === "claude" ? "ANTHROPIC_API_KEY is not set in .env" : "QWEN_API_KEY is not set in .env (or switch Qwen to local)";
  else if (u[p].disabled) blocked = `disabled: ${u[p].disabled!.reason}`;
  else if (remaining !== null && remaining <= b.stopBelowUsd) blocked = `budget reached: about $${remaining.toFixed(2)} left (stop below $${b.stopBelowUsd.toFixed(2)})`;
  return { provider: p, configured, blocked, spentUsd: u[p].spentUsd, remainingUsd: remaining, calls: u[p].calls, disabled: u[p].disabled ?? null };
}

/** Providers to try, in order: primary, then fallback, skipping blocked ones. */
export function providerOrder(s = loadLlmSettings(), u = readUsage()): ProviderName[] {
  if (s.primary === "off") return [];
  const want = [s.primary, ...(s.fallback !== "none" && s.fallback !== s.primary ? [s.fallback] : [])] as ProviderName[];
  return want.filter((p) => !providerStatus(p, s, u).blocked);
}
