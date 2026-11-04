import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { paths } from "../paths.js";

/**
 * Settings of the full-pipeline features (research, titles, captions, stock, script, TTS, avatar,
 * shorts, orchestrator), one section per feature, in features.json at the repo root (git-ignored,
 * edited in the UI's Settings panel). Missing keys fall back to the defaults below, so an old file
 * keeps working when a feature adds a setting. Re-read on every call (each step is its own process).
 * Local and free first: every paid / cloud option is off by default.
 */

export interface FeatureSettings {
  research: {
    /** Seed searches for the outlier / niche scan. */
    seeds: string[];
    /** Videos published within this many days are searched. */
    publishedWithinDays: number;
    /** Search results per seed (max 50 = one search call). */
    resultsPerSeed: number;
    /** Uploads used for the channel median (score = views / median of the last N videos). */
    medianOf: number;
    topOutliers: number;
    topChannels: number;
    /** A channel is "new" when it was created within this many months. */
    newChannelMonths: number;
    /** Daily YouTube Data API quota (default project quota: 10,000 units). */
    dailyQuota: number;
    /** Units kept back so other tools on the same key still work. */
    quotaReserve: number;
    /** Cache lifetime of API answers (hours). */
    cacheHours: number;
  };
  titles: {
    count: number;
    /** Fail / rewrite above this similarity to any competitor title (0-1). */
    maxSimilarity: number;
    /** Google News RSS headlines as hooks (free, no key). */
    newsHooks: boolean;
    maxLength: number;
  };
  captions: {
    enabled: boolean;
    preset: string;
    /** Words on screen at once. */
    wordsPerLine: number;
    /** Beat punch-in zoom on emphasised words. */
    punchIn: boolean;
    /** A new visual at least every N seconds (3-5). */
    maxVisualSec: number;
  };
  stock: {
    pexels: boolean;
    pixabay: boolean;
    /** Local image generation through ComfyUI (optional, off by default). */
    imagegen: boolean;
    comfyUrl: string;
    comfyCheckpoint: string;
    perQuery: number;
  };
  script: {
    targetWords: number;
    /** Allowed deviation from targetWords (0.03 = +-3%). */
    tolerance: number;
    products: number;
    /** Fail / rewrite above this similarity to competitor transcripts (0-1). */
    maxSimilarity: number;
    ngram: number;
    embedModel: string;
  };
  tts: {
    engine: "kokoro" | "piper" | "xtts" | "existing";
    voice: string;
    speed: number;
    /** ffmpeg loudnorm target (LUFS). */
    lufs: number;
    /** XTTS-v2 only: your own recorded voice sample (own voice only). */
    xttsSpeakerWav: string;
    pythonCmd: string;
  };
  avatar: {
    enabled: boolean;
    engine: "musetalk" | "liveportrait" | "sadtalker" | "wav2lip" | "latentsync" | "hallo2" | "echomimic";
    placements: ("intro" | "outro" | "bridge")[];
    layout: "pip" | "full";
    pipCorner: "br" | "bl" | "tr" | "tl";
    pipScale: number;
    maxClipSec: number;
    /** Folder of the engine's checkout (python repo) on this PC. */
    engineDir: string;
    pythonCmd: string;
  };
  shorts: {
    count: number;
    minSec: number;
    maxSec: number;
    captions: boolean;
  };
  orchestrator: {
    /** Ask before every step in chat mode. */
    approveEachStep: boolean;
  };
}

export const FEATURE_DEFAULTS: FeatureSettings = {
  research: {
    seeds: ["gun review", "best handgun", "concealed carry", "survival gear", "bushcraft", "prepper"],
    publishedWithinDays: 180,
    resultsPerSeed: 50,
    medianOf: 30,
    topOutliers: 50,
    topChannels: 20,
    newChannelMonths: 12,
    dailyQuota: 10000,
    quotaReserve: 1000,
    cacheHours: 24,
  },
  titles: { count: 10, maxSimilarity: 0.8, newsHooks: true, maxLength: 70 },
  captions: { enabled: true, preset: "bold-pop", wordsPerLine: 3, punchIn: true, maxVisualSec: 4 },
  stock: { pexels: true, pixabay: true, imagegen: false, comfyUrl: "http://127.0.0.1:8188", comfyCheckpoint: "sd_xl_turbo_1.0_fp16.safetensors", perQuery: 15 },
  script: { targetWords: 1500, tolerance: 0.03, products: 10, maxSimilarity: 0.8, ngram: 5, embedModel: "nomic-embed-text" },
  tts: { engine: "kokoro", voice: "am_michael", speed: 1, lufs: -14, xttsSpeakerWav: "", pythonCmd: "python" },
  avatar: { enabled: false, engine: "musetalk", placements: ["intro", "outro"], layout: "pip", pipCorner: "br", pipScale: 0.32, maxClipSec: 15, engineDir: "", pythonCmd: "python" },
  shorts: { count: 3, minSec: 30, maxSec: 58, captions: true },
  orchestrator: { approveEachStep: true },
};

export const featuresFile = () => env("FEATURE_SETTINGS_FILE", "") || path.join(paths.root, "features.json");

type Section = keyof FeatureSettings;

function readFile(file: string): Partial<Record<Section, Record<string, unknown>>> {
  try {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) : {};
  } catch {
    return {};
  }
}

export function loadFeatures(file = featuresFile()): FeatureSettings {
  const raw = readFile(file);
  const out = JSON.parse(JSON.stringify(FEATURE_DEFAULTS)) as FeatureSettings;
  for (const k of Object.keys(FEATURE_DEFAULTS) as Section[]) Object.assign(out[k], sanitize(k, raw[k] ?? {}));
  return out;
}

/** Keeps only known keys whose type matches the default (a hand-edited file cannot break a step). */
function sanitize(section: Section, patch: Record<string, unknown>): Record<string, unknown> {
  const def = FEATURE_DEFAULTS[section] as unknown as Record<string, unknown>;
  const ok: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in def)) continue;
    const d = def[k];
    if (Array.isArray(d)) {
      if (Array.isArray(v) && v.every((x) => typeof x === "string")) ok[k] = (v as string[]).map((x) => x.trim()).filter(Boolean).slice(0, 50);
    } else if (typeof d === "number") {
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) ok[k] = v;
    } else if (typeof d === typeof v) ok[k] = typeof v === "string" ? v.trim().slice(0, 500) : v;
  }
  return ok;
}

/** Validated partial update of one or more sections; returns the full settings. */
export function saveFeatures(patch: Partial<Record<Section, Record<string, unknown>>>, file = featuresFile()): FeatureSettings {
  const raw = readFile(file);
  for (const k of Object.keys(FEATURE_DEFAULTS) as Section[]) if (patch[k]) raw[k] = { ...(raw[k] ?? {}), ...sanitize(k, patch[k]!) };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2));
  return loadFeatures(file);
}
