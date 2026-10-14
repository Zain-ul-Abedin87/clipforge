import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { venvPythonPath } from "../tools.js";
import type { Scene } from "../scenes.js";
import type { Niche } from "../niche.js";
import { slug } from "./presskit.js";
import type { Candidate } from "./types.js";
import { downloadWebCrawl, searchWebCrawl, webCrawlEnabled } from "./webCrawl.js";
import { verifyCandidates, visionVerifyEnabled } from "../agent/visionVerify.js";
import { filterPoolByShotQa } from "./shotQa.js";

/**
 * Product-locked footage pool (assets step). For every product the planner named, the web_crawl
 * worker searches "<name> review" / "range test" / "official", splits the low-res previews into
 * shots and CLIP scores every shot twice: image-to-image against the product's own photos (press
 * kit / official) and text-to-image against a "<name> <category>" line plus the narration of the
 * product's scenes. Only shots that look like that exact product pass (optionally confirmed by
 * Claude), several uploaders are mixed (capped per uploader), and the chosen shots are fetched in
 * HD (partial download). Result: <project>/product_pool.json, used by the timeline's pacing engine.
 */

export interface PoolShot {
  id: string;
  product: string;
  path: string;
  url: string;
  author?: string;
  license: string;
  /** Usable seconds in the HD file (from 0). */
  duration: number;
  imgSim: number;
  textSim: number;
  /** CLIP text similarity to each scene of the product ("sceneId" -> sim), for the timeline. */
  sceneSim: Record<string, number>;
  frames: string[];
  /** CLIP zero-shot shot type (closeup, field, handson, lifestyle, promo, amazon, talking). */
  shotType?: ShotType;
  /** Where this shot starts in the source video (s), for the whole-video footage ledger. */
  srcStart?: number;
  /** Per-frame motion share (python/motion_score.py, 10 fps) from shot QA; pacing avoids static windows. */
  motion?: number[];
  motionFps?: number;
  /** Shot-QA CLIP label of the first shot in the file. */
  qaLabel?: string;
}

export type ShotType = "closeup" | "field" | "handson" | "lifestyle" | "promo" | "amazon" | "talking";

/** Zero-shot prompts per shot type (channel study rules_v3 source mix categories). */
function typeTexts(name: string, category: string): Record<ShotType, string> {
  const c = category || "product";
  return {
    closeup: category === "pistol" ? `extreme close-up macro shot of a pistol's slide, grip texture and sights filling the frame, on a table` : `close-up detail shot of a ${c} on a table`,
    field: category === "pistol" ? `person shooting a pistol at an outdoor shooting range` : `${c} being used outdoors in the field`,
    handson: `a person's hands holding and operating a ${c}, arms and body visible`,
    lifestyle: `person using a ${c} in everyday life at home`,
    promo: `official promotional advertisement for ${name}, studio lighting`,
    amazon: `${c} product photo on a white background, online store listing`,
    talking: `a person talking to the camera, youtuber face`,
  };
}

export interface PoolConfig {
  enabled: boolean;
  target: number;
  maxPerUploader: number;
  maxShotSec: number;
  queries: string[];
  category: string;
  imgMin: number;
  /** Fewest shots worth keeping a pool for (below: the product falls back to its scene clips). */
  minTarget: number;
  /** Wanted shot-type mix (relative weights). */
  mix: Partial<Record<ShotType, number>>;
  dropTypes: ShotType[];
  closeupBias: number;
  closeupShare: number;
  closeupMargin: number;
}

export function poolConfig(niche: Niche): PoolConfig {
  const p = ((niche as unknown as { productPool?: Partial<PoolConfig> }).productPool ?? {}) as Partial<PoolConfig>;
  return {
    enabled: env("PRODUCT_POOL", p.enabled === false ? "off" : p.enabled ? "on" : "off").toLowerCase() !== "off",
    target: Number(env("PRODUCT_POOL_TARGET", String(p.target ?? 24))),
    maxPerUploader: Number(env("PRODUCT_POOL_PER_UPLOADER", String(p.maxPerUploader ?? 6))),
    maxShotSec: p.maxShotSec ?? 3,
    queries: p.queries ?? ["{name} review", "{name} range test", "{name} official"],
    category: p.category ?? "",
    imgMin: Number(env("PRODUCT_IMG_MIN", String(p.imgMin ?? 0.72))),
    minTarget: p.minTarget ?? 12,
    closeupBias: p.closeupBias ?? 0.012,
    closeupShare: p.closeupShare ?? 0.35,
    closeupMargin: p.closeupMargin ?? 0.03,
    mix: p.mix ?? {},
    dropTypes: p.dropTypes ?? ["talking"],
  };
}

const cos = (a: number[], b: number[]) => {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) (s += a[i] * b[i]), (na += a[i] * a[i]), (nb += b[i] * b[i]);
  return s / Math.sqrt(na * nb || 1);
};

function productPhotos(channel: string, product: string): string[] {
  const dir = path.join(paths.channels, channel, "presskit", slug(product));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort().map((f) => path.join(dir, f));
}

/** Scene ids per product: from its first named scene up to the next product's first scene (cards excluded). */
export function productRegions(scenes: Scene[]): Map<string, Scene[]> {
  const firsts: { name: string; idx: number }[] = [];
  scenes.forEach((s, i) => {
    if (s.product_name && !firsts.some((f) => f.name === s.product_name)) firsts.push({ name: s.product_name, idx: i });
  });
  const out = new Map<string, Scene[]>();
  firsts.forEach((f, k) => {
    const end = k + 1 < firsts.length ? firsts[k + 1].idx : scenes.length;
    // A card right before the next product's first scene introduces that product.
    let stop = end;
    while (stop - 1 > f.idx && scenes[stop - 1].type === "graphic" && !scenes[stop - 1].product_name) stop--;
    out.set(f.name, scenes.slice(f.idx, stop));
  });
  return out;
}

async function clipJob(job: unknown, log: (m: string) => void): Promise<{ scores: Record<string, number>; image_embeddings?: Record<string, number[]> } | null> {
  const py = venvPythonPath();
  if (!py) return null;
  const tmp = path.join(paths.root, "cache", "clip");
  fs.mkdirSync(tmp, { recursive: true });
  const jobFile = path.join(tmp, "pool_job.json");
  const outFile = path.join(tmp, "pool_scores.json");
  fs.writeFileSync(jobFile, JSON.stringify(job));
  fs.rmSync(outFile, { force: true });
  const r = await run(py, [path.join(paths.python, "clip_score.py"), "--job", jobFile, "--out", outFile, "--models-dir", path.join(paths.root, "models", "fastembed")], { timeoutMs: 900_000 });
  if (r.code !== 0 || !fs.existsSync(outFile)) {
    log(`[pool] CLIP failed: ${r.stderr.trim().split("\n").pop()?.slice(0, 160)}`);
    return null;
  }
  return JSON.parse(fs.readFileSync(outFile, "utf8"));
}

export async function buildProductPools(scenes: Scene[], dir: string, channel: string, niche: Niche, log: (m: string) => void): Promise<number> {
  const cfg = poolConfig(niche);
  if (!cfg.enabled) return 0;
  if (!webCrawlEnabled()) {
    log("[pool] product pool off: web crawl is not available");
    return 0;
  }
  const outFile = path.join(dir, "product_pool.json");
  const regions = productRegions(scenes);
  const all: PoolShot[] = [];
  for (const [name, region] of regions) {
    const t0 = Date.now();
    const refs = productPhotos(channel, name);
    // Pool cache: same product, config and reference photos -> reuse (re-runs take seconds, not ~28 min).
    const key = crypto.createHash("sha1").update(JSON.stringify({ name, cfg, refs: refs.map((r) => [path.basename(r), fs.statSync(r).size]), v: "pool-4" })).digest("hex").slice(0, 10);
    const cacheFile = path.join(paths.root, "cache", "pools", `${slug(name)}_${key}.json`);
    if (env("POOL_CACHE", "on").toLowerCase() !== "off" && fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as PoolShot[];
      if (cached.length && cached.every((p) => fs.existsSync(p.path))) {
        all.push(...cached);
        log(`[pool] ${name}: ${cached.length} shot(s) from cache ${path.basename(cacheFile)}`);
        continue;
      }
    }
    const cands = new Map<string, Candidate>();
    for (const q of cfg.queries.map((x) => x.replace("{name}", name))) {
      try {
        for (const c of await searchWebCrawl(q)) if (!cands.has(c.id)) cands.set(c.id, c);
      } catch (err) {
        log(`[pool] ${name}: search "${q}" failed: ${String(err).slice(0, 120)}`);
      }
    }
    // Real shot length (webCrawl.ts sets shotLen); long uncut shots give two pool entries.
    const shots: Candidate[] = [];
    for (const c of cands.values()) {
      if (!(c.frames ?? []).some((f) => fs.existsSync(f))) continue;
      const len = (c as Candidate & { shotLen?: number }).shotLen ?? c.duration ?? cfg.maxShotSec;
      if (len < 1.5) continue;
      shots.push(Object.assign({ ...c }, { shotLen: Math.min(len, 6) }));
      if (len >= 7) shots.push(Object.assign({ ...c, id: `${c.id}_b`, shotStart: (c.shotStart ?? 0) + len / 2, frames: (c.frames ?? []).slice(-2) }, { shotLen: len / 2 - 0.3 }));
    }
    log(`[pool] ${name}: ${shots.length} shots from ${new Set(shots.map((c) => c.pageUrl)).size} videos, ${refs.length} reference photo(s)`);
    if (!shots.length) continue;
    const body = region.filter((s) => s.type !== "graphic");
    const texts: Record<string, string> = { product: `${name} ${cfg.category}`.trim() };
    for (const s of body) texts[`s${s.id}`] = `${name} ${cfg.category}. ${s.text.split(/\s+/).slice(0, 20).join(" ")}`;
    const tt = typeTexts(name, cfg.category);
    for (const [k, v] of Object.entries(tt)) texts[`type_${k}`] = v;
    const images: Record<string, string | string[]> = {};
    for (const c of shots) images[c.id] = (c.frames ?? []).filter((f) => fs.existsSync(f)).slice(0, 3);
    refs.forEach((r, k) => (images[`ref${k}`] = r));
    const pairs = shots.flatMap((c) => Object.keys(texts).map((t) => [t, c.id]));
    const res = await clipJob({ texts, images, pairs, return_image_embeddings: true }, log);
    if (!res) continue;
    const emb = res.image_embeddings ?? {};
    const refEmb = refs.map((_, k) => emb[`ref${k}`]).filter(Boolean);
    type Scored = { c: Candidate; img: number; txt: number; score: number; type: ShotType };
    const types = Object.keys(tt) as ShotType[];
    const scored: Scored[] = shots.map((c) => {
      const e = emb[c.id];
      const img = e && refEmb.length ? Math.max(...refEmb.map((r) => cos(e, r))) : 0;
      const txt = res.scores[`product|${c.id}`] ?? 0;
      // Close-ups lose narrowly to "hands" whenever a finger is in frame; give them a small edge.
      const bias = (k: ShotType) => (res.scores[`type_${k}|${c.id}`] ?? 0) + (k === "closeup" ? cfg.closeupBias : 0);
      const type = types.reduce((b, k) => (bias(k) > bias(b) ? k : b), types[0]);
      return { c, img, txt, score: refEmb.length ? img + 0.5 * txt : txt, type };
    });
    // CLIP almost never ranks "close-up" first in absolute terms, so also label close-ups
    // relatively: shots whose close-up score is highest relative to their best other type (top
    // closeupShare of the non-talking shots, within closeupMargin of the winner).
    const cuGap = (c: Candidate) => (res.scores[`type_closeup|${c.id}`] ?? 0) - Math.max(...types.filter((k) => k !== "closeup" && k !== "talking").map((k) => res.scores[`type_${k}|${c.id}`] ?? 0));
    const cand = scored.filter((x) => x.type !== "talking" && x.type !== "closeup").sort((x, y) => cuGap(y.c) - cuGap(x.c));
    const nCu = Math.round(scored.length * cfg.closeupShare) - scored.filter((x) => x.type === "closeup").length;
    let relabeled = 0;
    for (const x of cand.slice(0, Math.max(0, nCu))) if (cuGap(x.c) > -cfg.closeupMargin) (x.type = "closeup"), relabeled++;
    const gaps = cand.map((x) => cuGap(x.c)).sort((p, q) => q - p);
    log(`[pool] ${name}: close-up gap p10 ${(gaps[Math.floor(gaps.length * 0.1)] ?? 0).toFixed(3)} / p50 ${(gaps[Math.floor(gaps.length * 0.5)] ?? 0).toFixed(3)}, ${relabeled} relabeled close-up`);
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0]?.img ?? 0;
    // Exact product: close to its photo (absolute floor, and not far below the best shot found).
    // Range/handling shots score well below a white-background packshot, so the CLIP floor is a
    // loose pre-filter; Claude (below) is the exact-model check.
    const imgFloor = refEmb.length ? Math.min(cfg.imgMin, Math.max(0.6, best - 0.2)) : 0;
    const txtFloor = 0.18;
    const dropped = scored.filter((s) => cfg.dropTypes.includes(s.type)).length;
    let passed = scored.filter((s) => s.img >= imgFloor && s.txt >= txtFloor && !cfg.dropTypes.includes(s.type));
    if (dropped) log(`[pool] ${name}: ${dropped} talking-head/dropped-type shot(s) removed`);
    log(`[pool] ${name}: CLIP img sim best ${best.toFixed(3)}, floor ${imgFloor.toFixed(3)} -> ${passed.length}/${scored.length} pass`);

    // Near-duplicates (same shot found twice / static shots) and uploader cap.
    const chosen: Scored[] = [];
    const perUp = new Map<string, number>();
    for (const s of passed) {
      if (chosen.length >= cfg.target * 2) break;
      const up = s.c.author ?? s.c.pageUrl;
      if ((perUp.get(up) ?? 0) >= cfg.maxPerUploader) continue;
      const e = emb[s.c.id];
      if (e && chosen.some((x) => emb[x.c.id] && cos(emb[x.c.id], e) > 0.96)) continue;
      chosen.push(s);
      perUp.set(up, (perUp.get(up) ?? 0) + 1);
    }

    // Optional Claude confirm: does the shot clearly show this product?
    if (visionVerifyEnabled() && env("PRODUCT_VISION", "on").toLowerCase() !== "off" && chosen.length) {
      const text = `Footage that clearly shows the ${name} ${cfg.category} itself (shooting it, handling it, or a close-up of it). A different gun model, a person talking to camera, packaging only, or no gun = fits false.`;
      const items = [];
      for (let k = 0; k < chosen.length; k += 4)
        items.push({ sceneId: 9000 + k, text, before: "", cands: chosen.slice(k, k + 4).map((s) => ({ id: s.c.id, frames: (s.c.frames ?? []).slice(0, 3) })) });
      const verdict = await verifyCandidates(items, `${name} review`, path.join(dir, "vision_pool.json"), log);
      const before = chosen.length;
      const keep = chosen.filter((s, i) => verdict.get(`${9000 + Math.floor(i / 4) * 4}|${s.c.id}`) !== false);
      log(`[pool] ${name}: Claude confirmed ${keep.length}/${before}`);
      chosen.splice(0, chosen.length, ...keep);
    }
    // Shot-type mix: fill by the niche's weights (largest deficit first), then top up by score.
    const wsum = Object.values(cfg.mix).reduce((a, b) => a + (b ?? 0), 0);
    if (wsum > 0) {
      const picked: Scored[] = [];
      const cnt = new Map<ShotType, number>();
      const left = [...chosen];
      while (picked.length < cfg.target && left.length) {
        const need = (k: ShotType) => (cfg.mix[k] === undefined ? -2 : 0) + ((cfg.mix[k] ?? 0) / wsum) * (picked.length + 1) - (cnt.get(k) ?? 0);
        let bi = 0;
        for (let k = 1; k < left.length; k++) if (need(left[k].type) > need(left[bi].type) + 1e-9) bi = k;
        const [x] = left.splice(bi, 1);
        picked.push(x);
        cnt.set(x.type, (cnt.get(x.type) ?? 0) + 1);
      }
      chosen.splice(0, chosen.length, ...picked);
    }
    chosen.splice(cfg.target);
    const mixLog = chosen.reduce<Record<string, number>>((m, x) => ((m[x.type] = (m[x.type] ?? 0) + 1), m), {});
    log(`[pool] ${name}: shot types ${JSON.stringify(mixLog)}${chosen.length < cfg.minTarget ? ` (below min ${cfg.minTarget})` : ""}`);

    // HD: only the shot itself (<= maxShotSec + a little), partial download.
    let ok = 0;
    for (const s of chosen) {
      const c = s.c;
      const shotLen = (c as Candidate & { shotLen?: number }).shotLen ?? cfg.maxShotSec;
      const secs = Math.max(1.5, Math.min(shotLen, cfg.maxShotSec + 1));
      const id = `pool_${crypto.createHash("sha1").update(`${c.id}|${secs}`).digest("hex").slice(0, 12)}`;
      try {
        const file = await downloadWebCrawl({ ...c, id, duration: secs });
        ok++;
        const sceneSim: Record<string, number> = {};
        for (const sc of body) sceneSim[String(sc.id)] = res.scores[`s${sc.id}|${c.id}`] ?? 0;
        all.push({ id, product: name, path: file, url: c.pageUrl, author: c.author, license: c.license, duration: secs, imgSim: Math.round(s.img * 1000) / 1000, textSim: Math.round(s.txt * 1000) / 1000, sceneSim, frames: c.frames ?? [], shotType: s.type, srcStart: c.shotStart ?? 0 });
      } catch (err) {
        log(`[pool] ${name}: HD fetch failed: ${String(err).slice(0, 120)}`);
      }
    }
    const mine = all.filter((p) => p.product === name);
    const ups = new Set(mine.map((p) => p.author));
    if (mine.length) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(mine, null, 1));
    }
    log(`[pool] ${name}: ${ok} shot(s) in the pool from ${ups.size} uploader(s), ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  // Per-shot QA (PySceneDetect + CLIP + motion): drop talking heads / frozen shots.
  const final = await filterPoolByShotQa(all, cfg.category, log);
  fs.writeFileSync(outFile, JSON.stringify(final, null, 1));
  return final.length;
}

export function readProductPool(dir: string): PoolShot[] {
  const f = path.join(dir, "product_pool.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as PoolShot[]) : [];
}
