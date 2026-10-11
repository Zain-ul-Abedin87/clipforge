import fs from "node:fs";
import path from "node:path";
import { run } from "../exec.js";
import type { Niche } from "../niche.js";
import type { Scene } from "../scenes.js";
import { ffmpegPath } from "../tools.js";
import { downloadCandidate, nicheProviders, searchProvider } from "./sources.js";
import type { Asset, Assets, Candidate } from "./types.js";

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

/** Stock search for the review page ("find other footage for this scene"). */
export async function searchAlternatives(query: string, niche: Niche): Promise<SavedCandidate[]> {
  const found: Candidate[] = [];
  for (const p of nicheProviders(niche)) found.push(...(await searchProvider(p, query, niche).catch(() => [])));
  return found.slice(0, 30).map((c) => ({ ...c, query }));
}

/**
 * Swaps one scene's asset: downloads the chosen candidate if needed, updates assets.json,
 * overrides.json (so the swap survives a re-run), the thumbnail and license_log.csv.
 */
export async function applyCandidate(dir: string, sceneId: number, cand: SavedCandidate): Promise<Asset> {
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
    note: "Swapped in the review page",
    ...(cand.match !== undefined ? { match: cand.match } : {}),
  };
  asset.thumb = await makeThumb(dir, sceneId, asset);
  assets[String(sceneId)] = asset;
  fs.writeFileSync(path.join(dir, "assets.json"), JSON.stringify(assets, null, 1));

  const overrides = loadOverrides(dir);
  overrides[String(sceneId)] = asset;
  fs.writeFileSync(overridesFile(dir), JSON.stringify(overrides, null, 1));
  writeLicenseLog(dir, scenes, assets);
  return asset;
}
