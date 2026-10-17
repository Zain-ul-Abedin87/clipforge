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
}

export const QWEN_PRESETS: Record<QwenSettings["mode"], Omit<QwenSettings, "mode">> = {
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
  qwen: { mode: "cloud", ...QWEN_PRESETS.cloud },
  budget: { claude: { creditUsd: null, stopBelowUsd: 0.5 }, qwen: { creditUsd: null, stopBelowUsd: 0.1 } },
});

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
  };
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
    if (q.mode !== next.qwen.mode) next.qwen = { mode: q.mode, ...QWEN_PRESETS[q.mode] };
  }
  if (text(q.baseUrl) && /^https?:\/\//.test(String(q.baseUrl))) next.qwen.baseUrl = text(q.baseUrl)!.replace(/\/+$/, "");
  if (text(q.model, 80)) next.qwen.model = text(q.model, 80)!;
  if (text(q.visionModel, 80)) next.qwen.visionModel = text(q.visionModel, 80)!;
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
