import fs from "node:fs";
import path from "node:path";
import { run } from "../exec.js";
import type { Niche } from "../niche.js";
import type { Scene } from "../scenes.js";
import { ffmpegPath, ffprobePath } from "../tools.js";
import { downloadCandidate, genericStockAllowed, nicheProviders, searchProvider } from "./sources.js";
import { searchVaults } from "../agents/youtube/ytExtractor.js";
import type { Asset, Assets, Candidate } from "./types.js";
import { writeLedger } from "./licenseLedger.js";

/** A swap option shown in the review page. */
export interface SavedCandidate extends Candidate {
  /** CLIP similarity to the scene, when it was scored. */
  match?: number;
  query?: string;
}
export type CandidateFile = Record<string, SavedCandidate[]>;

const csv = (v: unknown) => {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** license_log.csv: one row per scene, so every frame of the video is traceable. */
export function writeLicenseLog(dir: string, scenes: Scene[], assets: Assets): void {
  const rows = [["scene_id", "start", "end", "source", "license", "url", "author", "path", "query", "note", "logged_at"].join(",")];
  const now = new Date().toISOString();
  for (const s of scenes) {
    const a = assets[String(s.id)];
    rows.push([s.id, s.start, s.end, a.source, a.license, a.url, a.author, a.path, a.query, a.note, now].map(csv).join(","));
  }
  fs.writeFileSync(path.join(dir, "license_log.csv"), rows.join("\n") + "\n");
}

/** Review-page thumbnail for a scene's asset. */
export async function makeThumb(dir: string, sceneId: number, a: Asset): Promise<string | undefined> {
  const ff = ffmpegPath();
  if (!ff) return undefined;
  const thumbs = path.join(dir, "thumbs");
  fs.mkdirSync(thumbs, { recursive: true });
  const out = path.join(thumbs, `scene_${String(sceneId).padStart(3, "0")}.jpg`);
  const seek = a.kind === "video" ? ["-ss", String((a.in ?? 0) + 1)] : [];
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", ...seek, "-i", a.path, "-frames:v", "1", "-vf", "scale=384:-2", out]);
  return r.code === 0 ? out : undefined;
}

const overridesFile = (dir: string) => path.join(dir, "overrides.json");

/** Manual swaps from the review page; re-applied whenever the assets step runs again. */
export function loadOverrides(dir: string): Assets {
  const f = overridesFile(dir);
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) : {};
}

export function applyOverrides(dir: string, assets: Assets): number {
  let n = 0;
  for (const [id, a] of Object.entries(loadOverrides(dir))) {
    if (assets[id] && fs.existsSync(a.path)) {
      assets[id] = a;
      n++;
    }
  }
  return n;
}

export function saveCandidates(dir: string, c: CandidateFile): void {
  fs.writeFileSync(path.join(dir, "candidates.json"), JSON.stringify(c));
}

export function loadCandidates(dir: string): CandidateFile {
  const f = path.join(dir, "candidates.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
}

/**
 * Search for the review page ("find other footage for this scene"). Under the exact-model policy it
 * searches the model vaults (verified exact-model YouTube clips) instead of stock sites.
 */
export async function searchAlternatives(query: string, niche: Niche): Promise<SavedCandidate[]> {
  const found: Candidate[] = searchVaults(query);
  if (!genericStockAllowed()) return found.slice(0, 40).map((c) => ({ ...c, query, match: c.score }));
  for (const p of nicheProviders(niche)) found.push(...(await searchProvider(p, query, niche).catch(() => [])));
  return found.slice(0, 30).map((c) => ({ ...c, query }));
}

/**
 * Swaps one scene's asset: downloads the chosen candidate if needed, updates assets.json,
 * overrides.json (so the swap survives a re-run), the thumbnail and license_log.csv.
 */
export async function applyCandidate(dir: string, sceneId: number, cand: SavedCandidate, note = "Swapped in the review page"): Promise<Asset> {
  const scenes = JSON.parse(fs.readFileSync(path.join(dir, "scenes.json"), "utf8")) as Scene[];
  const assets = JSON.parse(fs.readFileSync(path.join(dir, "assets.json"), "utf8")) as Assets;
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) throw new Error(`no scene ${sceneId}`);

  const file = await downloadCandidate(cand);
  if (!fs.existsSync(file)) throw new Error("candidate file is missing");

  const len = scene.end - scene.start;
  const room = cand.duration ? Math.max(0, cand.duration - len - 0.5) : 0;
  const asset: Asset = {
    path: file,
    source: cand.source,
    license: cand.license,
    url: cand.pageUrl,
    kind: cand.kind,
    author: cand.author,
    width: cand.width,
    height: cand.height,
    duration: cand.duration,
    in: cand.kind === "video" && room > 0 ? 0.5 : 0,
    query: cand.query ?? scene.queries[0],
    note,
    ...(cand.match !== undefined ? { match: cand.match } : {}),
  };
  asset.thumb = await makeThumb(dir, sceneId, asset);
  assets[String(sceneId)] = asset;
  fs.writeFileSync(path.join(dir, "assets.json"), JSON.stringify(assets, null, 1));

  const overrides = loadOverrides(dir);
  overrides[String(sceneId)] = asset;
  fs.writeFileSync(overridesFile(dir), JSON.stringify(overrides, null, 1));
  writeLicenseLog(dir, scenes, assets);
  writeLedger(dir, scenes, assets);
  return asset;
}

const VIDEO_EXT = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv"]);
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp"]);

/**
 * Manual clip replacement: the user's own file (already saved under the project) becomes the scene's
 * asset. Logged as own media with the user's source note, so the licence ledger stays complete.
 */
export async function applyManualFile(dir: string, sceneId: number, file: string, sourceNote: string): Promise<Asset> {
  const ext = path.extname(file).toLowerCase();
  const kind = VIDEO_EXT.has(ext) ? "video" : IMAGE_EXT.has(ext) ? "image" : null;
  if (!kind) throw new Error("use a video (mp4, mov, m4v, webm, mkv) or photo (jpg, png, webp)");
  const fp = ffprobePath();
  const probe = fp ? await run(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]) : null;
  const info = probe?.code === 0 ? JSON.parse(probe.stdout) : null;
  if (!info?.streams?.length) throw new Error("the file is not a readable video or image (ffprobe failed)");
  const cand: SavedCandidate = {
    source: "local",
    id: `manual_${sceneId}_${Date.now().toString(36)}`,
    kind,
    location: file,
    pageUrl: "",
    license: `Own media (manual upload) - ${sourceNote.trim().slice(0, 300)}`,
    width: Number(info.streams[0].width) || 1920,
    height: Number(info.streams[0].height) || 1080,
    ...(kind === "video" && Number(info.format?.duration) ? { duration: Number(info.format.duration) } : {}),
    score: 0,
  };
  const asset = await applyCandidate(dir, sceneId, cand, "Manual replacement (your file)");
  asset.modelCheck = "match"; // the user picked this file for this scene
  const assets = JSON.parse(fs.readFileSync(path.join(dir, "assets.json"), "utf8")) as Assets;
  assets[String(sceneId)] = asset;
  fs.writeFileSync(path.join(dir, "assets.json"), JSON.stringify(assets, null, 1));
  const overrides = loadOverrides(dir);
  overrides[String(sceneId)] = asset;
  fs.writeFileSync(overridesFile(dir), JSON.stringify(overrides, null, 1));
  return asset;
}
