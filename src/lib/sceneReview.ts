import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { ffmpegPath } from "./tools.js";
import { readJson, writeJson } from "./project.js";
import type { Scene } from "./scenes.js";
import type { Timeline, TimelineScene } from "../commands/timeline.js";
import { readProductPool, type PoolShot } from "./assets/productPool.js";
import { sourceKey, type SubShot } from "./pacing.js";

/**
 * Scene review before render. After the timeline step the UI lists every scene (time, script
 * line, the sub-shots the pacing engine picked) plus 3-5 unused alternatives from the product
 * pools, ranked by CLIP match to that scene. A swap replaces one sub-shot (same length) in
 * timeline.json and is also saved to review_swaps.json, so a later timeline re-run re-applies it.
 * Only the swapped scene's render segment changes; every other segment comes from the cache.
 */

export interface ReviewShot { index: number; file: string; source: string; seconds: number; shotType?: string; product?: string; reused?: boolean }
export interface ReviewAlt { id: string; file: string; product: string; shotType?: string; match: number; author?: string; seconds: number }
export interface ReviewScene {
  id: number;
  start: number;
  end: number;
  text: string;
  type: string;
  product?: string;
  card: boolean;
  shots: ReviewShot[];
  alternatives: ReviewAlt[];
}
interface Swap { scene: number; shot: number; alt: string; path: string; in: number }

const swapsFile = (dir: string) => path.join(dir, "review_swaps.json");
export const loadSwaps = (dir: string): Swap[] => (fs.existsSync(swapsFile(dir)) ? readJson<Swap[]>(swapsFile(dir)) : []);

function shotsOf(t: TimelineScene): SubShot[] {
  if (t.asset.shots?.length) return t.asset.shots;
  return [{ path: t.asset.path, kind: t.asset.kind as "video" | "image", in: t.asset.in ?? 0, frames: t.endFrame - t.startFrame, source: t.asset.source }];
}

/** Keys of every source file used anywhere in the timeline. */
function usedKeys(tl: Timeline): Set<string> {
  const s = new Set<string>();
  for (const t of tl.scenes) for (const x of shotsOf(t)) s.add(x.key ?? sourceKey(x.path));
  return s;
}

function alternativesFor(sc: Scene, t: TimelineScene, pool: PoolShot[], used: Set<string>, n = 5): ReviewAlt[] {
  const product = t.asset.shots?.find((x) => x.product)?.product ?? sc.product_name;
  const id = String(sc.id);
  const list = pool
    .filter((p) => fs.existsSync(p.path) && !used.has(sourceKey(p.path, p.url)) && !used.has(sourceKey(p.path)))
    .filter((p) => (product ? p.product === product : p.sceneSim?.[id] !== undefined))
    .map((p) => ({ p, m: p.sceneSim?.[id] ?? p.textSim ?? 0 }))
    .sort((a, b) => b.m - a.m);
  // Mix uploaders: max 2 per author in the shortlist.
  const per = new Map<string, number>();
  const out: ReviewAlt[] = [];
  for (const { p, m } of list) {
    const a = p.author ?? "?";
    if ((per.get(a) ?? 0) >= 2) continue;
    per.set(a, (per.get(a) ?? 0) + 1);
    out.push({ id: p.id, file: path.basename(p.path), product: p.product, shotType: p.shotType, match: Math.round(m * 1000) / 1000, author: p.author, seconds: p.duration });
    if (out.length >= n) break;
  }
  return out;
}

export function listReview(dir: string): ReviewScene[] {
  const tl = readJson<Timeline>(path.join(dir, "timeline.json"));
  const scenes = readJson<Scene[]>(path.join(dir, "scenes.json"));
  const pool = readProductPool(dir);
  const used = usedKeys(tl);
  return tl.scenes.map((t) => {
    const sc = scenes.find((s) => s.id === t.id)!;
    const card = !!t.backdrop || t.asset.source === "graphic";
    return {
      id: t.id,
      start: t.start,
      end: t.end,
      text: sc?.text ?? "",
      type: sc?.type ?? "",
      product: sc?.product_name,
      card,
      shots: shotsOf(t).map((x, i) => ({ index: i, file: path.basename(x.path), source: x.source, seconds: Math.round((x.frames / 30) * 100) / 100, shotType: x.shotType, product: x.product, reused: x.reused })),
      alternatives: card || !sc ? [] : alternativesFor(sc, t, pool, used),
    };
  });
}

/** Best start inside a pool clip for `need` seconds: the most moving window when motion is known. */
function bestIn(p: PoolShot, need: number): number {
  const room = Math.max(0, p.duration - need);
  if (!p.motion?.length || !p.motionFps) return 0;
  let best = 0, bestV = -1;
  for (let a = 0; a <= room + 1e-6; a += 0.25) {
    const i0 = Math.floor(a * p.motionFps), i1 = Math.max(i0 + 1, Math.floor((a + need) * p.motionFps));
    const seg = p.motion.slice(i0, i1);
    const v = seg.reduce((s, x) => s + x, 0) / Math.max(1, seg.length);
    if (v > bestV) (bestV = v), (best = a);
  }
  return Math.round(best * 100) / 100;
}

function applyOne(t: TimelineScene, shotIdx: number, p: PoolShot): Swap | null {
  if (!t.asset.shots?.length) t.asset.shots = shotsOf(t);
  const s = t.asset.shots[shotIdx];
  if (!s) return null;
  const need = s.frames / 30;
  const inn = bestIn(p, need);
  t.asset.shots[shotIdx] = { ...s, path: p.path, kind: "video", in: inn, source: "web_crawl", url: p.url, author: p.author, key: sourceKey(p.path, p.url), srcIn: (p.srcStart ?? 0) + inn, product: p.product, shotType: p.shotType, reused: false };
  if (shotIdx === 0) t.asset = { ...t.asset, path: p.path, kind: "video", in: inn };
  return { scene: t.id, shot: shotIdx, alt: p.id, path: p.path, in: inn };
}

export function swapShot(dir: string, sceneId: number, shotIdx: number, altId: string): { ok: true } {
  const file = path.join(dir, "timeline.json");
  const tl = readJson<Timeline>(file);
  const t = tl.scenes.find((x) => x.id === sceneId);
  if (!t) throw new Error("unknown scene");
  const p = readProductPool(dir).find((x) => x.id === altId);
  if (!p || !fs.existsSync(p.path)) throw new Error("unknown or missing alternative");
  const sw = applyOne(t, shotIdx, p);
  if (!sw) throw new Error("unknown shot index");
  writeJson(file, tl);
  const swaps = loadSwaps(dir).filter((x) => !(x.scene === sceneId && x.shot === shotIdx));
  swaps.push(sw);
  writeJson(swapsFile(dir), swaps);
  return { ok: true };
}

/** Called at the end of the timeline step: user swaps survive a re-plan of the timeline. */
export function reapplySwaps(dir: string, tl: TimelineScene[], log: (m: string) => void): void {
  const swaps = loadSwaps(dir);
  if (!swaps.length) return;
  const pool = readProductPool(dir);
  let n = 0;
  for (const s of swaps) {
    const t = tl.find((x) => x.id === s.scene);
    const p = pool.find((x) => x.id === s.alt);
    if (t && p && fs.existsSync(p.path) && applyOne(t, s.shot, p)) n++;
  }
  log(`[review] re-applied ${n}/${swaps.length} manual swap(s)`);
}

/** Small JPEG of a scene's sub-shot or of an alternative (cached in <project>/review_thumbs). */
export async function reviewThumb(dir: string, what: { scene: number; shot: number } | { alt: string }): Promise<string | null> {
  const ff = ffmpegPath();
  if (!ff) return null;
  let src: string, at: number;
  if ("alt" in what) {
    const p = readProductPool(dir).find((x) => x.id === what.alt);
    if (!p) return null;
    if (p.frames?.length && fs.existsSync(p.frames[0])) return p.frames[0];
    (src = p.path), (at = Math.min(1, p.duration / 2));
  } else {
    const tl = readJson<Timeline>(path.join(dir, "timeline.json"));
    const t = tl.scenes.find((x) => x.id === what.scene);
    const s = t && shotsOf(t)[what.shot];
    if (!s) return null;
    (src = s.path), (at = s.kind === "video" ? s.in + Math.min(0.8, s.frames / 60) : 0);
  }
  if (!fs.existsSync(src)) return null;
  if (/\.(jpe?g|png|webp)$/i.test(src)) return src;
  const out = path.join(dir, "review_thumbs", crypto.createHash("sha1").update(`${src}|${at}`).digest("hex").slice(0, 16) + ".jpg");
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(at), "-i", src, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "4", out]);
  return r.code === 0 && fs.existsSync(out) ? out : null;
}
