import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { env } from "../../env.js";
import { run } from "../../exec.js";
import { paths } from "../../paths.js";
import { parseIdentity } from "../../productResearch.js";
import { norm } from "../../text.js";
import type { PoolShot } from "../../assets/productPool.js";
import type { Candidate } from "../../assets/types.js";
import { ffmpegPath, ffprobePath, venvPythonPath } from "../../tools.js";
import { ensureLandscape } from "../../engine/filters/lavfiBuilder.js";
import { fuzzyTitleHasModel, fuzzyTokenMatch, suggestSpelling } from "./fuzzyMatcher.js";
import { clipAvailable, judge, promptSet, ScoringProfile, scoreShots, ShotScore, ShotThresholds, thresholdsFor } from "../vision/clipScorer.js";

/**
 * Visual-first exact-model extractor. For one brand + exact model it:
 *  1. searches YouTube (walkaround / review / demo / official) and keeps only videos whose title
 *     names the exact model (and no other model number), 45 s - 25 min long;
 *  2. downloads only candidate windows (yt-dlp download sections, video only), skipping the first
 *     10 s of channel intros and preferring chapters that name a feature ("deck", "engine", ...);
 *  3. splits every window at camera cuts (FFmpeg scene score > 0.3, long shots sliced to 5 s);
 *  4. scores each shot's middle frame with CLIP (python/clip_score.py) against a machine prompt and
 *     a talking-head prompt, and deletes talking heads / off-topic shots;
 *  5. keeps the clean shots as .mp4 clips (+ high-res .jpg stills) in the model vault
 *     workspace/models/<brand>_<model>/ with manifest.json (URL, timestamp, CLIP scores, feature).
 * The asset resolver then serves scenes about that model from the vault only.
 *
 * Keyword mode (harvestKeyword): for a spec the narration names ("brushless motor"), the video's
 * captions (.json3 word timings, or .vtt) are searched for the keyword and ONLY a 3-5 s window
 * around the spoken moment is downloaded, then filtered the same way.
 *
 * (Moved from src/lib/assets/ytExtractor.ts, which now re-exports this module. CLIP scoring moves
 * to agents/vision/clipScorer.ts in the next phase.)
 */

export const VAULT_ROOT = path.join(paths.workspace, "models");
export const MIN_VIDEO_SEC = 45;
export const MAX_VIDEO_SEC = 25 * 60;
export const INTRO_SKIP_SEC = 10;

const num = (name: string, d: number) => {
  const v = Number(env(name, ""));
  return Number.isFinite(v) && env(name, "") !== "" ? v : d;
};

// ---------------------------------------------------------------------------------------------
// Pure helpers (unit-tested)

const normText = (s: string) => s.toLowerCase().replace(/&/g, " and ");

/**
 * "Z930M" -> /(?<![a-z0-9])z[^a-z0-9]*930[^a-z0-9]*m(?![a-z0-9])/: tolerant of "Z-930M" / "HRX 217",
 * strict on "Z930R" and "Turf Tiger III". A model that ends in digits also accepts a trim suffix of
 * up to 3 letters ("HRX217" matches "HRX217HZA", the same machine in another trim) unless
 * HARVEST_ALLOW_TRIMS=off.
 */
export function modelPattern(model: string): RegExp {
  const parts = normText(model).match(/[a-z]+|[0-9]+/g) ?? [];
  if (!parts.length) throw new Error(`model "${model}" has no letters or digits`);
  const trim = /\d$/.test(parts[parts.length - 1]) && env("HARVEST_ALLOW_TRIMS", "on").toLowerCase() !== "off" ? "(?:[a-z]{1,3})?" : "";
  return new RegExp(`(?<![a-z0-9])${parts.join("[^a-z0-9]*")}${trim}(?![a-z0-9])`, "i");
}

/**
 * Another model of the same line named in the title ("Z930M vs Z960M", "HRX216 review"): a code
 * with the model's letter prefix that is neither the model nor one of its trims. Sizes ("21 inch",
 * '21"') and years are not model codes.
 */
export function conflictingModel(title: string, model: string): string | null {
  const m = normText(model).replace(/[^a-z0-9]/g, "");
  const prefix = /^[a-z]+(?=\d)/.exec(m)?.[0];
  if (!prefix) return null;
  for (const x of normText(title).matchAll(/(?<![a-z0-9])([a-z]{1,5})[\s-]?(\d{2,5}[a-z]{0,3})(?![a-z0-9])/g)) {
    const code = x[1] + x[2];
    if (x[1] !== prefix || code.startsWith(m) || m.startsWith(code)) continue;
    return code.toUpperCase();
  }
  return null;
}

/** The title must contain the exact model token(s), case-insensitive. */
export function titleHasModel(title: string, model: string): boolean {
  return modelPattern(model).test(normText(title));
}

export const durationOk = (sec: number) => sec >= MIN_VIDEO_SEC && sec <= MAX_VIDEO_SEC;

/** YouTube Shorts (vertical, <= 60 s): allowed from 15 s when HARVEST_SHORTS is on, converted to 16:9. */
export const SHORTS_MIN_SEC = 15;
export const SHORTS_MAX_SEC = 60;
export const isShortsUrl = (url: string) => /youtube\.com\/shorts\//i.test(url);
export const shortsAllowed = () => env("HARVEST_SHORTS", "on").toLowerCase() !== "off";
const lengthOk = (h: Pick<SearchHit, "url" | "duration">, allowShorts: boolean) =>
  durationOk(h.duration) || (allowShorts && isShortsUrl(h.url) && h.duration >= SHORTS_MIN_SEC && h.duration <= SHORTS_MAX_SEC);

/** YouTube searches for one model (the search box has no OR, so one query per kind of video). */
export function searchQueries(brand: string, model: string): string[] {
  const base = `"${brand} ${model}"`.replace(/\s+/g, " ");
  return ["walkaround", "review", "demo", "official"].map((k) => `${base} ${k}`);
}

export interface SearchHit {
  id: string;
  url: string;
  title: string;
  duration: number;
  channel: string;
  channel_url?: string;
  query?: string;
}

/** Search results that are about exactly this model: title names it, no other model, sane length. */
export function filterHits(
  hits: SearchHit[],
  brand: string,
  model: string,
  otherModels: string[] = [],
  allowShorts = shortsAllowed(),
  fuzzy = false,
): { kept: SearchHit[]; rejected: { hit: SearchHit; why: string }[] } {
  const kept: SearchHit[] = [];
  const rejected: { hit: SearchHit; why: string }[] = [];
  // Exact token match first; fuzzy (letters may be misspelled, digits never) only when asked.
  const names = (title: string) => titleHasModel(title, model) || (fuzzy && fuzzyTitleHasModel(title, model));
  for (const h of hits) {
    if (!names(h.title)) rejected.push({ hit: h, why: "title does not name the exact model" });
    else if (!lengthOk(h, allowShorts)) rejected.push({ hit: h, why: `length ${Math.round(h.duration)} s outside ${MIN_VIDEO_SEC} s - ${MAX_VIDEO_SEC / 60} min` });
    else if (otherModels.some((m) => titleHasModel(h.title, m))) rejected.push({ hit: h, why: "title also names another model (comparison video)" });
    else if (conflictingModel(h.title, model)) rejected.push({ hit: h, why: `title also names ${conflictingModel(h.title, model)} (another model)` });
    else if (generationConflict(h.title, model)) rejected.push({ hit: h, why: `title names generation ${generationConflict(h.title, model)}` });
    else kept.push(h);
  }
  return { kept, rejected };
}

/** "Gen 3" in the model but "Gen 5" in the title (both must name a generation). */
export function generationConflict(title: string, model: string): string | null {
  const want = parseIdentity(model).generation;
  const got = parseIdentity(title).generation;
  return want && got && want !== got ? got : null;
}

export interface Window {
  start: number;
  end: number;
  feature?: string;
  /** Caption keyword this window was cut around (keyword mode). */
  keyword?: string;
  /** The spoken words around the keyword. */
  caption?: string;
}

/**
 * Where to look inside a video: chapters whose title names a feature first, then windows spread
 * evenly between the intro (first 10 s) and the outro (last 8 %).
 */
export function planWindows(duration: number, chapters: { start: number; end: number; title: string }[], features: string[], opts: { count?: number; seconds?: number } = {}): Window[] {
  const count = opts.count ?? 4;
  const len = opts.seconds ?? 20;
  const from = Math.min(INTRO_SKIP_SEC, duration * 0.2);
  const to = Math.max(from + 1, duration * 0.92);
  const out: Window[] = [];
  const overlaps = (s: number, e: number) => out.some((w) => s < w.end && e > w.start);
  const feats = features.map((f) => f.toLowerCase().trim()).filter(Boolean);
  for (const c of chapters) {
    if (out.length >= count) break;
    const f = feats.find((x) => c.title.toLowerCase().includes(x));
    if (!f) continue;
    const s = Math.max(from, c.start);
    const e = Math.min(to, c.end || s + len, s + len);
    if (e - s >= 3 && !overlaps(s, e)) out.push({ start: round(s), end: round(e), feature: f });
  }
  const free = count - out.length;
  if (free > 0 && to - from >= 3) {
    const step = (to - from) / free;
    for (let k = 0; k < free; k++) {
      let s = from + step * k + Math.max(0, (step - len) / 2);
      let e = Math.min(to, s + Math.min(len, step));
      // Collides with a feature window: move just past it (or just before it) instead of dropping it.
      const hit = out.find((w) => s < w.end && e > w.start);
      if (hit) {
        const after = [hit.end + 0.5, Math.min(to, hit.end + 0.5 + (e - s))];
        const before = [Math.max(from, hit.start - 0.5 - (e - s)), hit.start - 0.5];
        [s, e] = !overlaps(after[0], after[1]) && after[1] - after[0] >= 3 ? after : before;
      }
      if (e - s >= 3 && !overlaps(s, e)) out.push({ start: round(s), end: round(e) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Cut times from FFmpeg `select='gt(scene,0.3)',showinfo` output. */
export function cutsFromShowinfo(stderr: string): number[] {
  return [...stderr.matchAll(/pts_time:\s*([\d.]+)/g)].map((m) => Number(m[1])).filter((t) => Number.isFinite(t));
}

/** Shots between cuts; too-short shots dropped, long shots sliced into `slice`-second pieces. */
export function shotsFromCuts(cuts: number[], duration: number, o: { minShot?: number; maxShot?: number; slice?: number } = {}): { start: number; end: number }[] {
  const minShot = o.minShot ?? 1.5;
  const maxShot = o.maxShot ?? 6;
  const slice = o.slice ?? 5;
  const bounds = [0, ...cuts.filter((t) => t > 0.05 && t < duration - 0.05).sort((a, b) => a - b), duration];
  const out: { start: number; end: number }[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    // Trim a few frames at each cut so a shot never starts on a transition frame.
    const s = bounds[i] + (i > 0 ? 0.1 : 0);
    const e = bounds[i + 1] - (i + 2 < bounds.length ? 0.1 : 0);
    if (e - s < minShot) continue;
    if (e - s <= maxShot) {
      out.push({ start: round(s), end: round(e) });
      continue;
    }
    for (let t = s; e - t >= minShot; t += slice) out.push({ start: round(t), end: round(Math.min(e, t + slice)) });
  }
  return out;
}

// Shot scoring (prompts, thresholds, classification) lives in agents/vision/clipScorer.ts.
export { classifyShot, defaultThresholds, NEGATIVE_PROMPT, negativePrompts, positivePrompt, promptSet, thresholdsFor } from "../vision/clipScorer.js";
export type { ScoringProfile, ShotThresholds, ShotVerdict } from "../vision/clipScorer.js";

export const sanitizeName = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export const vaultName = (brand: string, model: string) => `${sanitizeName(brand)}_${sanitizeName(model)}`;
export const vaultDir = (brand: string, model: string) => path.join(VAULT_ROOT, vaultName(brand, model));

const round = (x: number) => Math.round(x * 100) / 100;

// ---------------------------------------------------------------------------------------------
// Vault

export interface VaultItem {
  id: string;
  kind: "video" | "image";
  /** Path relative to the vault folder. */
  file: string;
  /** Watch URL with the timestamp of the shot (&t=). */
  url: string;
  videoId: string;
  title: string;
  channel: string;
  /** Seconds in the source video. */
  start: number;
  end: number;
  clipPositive: number;
  clipNegative: number;
  feature: string | null;
  width: number;
  height: number;
  duration?: number;
  /** CLIP profile that accepted this shot. */
  profile?: ScoringProfile;
  /** Cut from a vertical source (Short) and padded to 16:9 with a blurred background. */
  vertical?: boolean;
  /** Keyword mode: the spec keyword and the caption text it was cut around. */
  keyword?: string;
  caption?: string;
  addedAt: string;
}

export interface VaultManifest {
  brand: string;
  model: string;
  category: string;
  features: string[];
  updatedAt: string;
  items: VaultItem[];
  /** videoId -> window starts already processed (re-runs skip them). */
  processed: Record<string, number[]>;
  rejectedVideos: { id: string; title: string; why: string }[];
  /** Spelling the YouTube titles use, when the script's name had a typo. */
  spelling?: string;
  stats: { shotsScored: number; talkingHeads: number; offTopic: number; kept: number };
  /** CLIP profile the last harvest used (machine = walkaround B-roll, handson = relaxed close-ups). */
  profile?: ScoringProfile;
}

export function readVault(dir: string): VaultManifest | null {
  const f = path.join(dir, "manifest.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) as VaultManifest;
  } catch {
    return null;
  }
}

function writeVault(dir: string, m: VaultManifest): void {
  m.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 1));
}

export function listVaults(root = VAULT_ROOT): { dir: string; name: string; manifest: VaultManifest }[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root)
    .map((name) => ({ dir: path.join(root, name), name }))
    .map((v) => ({ ...v, manifest: readVault(v.dir)! }))
    .filter((v) => v.manifest);
}

/**
 * The vault for a product name used in a script ("Honda HRX217 lawn mower" -> honda_hrx217): the
 * name must contain the vault's exact model; a vault whose brand also appears wins, then the
 * longest model (so "Turf Tiger II" beats "Turf Tiger").
 */
export function findVaultFor(productName: string, root = VAULT_ROOT): { dir: string; manifest: VaultManifest } | null {
  const all = listVaults(root).filter((v) => v.manifest.items.length);
  let hits = all.filter((v) => titleHasModel(productName, v.manifest.model));
  if (!hits.length && env("FUZZY_NAMES", "on").toLowerCase() !== "off") hits = all.filter((v) => fuzzyTitleHasModel(productName, v.manifest.model));
  if (!hits.length) return null;
  const brandIn = (v: (typeof hits)[number]) => (normText(productName).includes(normText(v.manifest.brand)) ? 1 : 0);
  hits.sort((a, b) => brandIn(b) - brandIn(a) || b.manifest.model.length - a.manifest.model.length);
  return hits[0];
}

export const vaultFile = (dir: string, item: VaultItem) => path.join(dir, item.file);

/** Licence text for the ledger: these are other people's videos (review / editorial use). */
export function vaultLicense(item: Pick<VaultItem, "channel">, brand: string): string {
  const official = item.channel && normText(item.channel).includes(normText(brand)) ? "official brand channel" : "YouTube review / dealer video";
  return `YouTube - ${item.channel || "unknown channel"} (${official}; standard YouTube licence - editorial use, check rights before publishing)`;
}

// ---------------------------------------------------------------------------------------------
// Harvest

export interface HarvestOpts {
  brand: string;
  model: string;
  features?: string[];
  /** Kind of machine for the CLIP prompt (default "lawn mower"). */
  category?: string;
  /** Other models to keep out (comparison videos). */
  otherModels?: string[];
  maxVideos?: number;
  windowsPerVideo?: number;
  windowSeconds?: number;
  /** Re-process videos that were already harvested. */
  force?: boolean;
  /** CLIP filter profile (default machine; HARVEST_PROFILE in .env). */
  profile?: ScoringProfile;
  log?: (m: string) => void;
}

export interface HarvestResult {
  dir: string;
  manifest: VaultManifest;
  added: number;
  videosUsed: number;
}

const SCRIPT = path.join(paths.python, "yt_extract.py");

/** One request to python/yt_extract.py (JSON in, last JSON line out). */
function py(op: string, req: unknown, timeoutMs: number): Promise<Record<string, unknown>> {
  const bin = venvPythonPath();
  if (!bin) return Promise.resolve({ ok: false, error: "no .venv python (see README setup)" });
  return new Promise((resolve) => {
    const child = spawn(bin, ["-u", SCRIPT, op], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    let out = "";
    let err = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => resolve({ ok: false, error: String(e) }));
    child.on("close", () => {
      clearTimeout(timer);
      const line = out.split(/\r?\n/).filter((l) => l.trim().startsWith("{")).pop();
      try {
        resolve(line ? JSON.parse(line) : { ok: false, error: err.trim().split(/\r?\n/).pop() ?? "no reply" });
      } catch {
        resolve({ ok: false, error: "unreadable reply" });
      }
    });
    child.stdin.end(JSON.stringify(req));
  });
}

/** A shot inside a downloaded window, with its middle frame. */
interface WindowShot {
  key: string;
  windowFile: string;
  /** Where the window starts in the source video. */
  srcOffset: number;
  /** Seconds inside the window. */
  start: number;
  end: number;
  frame: string;
}

/** Everything one harvest run needs while it processes windows. */
interface HarvestContext {
  dir: string;
  manifest: VaultManifest;
  brand: string;
  model: string;
  category: string;
  ff: string;
  work: string;
  clipsDir: string;
  framesDir: string;
  th: ShotThresholds;
  profile: ScoringProfile;
  force: boolean;
  log: (m: string) => void;
}

function openVault(brand: string, model: string, category: string, features: string[], log: (m: string) => void, force = false, profile: ScoringProfile = "machine"): HarvestContext {
  const ff = ffmpegPath();
  if (!ff) throw new Error("ffmpeg not found");
  if (!clipAvailable()) throw new Error("CLIP needs the .venv (python/clip_score.py) - the talking-head filter cannot run without it");
  const dir = vaultDir(brand, model);
  const clipsDir = path.join(dir, "clips");
  const framesDir = path.join(dir, "frames");
  const work = path.join(dir, "_work");
  for (const d of [clipsDir, framesDir, work]) fs.mkdirSync(d, { recursive: true });
  const manifest: VaultManifest = readVault(dir) ?? {
    brand, model, category, features, updatedAt: "", items: [], processed: {}, rejectedVideos: [],
    stats: { shotsScored: 0, talkingHeads: 0, offTopic: 0, kept: 0 },
  };
  manifest.features = [...new Set([...manifest.features, ...features])];
  manifest.profile = profile;
  return { dir, manifest, brand, model, category, ff, work, clipsDir, framesDir, th: thresholdsFor(profile), profile, force, log };
}

/**
 * YouTube search + the strict exact-model title / length filter; rejected videos are remembered.
 * Typos: titles are also matched fuzzily (letters only, digits exact), and when the given spelling
 * finds fewer than FUZZY_MIN_HITS usable videos, the spelling the search titles agree on is used
 * for a second search ("Turf Tigre II" -> "Turf Tiger II").
 */
async function searchModelVideos(ctx: HarvestContext, queries: string[], otherModels: string[] | undefined, maxVideos: number, requery?: (brand: string, model: string) => string[]): Promise<SearchHit[]> {
  const fuzzy = env("FUZZY_NAMES", "on").toLowerCase() !== "off";
  ctx.log(`[harvest] ${ctx.brand} ${ctx.model}: searching YouTube (${queries.length} queries)`);
  const s = await py("search", { queries, limit: 10 }, 3 * 60_000);
  if (!s.ok) throw new Error(`YouTube search failed: ${s.error}`);
  let hits = s.results as SearchHit[];
  let model = ctx.model;
  let { kept, rejected } = filterHits(hits, ctx.brand, model, otherModels, shortsAllowed(), fuzzy);
  if (fuzzy && requery && kept.length < num("FUZZY_MIN_HITS", 2)) {
    const titles = hits.map((h) => h.title);
    const fixedModel = suggestSpelling(ctx.model, titles) ?? ctx.model;
    const fixedBrand = suggestSpelling(ctx.brand, titles) ?? ctx.brand;
    if (fixedModel !== ctx.model || fixedBrand !== ctx.brand) {
      ctx.log(`[harvest] few results for "${ctx.brand} ${ctx.model}"; titles spell it "${fixedBrand} ${fixedModel}" - searching again`);
      const again = await py("search", { queries: requery(fixedBrand, fixedModel), limit: 10 }, 3 * 60_000);
      if (again.ok) {
        const seen = new Set(hits.map((h) => h.id));
        hits = [...hits, ...(again.results as SearchHit[]).filter((h) => !seen.has(h.id))];
        model = fixedModel;
        ({ kept, rejected } = filterHits(hits, fixedBrand, model, otherModels, shortsAllowed(), fuzzy));
        ctx.manifest.spelling = `${fixedBrand} ${fixedModel}`;
      }
    }
  }
  for (const r of rejected) if (!ctx.manifest.rejectedVideos.some((x) => x.id === r.hit.id)) ctx.manifest.rejectedVideos.push({ id: r.hit.id, title: r.hit.title, why: r.why });
  ctx.log(`[harvest] ${hits.length} result(s), ${kept.length} name "${model}"${fuzzy ? " (typos in letters allowed)" : " exactly"} and are ${MIN_VIDEO_SEC} s - ${MAX_VIDEO_SEC / 60} min long`);
  // Walkarounds and brand channels first: they are mostly machine footage.
  const rank = (h: SearchHit) => (/walk ?around|official|demo/i.test(h.title) ? 2 : 0) + (normText(h.channel).includes(normText(ctx.brand)) ? 1 : 0);
  return kept.sort((a, b) => rank(b) - rank(a)).slice(0, maxVideos);
}

/**
 * Shared pipeline for one video: download only the windows -> split at camera cuts -> CLIP
 * (machine vs talking head / logo / title card) -> keep clean shots in the vault. Returns shots kept.
 */
async function processWindows(ctx: HarvestContext, v: SearchHit, windows: Window[]): Promise<number> {
  const { ff, work, dir, manifest } = ctx;
  const todo = windows.filter((w) => ctx.force || !(manifest.processed[v.id] ?? []).includes(w.start));
  if (!todo.length) return 0;
  const shots: (WindowShot & { window: Window })[] = [];
  const verticalWindows = new Set<string>();
  for (const w of todo) {
    const winFile = path.join(work, `${v.id}_${Math.round(w.start * 10)}.mp4`);
    const f = await py("fetch", { url: v.url, start: w.start, seconds: w.end - w.start, out: winFile, ffmpeg: ff, max_height: 1920, allow_vertical: true }, 4 * 60_000);
    if (!f.ok || !fs.existsSync(winFile)) {
      ctx.log(`[harvest]   window ${Math.round(w.start)} s: ${String(f.error ?? "download failed").slice(0, 120)}`);
      continue; // not marked processed: the next run tries it again
    }
    (manifest.processed[v.id] ??= []).push(w.start);
    // Shorts / vertical / square sources become 16:9 (blurred copy behind the whole picture) before
    // shots are cut, so every vault clip and still is landscape.
    try {
      const flat = winFile.replace(/\.mp4$/, "_16x9.mp4");
      const conv = await ensureLandscape(ff, ffprobePath() ?? "ffprobe", winFile, flat);
      if (conv) {
        fs.renameSync(flat, winFile);
        verticalWindows.add(winFile);
        ctx.log(`[harvest]   window ${Math.round(w.start)} s: ${conv.src.w}x${conv.src.h} source -> 16:9 (${conv.fit})`);
      }
    } catch (err) {
      ctx.log(`[harvest]   window ${Math.round(w.start)} s: ${String((err as Error).message).slice(0, 120)}`);
      continue;
    }
    const winStart = Number(f.start ?? w.start);
    const det = await run(ff, ["-hide_banner", "-nostats", "-i", winFile, "-an", "-vf", "select='gt(scene,0.3)',showinfo", "-f", "null", "-"], { timeoutMs: 120_000 });
    const winDur = Number(f.seconds) || w.end - w.start;
    for (const sh of shotsFromCuts(cutsFromShowinfo(det.stderr), winDur)) {
      const key = `${v.id}_${Math.round((winStart + sh.start) * 10)}`;
      const frame = path.join(work, `${key}.jpg`);
      const g = await run(ff, ["-v", "error", "-y", "-ss", ((sh.start + sh.end) / 2).toFixed(2), "-i", winFile, "-frames:v", "1", "-q:v", "2", frame], { timeoutMs: 60_000 });
      if (g.code === 0 && fs.existsSync(frame)) shots.push({ key, windowFile: winFile, srcOffset: winStart, start: sh.start, end: sh.end, frame, window: w });
    }
  }
  if (!shots.length) return 0;

  const scores = await scoreShots(new Map(shots.map((x) => [x.key, x.frame])), promptSet(ctx.profile, ctx.brand, ctx.model, ctx.category, manifest.features), work);
  if (!scores) throw new Error("CLIP scoring failed (python/clip_score.py) - nothing was kept, because talking heads could not be filtered");
  let kept = 0;
  for (const x of shots) {
    const sc = scores.get(x.key)!;
    const [pos, neg] = [sc.pos, sc.neg];
    const verdict = judge(sc, ctx.th);
    manifest.stats.shotsScored++;
    if (verdict !== "keep" || manifest.items.some((i) => i.id === `${x.key}_v`)) {
      if (verdict === "talking_head") manifest.stats.talkingHeads++;
      else if (verdict === "off_topic") manifest.stats.offTopic++;
      fs.rmSync(x.frame, { force: true });
      continue;
    }
    const feature = x.window.keyword ?? (sc.features.length && sc.features[0][1] >= pos - 0.01 ? sc.features[0][0] : null);
    const clip = path.join(ctx.clipsDir, `${x.key}.mp4`);
    const c = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-ss", x.start.toFixed(2), "-i", x.windowFile, "-t", (x.end - x.start).toFixed(2), "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", clip], { timeoutMs: 120_000 });
    if (c.code !== 0 || !fs.existsSync(clip)) continue;
    const dims = (await run(ffprobePath() ?? "ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", clip])).stdout.trim().split(",").map(Number);
    const [width, height] = [dims[0] || 0, dims[1] || 0];
    const at = round(x.srcOffset + x.start);
    const base = {
      videoId: v.id, title: v.title, channel: v.channel, start: at, end: round(x.srcOffset + x.end),
      url: `https://www.youtube.com/watch?v=${v.id}&t=${Math.floor(at)}s`, clipPositive: pos, clipNegative: neg, feature, width, height, profile: ctx.profile,
      ...(verticalWindows.has(x.windowFile) ? { vertical: true } : {}),
      ...(x.window.keyword ? { keyword: x.window.keyword } : {}), ...(x.window.caption ? { caption: x.window.caption } : {}),
      addedAt: new Date().toISOString(),
    };
    manifest.items.push({ ...base, id: `${x.key}_v`, kind: "video", file: path.relative(dir, clip).replace(/\\/g, "/"), duration: round(x.end - x.start) });
    // High-res still: only frames of HD sources are worth showing full screen.
    if (height >= 720 && !verticalWindows.has(x.windowFile)) {
      const still = path.join(ctx.framesDir, `${x.key}.jpg`);
      fs.renameSync(x.frame, still);
      manifest.items.push({ ...base, id: `${x.key}_i`, kind: "image", file: path.relative(dir, still).replace(/\\/g, "/") });
    } else fs.rmSync(x.frame, { force: true });
    manifest.stats.kept++;
    kept++;
  }
  for (const w of new Set(shots.map((x) => x.windowFile))) fs.rmSync(w, { force: true });
  writeVault(dir, manifest);
  ctx.log(`[harvest]   kept ${kept} shot(s) (vault: ${manifest.items.filter((i) => i.kind === "video").length} clips, ${manifest.items.filter((i) => i.kind === "image").length} stills)`);
  return kept;
}

function closeVault(ctx: HarvestContext): void {
  fs.rmSync(ctx.work, { recursive: true, force: true });
  writeVault(ctx.dir, ctx.manifest);
}

export async function harvestModel(o: HarvestOpts): Promise<HarvestResult> {
  const log = o.log ?? (() => {});
  const brand = o.brand.trim();
  const model = o.model.trim();
  if (!brand || !model) throw new Error("brand and model are required");
  const features = [...new Set((o.features ?? []).map((f) => f.trim().toLowerCase()).filter(Boolean))];
  const profile = o.profile ?? ((env("HARVEST_PROFILE", "machine") === "handson" ? "handson" : "machine") as ScoringProfile);
  const ctx = openVault(brand, model, (o.category ?? "lawn mower").trim(), features, log, o.force, profile);
  const videos = await searchModelVideos(ctx, searchQueries(brand, model), o.otherModels, o.maxVideos ?? num("HARVEST_MAX_VIDEOS", 6), searchQueries);

  let added = 0;
  let videosUsed = 0;
  for (const v of videos) {
    const meta = await py("info", { url: v.url }, 2 * 60_000);
    const duration = Number(meta.duration) || v.duration;
    const chapters = (meta.ok ? (meta.chapters as { start: number; end: number; title: string }[]) : []) ?? [];
    const windows = planWindows(duration, chapters, ctx.manifest.features, { count: o.windowsPerVideo ?? num("HARVEST_WINDOWS", 4), seconds: o.windowSeconds ?? num("HARVEST_WINDOW_SECONDS", 20) });
    log(`[harvest] "${v.title}" (${v.channel}, ${Math.round(duration)} s): ${windows.length} window(s)${chapters.length ? `, ${chapters.length} chapter(s)` : ""}`);
    const n = await processWindows(ctx, v, windows);
    added += n;
    if (n) videosUsed++;
  }
  closeVault(ctx);
  log(`[harvest] ${brand} ${model}: +${added} shot(s) from ${videosUsed} video(s); ${ctx.manifest.stats.talkingHeads} talking-head and ${ctx.manifest.stats.offTopic} off-topic shot(s) rejected so far -> ${ctx.dir}`);
  return { dir: ctx.dir, manifest: ctx.manifest, added, videosUsed };
}

// ---------------------------------------------------------------------------------------------
// Keyword mode: captions -> spoken moment -> 3-5 s clip

/** One spoken word with its start time (seconds in the source video). */
export interface CaptionWord {
  text: string;
  t: number;
}

/**
 * YouTube .json3 captions -> words. Automatic captions carry per-word offsets (tStartMs + tOffsetMs);
 * uploader captions have one segment per line, whose words are spread evenly over the line.
 */
export function parseJson3(text: string): CaptionWord[] {
  const data = JSON.parse(text) as { events?: { tStartMs?: number; dDurationMs?: number; segs?: { utf8?: string; tOffsetMs?: number }[] }[] };
  const out: CaptionWord[] = [];
  for (const e of data.events ?? []) {
    const segs = (e.segs ?? []).filter((x) => x.utf8 && x.utf8.trim());
    if (!segs.length) continue;
    const t0 = (e.tStartMs ?? 0) / 1000;
    const timed = segs.length > 1 || segs.some((x) => x.tOffsetMs !== undefined);
    if (timed) {
      for (const sg of segs) for (const w of sg.utf8!.trim().split(/\s+/)) out.push({ text: w, t: round(t0 + (sg.tOffsetMs ?? 0) / 1000) });
      continue;
    }
    const words = segs[0].utf8!.trim().split(/\s+/);
    const dur = (e.dDurationMs ?? 0) / 1000;
    words.forEach((w, k) => out.push({ text: w, t: round(t0 + (dur * k) / words.length) }));
  }
  return out.sort((a, b) => a.t - b.t);
}

const vttTime = (s: string) => {
  const p = s.trim().split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
};

/**
 * WebVTT -> words. Inline word timings (<00:00:01.500>, used by YouTube auto captions) are used
 * when present; otherwise words are spread over the cue. YouTube's rolling auto-VTT repeats the
 * previous line at the top of each cue, so a line identical to the last one is skipped.
 */
export function parseVtt(text: string): CaptionWord[] {
  const out: CaptionWord[] = [];
  let lastLine = "";
  for (const block of text.replace(/\r/g, "").split(/\n\n+/)) {
    const m = /(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?\.\d{3})/.exec(block);
    if (!m) continue;
    const [start, end] = [vttTime(m[1]), vttTime(m[2])];
    const lines = block.slice(block.indexOf(m[0]) + m[0].length).split("\n").map((l) => l.trim()).filter(Boolean);
    for (const line of lines) {
      const plain = line.replace(/<[^>]+>/g, "").trim();
      if (!plain || plain === lastLine) continue;
      lastLine = plain;
      if (/<\d{1,2}:\d{2}/.test(line)) {
        let t = start;
        for (const part of line.split(/(<\d{1,2}:\d{2}(?::\d{2})?\.\d{3}>)/)) {
          const ts = /^<([\d:.]+)>$/.exec(part);
          if (ts) t = vttTime(ts[1]);
          else for (const w of part.replace(/<[^>]+>/g, " ").trim().split(/\s+/).filter(Boolean)) out.push({ text: w, t: round(t) });
        }
      } else {
        const words = plain.split(/\s+/);
        words.forEach((w, k) => out.push({ text: w, t: round(start + ((end - start) * k) / words.length) }));
      }
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Token equality used for keyword search (fuzzyMatcher.fuzzyTokenMatch for typo-tolerant search). */
export type TokenMatcher = (spoken: string, wanted: string) => boolean;
/** Exact after normalisation ("five" = "5"), plus simple plurals ("blades" = "blade"). */
export const exactTokenMatch: TokenMatcher = (a, b) => {
  if (a === b) return true;
  // Plural only from a singular that does not already end in "s" ("blade"/"blades", not "brushles"/"brushless").
  const [short, long] = a.length < b.length ? [a, b] : [b, a];
  return short.length >= 3 && !short.endsWith("s") && (long === `${short}s` || long === `${short}es`);
};

export interface KeywordMoment {
  keyword: string;
  /** When the first keyword word is spoken. */
  t: number;
  /** When the last keyword word is spoken. */
  tEnd: number;
  /** About six words either side, for the manifest / review page. */
  context: string;
}

/**
 * Every place the keyword phrase is spoken ("brushless motor" = "brushless" then "motor", hyphens
 * and case ignored). Mentions closer than `minGap` seconds to the previous one are merged.
 */
export function findKeywordMoments(words: CaptionWord[], keyword: string, opts: { matcher?: TokenMatcher; minGap?: number } = {}): KeywordMoment[] {
  const match = opts.matcher ?? exactTokenMatch;
  const minGap = opts.minGap ?? 8;
  // norm() drops punctuation, so "brush-less" and "brushless" both become "brushless".
  const want = keyword.split(/\s+/).map(norm).filter(Boolean);
  if (!want.length) return [];
  const toks = words.map((w) => ({ n: norm(w.text), t: w.t, raw: w.text })).filter((x) => x.n);
  const out: KeywordMoment[] = [];
  for (let i = 0; i < toks.length; i++) {
    // Each keyword word matches one spoken token, or two joined ("brush less" = "brushless").
    let j = i;
    const ok = want.every((w) => {
      if (j < toks.length && match(toks[j].n, w)) return (j += 1), true;
      if (j + 1 < toks.length && match(toks[j].n + toks[j + 1].n, w)) return (j += 2), true;
      return false;
    });
    if (!ok) continue;
    const t = toks[i].t;
    if (out.length && t - out[out.length - 1].t < minGap) continue;
    const context = toks.slice(Math.max(0, i - 6), j + 6).map((x) => x.raw).join(" ");
    out.push({ keyword, t, tEnd: toks[j - 1].t, context });
  }
  return out;
}

/**
 * The clip window for a spoken mention: starts `lead` s before the word (the presenter usually
 * points at the part while naming it), 3-5 s long, inside the video.
 */
export function keywordWindow(m: KeywordMoment, videoDuration: number, opts: { lead?: number; seconds?: number } = {}): Window {
  const len = Math.min(5, Math.max(3, opts.seconds ?? num("KEYWORD_CLIP_SECONDS", 4)));
  const dur = videoDuration > 0 ? videoDuration : m.tEnd + len + 1;
  let start = Math.max(0, m.t - (opts.lead ?? 0.5));
  let end = Math.min(dur, start + len);
  if (end - start < len) start = Math.max(0, end - len);
  end = Math.min(dur, start + len);
  return { start: round(start), end: round(end), feature: m.keyword, keyword: m.keyword, caption: m.context };
}

export interface KeywordHarvestOpts {
  brand: string;
  model: string;
  /** The spec to show ("brushless motor"). */
  keyword: string;
  /** Other ways the narration may say it ("brush-less", "bl motor"). */
  aliases?: string[];
  category?: string;
  otherModels?: string[];
  maxVideos?: number;
  /** Spoken mentions used per video. */
  maxPerVideo?: number;
  matcher?: TokenMatcher;
  force?: boolean;
  /** CLIP filter profile (default handson: spec close-ups often show hands on the part). */
  profile?: ScoringProfile;
  log?: (m: string) => void;
}

export async function fetchCaptions(url: string): Promise<{ words: CaptionWord[]; kind: string; duration: number } | null> {
  const r = await py("captions", { url }, 2 * 60_000);
  if (!r.ok || typeof r.data !== "string") return null;
  try {
    const words = r.ext === "json3" ? parseJson3(r.data) : parseVtt(r.data);
    return words.length ? { words, kind: String(r.kind), duration: Number(r.duration) || 0 } : null;
  } catch {
    return null;
  }
}

/**
 * Keyword harvest: exact-model videos -> their captions -> every spoken mention of the keyword ->
 * only a 3-5 s window around each mention is downloaded -> same cut / CLIP / vault pipeline.
 * Vault items carry `keyword` and `caption`, so scenes about that spec can pick them.
 */
export async function harvestKeyword(o: KeywordHarvestOpts): Promise<HarvestResult> {
  const log = o.log ?? (() => {});
  const brand = o.brand.trim();
  const model = o.model.trim();
  const keyword = o.keyword.trim().toLowerCase();
  if (!brand || !model || !keyword) throw new Error("brand, model and keyword are required");
  const ctx = openVault(brand, model, (o.category ?? "lawn mower").trim(), [keyword], log, o.force, o.profile ?? "handson");
  const keywordQueries = (b: string, m: string) => [`"${b} ${m}" ${keyword}`, `"${b} ${m}" review`, `"${b} ${m}" ${keyword} close up`];
  const videos = await searchModelVideos(ctx, keywordQueries(brand, model), o.otherModels, o.maxVideos ?? num("KEYWORD_MAX_VIDEOS", 5), keywordQueries);
  const phrases = [keyword, ...(o.aliases ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean)];
  let added = 0;
  let videosUsed = 0;
  for (const v of videos) {
    const cap = await fetchCaptions(v.url);
    if (!cap) {
      log(`[harvest] "${v.title}": no captions, skipped`);
      continue;
    }
    const moments = phrases.flatMap((p) => findKeywordMoments(cap.words, p, { matcher: o.matcher ?? fuzzyTokenMatch })).sort((a, b) => a.t - b.t);
    const windows: Window[] = [];
    for (const m of moments) {
      const w = { ...keywordWindow(m, cap.duration || v.duration), keyword };
      if (!windows.some((x) => w.start < x.end && w.end > x.start)) windows.push(w);
      if (windows.length >= (o.maxPerVideo ?? 3)) break;
    }
    log(`[harvest] "${v.title}" (${cap.kind} captions): "${keyword}" spoken ${moments.length}x -> ${windows.length} clip window(s)${windows.length ? ` at ${windows.map((w) => `${Math.round(w.start)}s`).join(", ")}` : ""}`);
    if (!windows.length) continue;
    const n = await processWindows(ctx, v, windows);
    added += n;
    if (n) videosUsed++;
  }
  closeVault(ctx);
  log(`[harvest] ${brand} ${model} "${keyword}": +${added} shot(s) from ${videosUsed} video(s) -> ${ctx.dir}`);
  return { dir: ctx.dir, manifest: ctx.manifest, added, videosUsed };
}

/** Vault items cut around a keyword (or tagged with it as a feature) for one product. */
export function findKeywordItems(productName: string, keyword: string, root = VAULT_ROOT): { dir: string; items: VaultItem[] } | null {
  const v = findVaultFor(productName, root);
  if (!v) return null;
  const k = keyword.trim().toLowerCase();
  const items = v.manifest.items.filter((i) => i.keyword === k || i.feature === k);
  return items.length ? { dir: v.dir, items } : null;
}

/**
 * Vault clips as verified product-pool shots (product_pool.json), so the timeline's pacing engine
 * cuts each product chapter from several real exact-model shots instead of looping one clip.
 */
export function vaultPoolShots(products: string[], root = VAULT_ROOT): PoolShot[] {
  const out: PoolShot[] = [];
  for (const name of products) {
    const v = findVaultFor(name, root);
    if (!v) continue;
    const stills = new Map(v.manifest.items.filter((i) => i.kind === "image").map((i) => [i.id.replace(/_i$/, ""), path.join(v.dir, i.file)]));
    for (const it of v.manifest.items.filter((i) => i.kind === "video" && fs.existsSync(path.join(v.dir, i.file)))) {
      const still = stills.get(it.id.replace(/_v$/, ""));
      out.push({
        id: `vault_${it.id}`,
        product: name,
        path: path.join(v.dir, it.file),
        url: it.url,
        author: it.channel,
        license: vaultLicense(it, v.manifest.brand),
        duration: it.duration ?? it.end - it.start,
        imgSim: it.clipPositive,
        textSim: it.clipPositive,
        sceneSim: {},
        frames: still && fs.existsSync(still) ? [still] : [],
        shotType: it.feature ? "closeup" : "field",
        srcStart: it.start,
        verified: true,
        ...(it.keyword || it.feature ? { keyword: it.keyword ?? it.feature! } : {}),
      });
    }
  }
  return out;
}

/** A vault item as a swap / pick candidate (source "youtube_exact_model"). */
export function vaultCandidate(dir: string, m: Pick<VaultManifest, "brand" | "model">, it: VaultItem): Candidate {
  return {
    source: "youtube_exact_model",
    id: `vault_${it.id}`,
    kind: it.kind,
    location: path.join(dir, it.file),
    pageUrl: it.url,
    license: vaultLicense(it, m.brand),
    author: it.channel,
    width: it.width,
    height: it.height,
    duration: it.duration,
    score: it.clipPositive,
    tags: `${m.brand} ${m.model} ${it.feature ?? ""} ${it.title}`.trim(),
    frames: it.kind === "image" ? [path.join(dir, it.file)] : [],
    // Served by the web server (GET /api/vaults/<vault>/thumb/<item>) for the review page.
    thumbUrl: `/api/vaults/${encodeURIComponent(path.basename(dir))}/thumb/${encodeURIComponent(it.id)}`,
  };
}

/**
 * Review-page search under the exact-model policy: vault items whose model, brand, feature or
 * source title match the typed words (a model name alone lists that model's whole vault).
 */
export function searchVaults(query: string, root = VAULT_ROOT): Candidate[] {
  const words = normText(query).split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  const out: Candidate[] = [];
  for (const v of listVaults(root)) {
    const modelHit = titleHasModel(query, v.manifest.model);
    for (const it of v.manifest.items) {
      const hay = normText(`${v.manifest.brand} ${v.manifest.model} ${it.feature ?? ""} ${it.title}`);
      if (modelHit || (words.length && words.every((w) => hay.includes(w)))) out.push(vaultCandidate(v.dir, v.manifest, it));
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * Re-checks every clip already in a vault with the current prompts / thresholds (e.g. after raising
 * HARVEST_MARGIN) and deletes the ones that no longer pass. Nothing is downloaded.
 */
export async function rescoreVault(brand: string, model: string, log: (m: string) => void = () => {}): Promise<{ checked: number; removed: number }> {
  const dir = vaultDir(brand, model);
  const m = readVault(dir);
  const ff = ffmpegPath();
  if (!m || !ff) throw new Error(`no vault for ${brand} ${model}`);
  const work = path.join(dir, "_work");
  fs.mkdirSync(work, { recursive: true });
  const clips = m.items.filter((i) => i.kind === "video" && fs.existsSync(path.join(dir, i.file)));
  const frames = new Map<string, string>();
  for (const c of clips) {
    const f = path.join(work, `${c.id}.jpg`);
    const r = await run(ff, ["-v", "error", "-y", "-ss", ((c.duration ?? 2) / 2).toFixed(2), "-i", path.join(dir, c.file), "-frames:v", "1", "-q:v", "3", f], { timeoutMs: 60_000 });
    if (r.code === 0 && fs.existsSync(f)) frames.set(c.id, f);
  }
  // Each clip is judged with the profile it was harvested under (older items: machine).
  const profileOf = (c: VaultItem): ScoringProfile => c.profile ?? "machine";
  const scores = new Map<string, ShotScore>();
  for (const profile of ["machine", "handson"] as ScoringProfile[]) {
    const group = new Map([...frames].filter(([id]) => profileOf(clips.find((c) => c.id === id)!) === profile));
    if (!group.size) continue;
    const got = await scoreShots(group, promptSet(profile, m.brand, m.model, m.category, m.features), work);
    if (!got) throw new Error("CLIP scoring failed");
    for (const [k, v] of got) scores.set(k, v);
  }
  const drop = new Set<string>();
  for (const c of clips) {
    const sc = scores.get(c.id);
    if (!sc) continue;
    const th = thresholdsFor(profileOf(c));
    for (const it of m.items.filter((i) => i.id.replace(/_[vi]$/, "") === c.id.replace(/_v$/, ""))) [it.clipPositive, it.clipNegative] = [sc.pos, sc.neg];
    const v = judge(sc, th);
    if (v !== "keep") {
      drop.add(c.id.replace(/_v$/, ""));
      if (v === "talking_head") m.stats.talkingHeads++;
      else m.stats.offTopic++;
      m.stats.kept--;
    }
  }
  for (const it of m.items.filter((i) => drop.has(i.id.replace(/_[vi]$/, "")))) fs.rmSync(path.join(dir, it.file), { force: true });
  m.items = m.items.filter((i) => !drop.has(i.id.replace(/_[vi]$/, "")));
  fs.rmSync(work, { recursive: true, force: true });
  writeVault(dir, m);
  log(`[harvest] rescored ${clips.length} clip(s) of ${m.brand} ${m.model}: removed ${drop.size}`);
  return { checked: clips.length, removed: drop.size };
}
