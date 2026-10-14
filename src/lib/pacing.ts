import type { Scene } from "./scenes.js";
import type { Niche } from "./niche.js";
import { movingShare } from "./assets/shotQa.js";
import type { PoolShot } from "./assets/productPool.js";
import { productRegions } from "./assets/productPool.js";

/**
 * Pacing engine (timeline step). Competitor listicles cut every ~2.4-2.8 s (5-8 spoken words),
 * not once per 4-5 s scene. Every footage scene is split into sub-shots at Whisper word boundaries
 * (aligned.json); product scenes are filled from the product's shot pool (product_pool.json),
 * other scenes use different moments of their own clip. A segment stays one scene, so the render
 * cache and per-scene segments keep working; the renderer concatenates the sub-shots inside it.
 * Config: niche "pacing" {enabled, targetShotSec, minShotSec, maxShotSec}; PACING=off disables.
 */

export interface SubShot {
  path: string;
  kind: "video" | "image";
  in: number;
  /** Frames of this sub-shot inside the scene (sum = scene frames). */
  frames: number;
  source: string;
  url?: string;
  author?: string;
  /** Ledger identity of the source (see sourceKey) and the in-point in source time. */
  key?: string;
  srcIn?: number;
  /** Product whose pool / photos this shot comes from. */
  product?: string;
  shotType?: string;
  /** Set when nothing unused was left and a segment had to repeat. */
  reused?: boolean;
}

export interface PacingConfig {
  enabled: boolean;
  targetShotSec: number;
  minShotSec: number;
  maxShotSec: number;
  /** Channel study: faster cutting in the opening, a bit slower mid/end. */
  openingSec: number;
  openingFactor: number;
  laterFactor: number;
  /** Chapter (product) starts: the first few seconds after each get the opening pace too. */
  chapterStarts?: number[];
}

/** Target shot length at time t (s). */
export function targetAt(cfg: PacingConfig, t: number): number {
  const fresh = t < cfg.openingSec || (cfg.chapterStarts ?? []).some((c) => t >= c && t < c + 6);
  return cfg.targetShotSec * (fresh ? cfg.openingFactor : cfg.laterFactor);
}

export type SentenceType = "hook" | "price" | "product_intro" | "spec" | "use_case" | "verdict" | "other";

/** Rough sentence type (channel study categories) from the narration text. */
export function sentenceType(text: string, isFirstOfProduct: boolean): SentenceType {
  const t = text.toLowerCase();
  if (/\$\s?\d|\b\d+\s?(dollars|bucks)\b|\bprice[ds]?\b|\bmsrp\b|\bcosts?\b|\bunder \$?\d/.test(t)) return "price";
  if (isFirstOfProduct) return "product_intro";
  if (/\b(verdict|overall|bottom line|worth it|recommend|best (choice|pick))\b/.test(t)) return "verdict";
  if (/\b(\d+(\.\d+)?\s?(oz|ounces|inch|inches|mm|rounds?|lbs?|grams?|mah|hz|gb|tb|hours?))\b|\bcapacity\b|\bbarrel\b|\bbattery\b/.test(t)) return "spec";
  if (/\b(carry|daily|perfect for|great for|use it|everyday)\b/.test(t)) return "use_case";
  return "other";
}

export function pacingConfig(niche: Niche, envOff: boolean): PacingConfig {
  const p = ((niche as unknown as { pacing?: Partial<PacingConfig> }).pacing ?? {}) as Partial<PacingConfig>;
  return {
    enabled: !envOff && p.enabled === true,
    targetShotSec: p.targetShotSec ?? 2.8,
    minShotSec: p.minShotSec ?? 1.4,
    maxShotSec: p.maxShotSec ?? 4,
    openingSec: p.openingSec ?? 30,
    openingFactor: p.openingFactor ?? 1,
    laterFactor: p.laterFactor ?? 1,
  };
}

export interface Word {
  word: string;
  start: number;
  end: number;
}

/** Cut times (absolute seconds, excluding scene start/end) snapped to word starts. */
export function cutTimes(start: number, end: number, words: Word[], cfg: PacingConfig, carry?: { v: number }): number[] {
  const len = end - start;
  const target = targetAt(cfg, (start + end) / 2);
  // carry: rounding error from earlier scenes, so ~4 s scenes average out to the target over the video.
  let n = Math.max(1, Math.round((len + (carry?.v ?? 0)) / target + (start < cfg.openingSec ? 0.1 : 0)));
  while (n > 1 && len / n < cfg.minShotSec) n--;
  while (len / n > cfg.maxShotSec) n++;
  if (carry) carry.v = Math.max(-target, Math.min(target, len + carry.v - n * target));
  if (n === 1) return [];
  const inside = words.filter((w) => w.start > start + cfg.minShotSec * 0.8 && w.start < end - cfg.minShotSec * 0.8).map((w) => w.start);
  const cuts: number[] = [];
  let prev = start;
  for (let k = 1; k < n; k++) {
    const ideal = start + (len * k) / n;
    const snap = inside.filter((t) => t - prev >= cfg.minShotSec * 0.8).sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal))[0];
    const t = snap !== undefined && Math.abs(snap - ideal) < target * 0.45 ? snap : ideal;
    if (t - prev < cfg.minShotSec * 0.8 || end - t < cfg.minShotSec * 0.8) continue;
    cuts.push(Math.round(t * 1000) / 1000);
    prev = t;
  }
  return cuts;
}

interface TlScene {
  id: number;
  startFrame: number;
  endFrame: number;
  asset: { path: string; kind: "video" | "image"; source: string; duration?: number; in?: number; shots?: SubShot[] };
  backdrop?: "blur";
  transition: string;
  sfx?: { kind: string; at: number }[];
}

/** Identity of a piece of source footage: the source video (pool shots: page URL) or the file. */
export function sourceKey(path: string, url?: string): string {
  return url ? `url:${url.replace(/[&?]t=\d+s?$/, "")}` : `file:${path.replace(/\\/g, "/").toLowerCase()}`;
}

/**
 * Footage ledger for the whole video: every used source segment (key + [a, b) seconds in the
 * source). Stills occupy the whole file. A segment is free when it does not overlap a used one.
 */
export class ShotLedger {
  used: { key: string; a: number; b: number; scene: number }[] = [];
  forced: string[] = [];
  free(key: string, a: number, b: number): boolean {
    return !this.used.some((u) => u.key === key && a < u.b - 0.05 && b > u.a + 0.05);
  }
  take(key: string, a: number, b: number, scene: number): void {
    this.used.push({ key, a, b, scene });
  }
  /** First free window of length `need` in [0, dur) (step 0.25 s), or undefined. */
  window(key: string, dur: number, need: number, prefer = 0): number | undefined {
    const starts: number[] = [];
    for (let t = 0; t + need <= dur + 0.01; t += 0.25) starts.push(Math.round(t * 100) / 100);
    starts.sort((x, y) => Math.abs(x - prefer) - Math.abs(y - prefer));
    return starts.find((t) => this.free(key, t, t + need));
  }
}

const STILL = 1e6;

export function applyPacing(
  tl: TlScene[],
  scenes: Scene[],
  words: Word[],
  pool: PoolShot[],
  cfg: PacingConfig,
  log: (m: string) => void,
  opts: { photosOf?: (product: string) => string[]; mix?: Record<string, number> } = {},
): void {
  const FPS = 30;
  const regions = productRegions(scenes);
  const productOf = new Map<number, string>();
  for (const [name, list] of regions) for (const s of list) productOf.set(s.id, name);
  // A card right before a product's first scene introduces it: its backdrop may use that product.
  const names = [...regions.keys()];
  const cardProduct = (i: number): string | undefined => {
    if (productOf.has(scenes[i].id)) return productOf.get(scenes[i].id);
    for (let k = i + 1; k < scenes.length; k++) {
      if (productOf.has(scenes[k].id)) return productOf.get(scenes[k].id);
      if (scenes[k].type !== "graphic") return undefined;
    }
    return undefined;
  };
  const ledger = new ShotLedger();
  const lastUp: (string | undefined)[] = [];
  const typeUse = new Map<string, Map<string, number>>();
  const mixSum = Object.values(opts.mix ?? {}).reduce((a, b) => a + b, 0);
  const sentenceStats: Record<string, number> = {};
  const firstSceneOf = new Set<number>();
  for (const list of regions.values()) {
    const f = list.find((x) => x.type !== "graphic");
    if (f) firstSceneOf.add(f.id);
  }
  // Generic B-roll candidates: the planner's own clips for non-product scenes (deduped).
  const generic = new Map<string, { path: string; duration: number; source: string }>();
  tl.forEach((t, i) => {
    const a = t.asset;
    if (a.kind === "video" && a.source !== "graphic" && !productOf.has(scenes[i].id)) generic.set(sourceKey(a.path), { path: a.path, duration: a.duration ?? 8, source: a.source });
  });

  // Pre-register what cards already show (product photos under side-panel cards).
  tl.forEach((t, i) => {
    const a = t.asset;
    if (scenes[i].type === "graphic" && !t.backdrop && a.kind === "image" && a.source !== "graphic") ledger.take(sourceKey(a.path), 0, STILL, t.id);
  });

  const poolPick = (product: string, need: number, scId: number): SubShot | undefined => {
    const shots = pool.filter((p) => p.product === product); // never another product's shots
    const tu = typeUse.get(product) ?? new Map<string, number>();
    const tot = [...tu.values()].reduce((a, b) => a + b, 0) + 1;
    const want = (p: PoolShot) => (mixSum > 0 ? ((opts.mix![p.shotType ?? ""] ?? 0) / mixSum) * tot - (tu.get(p.shotType ?? "") ?? 0) : 0);
    const fit = (p: PoolShot) => 2 * p.imgSim + (p.sceneSim[String(scId)] ?? p.textSim);
    const opts2: { p: PoolShot; at: number; score: number }[] = [];
    for (const p of shots) {
      if (p.duration < need - 0.05) continue; // shorter shots would loop (a visible repeat)
      const len = Math.min(need, p.duration);
      const key = sourceKey(p.path, p.url);
      const base = p.srcStart ?? 0;
      const local = p.srcStart === undefined ? sourceKey(p.path) : key;
      // Free window inside this HD file, measured in source-video time.
      // Prefer a free window that moves (auto-editor motion score, python/motion_score.py); a
      // static window is only used when nothing else is free (-0.4).
      let at: number | undefined;
      let staticAt: number | undefined;
      for (let t = 0; t + len <= p.duration + 0.01; t += 0.25) {
        if (!ledger.free(local, base + t, base + t + len)) continue;
        if (movingShare(p.motion, p.motionFps ?? 10, t, len) >= 0.5) { at = t; break; }
        staticAt ??= t;
      }
      const isStatic = at === undefined && staticAt !== undefined;
      if (at === undefined) at = staticAt;
      if (at === undefined) continue;
      opts2.push({ p, at, score: fit(p) + 0.6 * Math.max(-1, Math.min(1, want(p))) - (p.author === lastUp[lastUp.length - 1] ? 1 : 0) - (at > 0 ? 0.3 : 0) - (isStatic ? 0.4 : 0) - (mixSum > 0 && opts.mix![p.shotType ?? ""] === undefined ? 0.3 : 0) });
    }
    opts2.sort((x, y) => y.score - x.score);
    const best = opts2[0];
    if (!best) return undefined;
    const p = best.p;
    const len = Math.min(need, p.duration);
    const local = p.srcStart === undefined ? sourceKey(p.path) : sourceKey(p.path, p.url);
    ledger.take(local, (p.srcStart ?? 0) + best.at, (p.srcStart ?? 0) + best.at + len, scId);
    lastUp.push(p.author);
    tu.set(p.shotType ?? "", (tu.get(p.shotType ?? "") ?? 0) + 1);
    typeUse.set(product, tu);
    return { path: p.path, kind: "video", in: Math.round(best.at * 100) / 100, frames: 0, source: "web_crawl", url: p.url, author: p.author, product, key: local, srcIn: (p.srcStart ?? 0) + best.at, shotType: p.shotType };
  };
  const photoPick = (product: string, scId: number, prefer?: string): SubShot | undefined => {
    const list = [...(prefer ? [prefer] : []), ...(opts.photosOf?.(product) ?? [])];
    const ph = list.find((f) => ledger.free(sourceKey(f), 0, STILL));
    if (!ph) return undefined;
    ledger.take(sourceKey(ph), 0, STILL, scId);
    return { path: ph, kind: "image", in: 0, frames: 0, source: "presskit", product, key: sourceKey(ph), srcIn: 0 };
  };
  const clipPick = (path: string, dur: number, source: string, need: number, prefer: number, scId: number): SubShot | undefined => {
    const key = sourceKey(path);
    const at = ledger.window(key, dur, need, prefer);
    if (at === undefined) return undefined;
    ledger.take(key, at, at + need, scId);
    return { path, kind: "video", in: at, frames: 0, source, key, srcIn: at };
  };
  const genericPick = (need: number, scId: number): SubShot | undefined => {
    // The generic clip with the most unused time left.
    const ranked = [...generic.values()].sort((x, y) => {
      const left = (g: { path: string; duration: number }) => g.duration - ledger.used.filter((u) => u.key === sourceKey(g.path)).reduce((s, u) => s + (u.b - u.a), 0);
      return left(y) - left(x);
    });
    for (const g of ranked) {
      const s = clipPick(g.path, g.duration, g.source, need, 0, scId);
      if (s) return s;
    }
    return undefined;
  };

  let totalShots = 0;
  let poolShots = 0;
  const carry = { v: 0 };
  const order = [...tl.keys()].sort((x, y) => Number(!!tl[x].backdrop) - Number(!!tl[y].backdrop)); // cards over footage last
  for (const i of order) {
    const t = tl[i];
    const sc = scenes[i];
    const a = t.asset;
    const start = t.startFrame / FPS;
    const end = t.endFrame / FPS;
    // Rendered cards (PNG background) and side-panel product cards keep their single picture.
    if (a.source === "graphic" || (sc.type === "graphic" && !t.backdrop)) {
      totalShots++;
      continue;
    }
    const product = t.backdrop ? cardProduct(i) : productOf.get(sc.id);
    const st = productOf.has(sc.id) && !t.backdrop ? sentenceType(sc.text, firstSceneOf.has(sc.id)) : "other";
    if (productOf.has(sc.id) && !t.backdrop) sentenceStats[st] = (sentenceStats[st] ?? 0) + 1;
    const cuts = cutTimes(start, end, words, cfg, start < cfg.openingSec ? undefined : carry);
    const bounds = [start, ...cuts, end];
    const frames = bounds.slice(1).map((b, k) => Math.round(b * FPS) - Math.round(bounds[k] * FPS));
    const subs: SubShot[] = [];
    frames.forEach((f, k) => {
      const need = f / FPS;
      let s: SubShot | undefined;
      // Price / product-intro lines open on an unused product photo.
      if (!s && k === 0 && product && (st === "price" || st === "product_intro")) s = photoPick(product, sc.id, a.kind === "image" ? a.path : undefined);
      if (!s && product) s = poolPick(product, need, sc.id);
      if (!s && product) s = photoPick(product, sc.id, a.kind === "image" ? a.path : undefined);
      if (!s && !product && a.kind === "video" && !t.backdrop) s = clipPick(a.path, a.duration ?? need, a.source, need, (a.in ?? 0) + k * (need + 0.8), sc.id);
      if (!s && !product && a.kind === "image" && !t.backdrop && ledger.free(sourceKey(a.path), 0, STILL)) {
        ledger.take(sourceKey(a.path), 0, STILL, sc.id);
        s = { path: a.path, kind: "image", in: 0, frames: 0, source: a.source, key: sourceKey(a.path), srcIn: 0 };
      }
      if (!s) s = genericPick(need, sc.id);
      if (!s) {
        // Nothing unused left: reuse (logged, QA reports it).
        const key = sourceKey(a.path);
        ledger.forced.push(`scene ${sc.id} sub-shot ${k + 1}: ${a.path.split(/[\\/]/).pop()}`);
        s = { path: a.path, kind: a.kind, in: a.in ?? 0, frames: 0, source: a.source, key, srcIn: a.in ?? 0, reused: true };
        ledger.take(key, a.in ?? 0, a.kind === "image" ? STILL : (a.in ?? 0) + need, sc.id);
      }
      s.frames = f;
      if (s.source === "web_crawl" && s.product) poolShots++;
      subs.push(s);
    });
    a.shots = subs;
    (t as TlScene & { sentence?: string }).sentence = st;
    totalShots += subs.length;
  }

  // Hard cuts by default; flash + whoosh only where a new product starts.
  const firstOf = new Set<number>();
  for (const list of regions.values()) {
    const idx = scenes.findIndex((s) => s.id === list[0].id);
    firstOf.add(idx);
    if (idx > 0 && scenes[idx - 1].type === "graphic") firstOf.add(idx - 1);
  }
  let flashes = 0;
  tl.forEach((t, i) => {
    const boundary = firstOf.has(i) && (i === 0 || !firstOf.has(i - 1));
    if (t.transition === "flash" && !boundary) t.transition = "cut";
    if (boundary && i > 0) {
      t.transition = "flash";
      flashes++;
    }
    if (t.sfx) t.sfx = t.sfx.filter((x) => x.kind !== "whoosh" || boundary);
    if (boundary && i > 0 && !(t.sfx ?? []).some((x) => x.kind === "whoosh")) (t.sfx ??= []).push({ kind: "whoosh", at: 0 });
  });
  const dur = tl.length ? tl[tl.length - 1].endFrame / FPS : 0;
  for (const n of names) {
    const tu = typeUse.get(n);
    if (tu) log(`[pacing] ${n}: pool shot types used ${JSON.stringify(Object.fromEntries(tu))}`);
  }
  log(`[pacing] sentence types (product scenes): ${JSON.stringify(sentenceStats)}`);
  log(`[pacing] footage ledger: ${ledger.used.length} segments, ${ledger.forced.length} forced reuse(s)${ledger.forced.length ? ": " + ledger.forced.join("; ") : ""}`);
  log(`[pacing] ${totalShots} shots (${poolShots} from product pools), avg ${(dur / totalShots).toFixed(2)} s, ${((totalShots - 1) / (dur / 60)).toFixed(1)} cuts/min, ${flashes} product-boundary flash(es)`);
}
