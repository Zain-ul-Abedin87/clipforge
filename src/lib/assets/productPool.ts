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
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { agentEnabled, agentModel } from "../agent/footage.js";
import { fetchRetailImages, productWebVideos } from "./retailImages.js";
import { browserProduct } from "./browserProduct.js";
import { llm } from "../agents/llm/llm.js";

/** Haiku writes 3-5 B-roll YouTube searches per product from category words (cached per product). */
export const DEFAULT_FORBIDDEN = ["Top", "Best", "Vs", "Comparison", "Compilation", "Podcast", "Fix", "Repair", "Maintenance", "Review"];
interface BrollPlan { queries: string[]; forbidden: string[] }
async function llmBrollPlan(name: string, category: string, baseForbidden: string[], log: (m: string) => void): Promise<BrollPlan> {
  if (!agentEnabled()) return { queries: [], forbidden: baseForbidden };
  const file = path.join(paths.root, "cache", "pools", `q_${slug(name)}_${crypto.createHash("sha1").update(`${name}|${category}|${agentModel()}|v4`).digest("hex").slice(0, 8)}.json`);
  if (fs.existsSync(file)) {
    try {
      const c = JSON.parse(fs.readFileSync(file, "utf8")) as BrollPlan;
      return { queries: c.queries, forbidden: [...new Set([...baseForbidden, ...c.forbidden])] };
    } catch { /* regenerate */ }
  }
  const Schema = z.object({ queries: z.array(z.string()), forbidden_keywords: z.array(z.string()) });
  try {
    const model = agentModel();
    const res = await llm().messages.parse({
      model,
      max_tokens: 1200,
      output_config: model.startsWith("claude-haiku") ? { format: zodOutputFormat(Schema) } : { effort: "low" as const, format: zodOutputFormat(Schema) },
      system: "You write YouTube searches that find pure B-roll footage of ONE exact product (any kind of product): no presenter, no talking. Return 14-16 VARIED searches, 3-9 words each, every one containing the exact model name (or its model/part number), each from a different angle: camera angles (aerial/drone, low angle, close up, side profile, rear), real use cases and settings for this kind of product, colour/finish variants, model numbers and series names, and dealer/retailer/brand-channel demo footage (e.g. '<brand> dealer <model> walkaround b-roll'). Mix strict B-roll terms, e.g. '<model> cinematic shots', '<model> close up b-roll', '<model> in action no talking', '<model> <typical action for this kind of product> cinematic', '<model> unboxing b-roll'. Never use 'best', 'top', 'vs', 'comparison', 'review'. Also return forbidden_keywords: extra single title words for this product that signal unwanted videos (talking/podcasts/repairs/comparisons/other models), in addition to Top, Best, Vs, Comparison, Compilation, Podcast, Fix, Repair, Maintenance, Review.",
      messages: [{ role: "user", content: JSON.stringify({ product: name, category }) }],
    });
    const q = (res.parsed_output?.queries ?? []).map((x) => x.replace(/\s+/g, " ").trim()).filter((x) => x.length > 4 && !/\b(best|top|vs|comparison|review)\b/i.test(x)).slice(0, 16);
    const nameWords = new Set(name.toLowerCase().split(/\s+/));
    const fb = (res.parsed_output?.forbidden_keywords ?? []).map((x) => x.trim()).filter((x) => x && x.length < 25 && !nameWords.has(x.toLowerCase())).slice(0, 12);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ queries: q, forbidden: fb }));
    log(`[pool] ${name}: Haiku B-roll searches: ${q.join(" | ")}; forbidden title words +${fb.join(", ") || "-"}`);
    return { queries: q, forbidden: [...new Set([...baseForbidden, ...fb])] };
  } catch (err) {
    log(`[pool] ${name}: Haiku B-roll searches failed (${String((err as Error).message ?? err).slice(0, 100)}); using built-in searches`);
    return { queries: [], forbidden: baseForbidden };
  }
}

/** Official product videos found by the official importer (presskit/<product>/youtube_links.txt). */
function officialVideoLinks(channel: string, name: string): string[] {
  const f = path.join(paths.channels, channel, "presskit", slug(name), "youtube_links.txt");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").split(/\r?\n/).map((x) => x.trim()).filter((x) => /^https?:\/\//.test(x)).slice(0, 6);
}

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
  /** Claude confirmed this shot shows the exact product (model). Only verified shots count as product footage. */
  verified?: boolean;
  /** Vault shot cut around a spoken spec ("blades"): pacing prefers it on lines about that spec. */
  keyword?: string;
}

/** Per-product pool result (<project>/product_pool_status.json), read by the timeline, review page and QA. */
export interface PoolStatus {
  verified: number;
  need: number;
  chapterSec: number;
  /** Fewer than minTarget verified shots: the chapter is shown with a warning, never filled with stock. */
  insufficient: boolean;
  queries?: string[];
}

/** Strict exact-model prompt for Claude (any product niche). */
export function exactModelPrompt(name: string, category: string): string {
  const c = category || "product";
  return `Footage that clearly shows the exact ${name} ${c} itself. fits=true ONLY if you are confident this is the ${name} specifically: matching brand/model badge, logo, shape, colour and design. fits=false for: a different brand or model; a generic ${c} you cannot identify as the ${name}; the underside, disassembled parts, exposed internals or blades of the ${c}; a garage, workshop, cluttered tools or any mechanic/repair setting; any person pointing, gesturing or explaining next to it (even not looking at camera), a talking head or presenter; maintenance (pouring oil, opening the engine/case, cleaning, repairing); packaging only; or no ${c} visible. Accept ONLY clean cinematic in-use action, clean outdoor/lifestyle shots, or professional studio b-roll of this specific model. When unsure = fits false.`;
}

/** Search rounds: the niche queries first, then expanded (brand+model, model only, category words, official/retailer). */
function queryRounds(name: string, cfg: PoolConfig): string[][] {
  const words = name.split(/\s+/);
  const model = words.length > 1 ? words.slice(1).join(" ") : name;
  const c = cfg.category || "";
  const r1 = cfg.queries.map((x) => x.replace("{name}", name));
  const r2 = [`${name} ${c}`.trim(), `${name} walkaround`, `${name} demo`, `${name} test`];
  const r3 = [`${model} ${c}`.trim(), `${name} official video`, `${name} commercial`, `${name} in action`];
  const r4 = [`${name} ${c} overview`.trim(), `${name} dealer`, `${name} features`, `${words[0]} ${model} ${c} footage`.trim()];
  return [r1, r2, r3, r4];
}

/** Product footage = verified shots. Older pools (no flag) count as verified only when vision was off. */
export const isVerifiedShot = (p: PoolShot) => p.verified === true;

export function readPoolStatus(dir: string): Record<string, PoolStatus> {
  const f = path.join(dir, "product_pool_status.json");
  try {
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
  } catch {
    return {};
  }
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
  /** Title words that skip a video before download (niche productPool.forbiddenKeywords). */
  forbidden: string[];
}

export function poolConfig(niche: Niche): PoolConfig {
  const p = ((niche as unknown as { productPool?: Partial<PoolConfig> }).productPool ?? {}) as Partial<PoolConfig>;
  return {
    enabled: env("PRODUCT_POOL", p.enabled === false ? "off" : p.enabled ? "on" : "off").toLowerCase() !== "off",
    target: Number(env("PRODUCT_POOL_TARGET", String(Math.max(40, p.target ?? 40)))),
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
    forbidden: (p as { forbiddenKeywords?: string[] }).forbiddenKeywords ?? DEFAULT_FORBIDDEN,
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
  const status: Record<string, PoolStatus> = {};
  const needOf = new Map<string, { need: number; chapterSec: number; queries?: string[] }>();
  const shotSec = Number((niche as unknown as { pacing?: { targetShotSec?: number } }).pacing?.targetShotSec ?? 2.3) || 2.3;
  for (const [name, region] of regions) {
    {
      const b = region.filter((s) => s.type !== "graphic");
      const cs = b.reduce((a, s) => a + (s.end - s.start), 0);
      needOf.set(name, { need: Math.max(cfg.minTarget, Math.ceil((cs / shotSec) * 1.3)), chapterSec: cs });
    }
    const t0 = Date.now();
    const refs = productPhotos(channel, name);
    // Pool cache: same product, config and reference photos -> reuse (re-runs take seconds, not ~28 min).
    const key = crypto.createHash("sha1").update(JSON.stringify({ name, cfg, refs: refs.map((r) => [path.basename(r), fs.statSync(r).size]), v: "pool-5-exact", need: needOf.get(name)?.need })).digest("hex").slice(0, 10);
    const cacheFile = path.join(paths.root, "cache", "pools", `${slug(name)}_${key}.json`);
    if (env("POOL_CACHE", "on").toLowerCase() !== "off" && fs.existsSync(cacheFile)) {
      const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8")) as PoolShot[];
      if (cached.length && cached.every((p) => fs.existsSync(p.path)) && cached.some((p) => p.verified)) {
        all.push(...cached);
        log(`[pool] ${name}: ${cached.length} shot(s) from cache ${path.basename(cacheFile)}`);
        continue;
      }
    }
    const body = region.filter((s) => s.type !== "graphic");
    const chapterSec = body.reduce((a, s) => a + (s.end - s.start), 0);
    const need = Math.max(cfg.minTarget, Math.ceil((chapterSec / shotSec) * 1.3));
    const cands = new Map<string, Candidate>();
    const tried = new Set<string>();
    // Sources in order: official/retailer (direct video links + product images), Haiku B-roll
    // searches, then the niche searches and expanded rounds.
    const browser = await browserProduct(channel, dir, name, cfg.category, log, body.map((s) => s.text).join(" ")).catch((err) => (log(`[browser] ${name}: skipped (${String(err).slice(0, 100)})`), { videos: [] as string[], summary: "" }));
    const official = [...new Set([...officialVideoLinks(channel, name), ...browser.videos.slice(0, 10)])];
    await fetchRetailImages(channel, name, cfg.category, Number(env("RETAIL_IMAGES_WANT", "16")), log).catch((err) => log(`[retail] ${name}: skipped (${String(err).slice(0, 100)})`));
    const plan = await llmBrollPlan(name, cfg.category, cfg.forbidden, log);
    const base = queryRounds(name, cfg);
    // Strict rounds (forbidden title words incl. "Review"), then a safeguard pass that allows
    // "Review" titles (talking heads are still dropped by CLIP + Claude) when the pool stays short.
    const rounds = [[...official, ...plan.queries, ...base[0]], ...base.slice(1), [`${name} review`, `${name} ${cfg.category} review`.trim(), `${name} hands on review`]];
    const relaxedFrom = rounds.length - 1;
    type Picked = { c: Candidate; img: number; txt: number; score: number; type: ShotType };
    let bestChosen: Picked[] = [];
    let lastRes: { scores: Record<string, number> } | null = null;
    let verifiedRun = false;
    needOf.set(name, { need, chapterSec });
    log(`[pool] ${name}: chapter ${chapterSec.toFixed(0)} s / ${shotSec} s per shot -> target ${need} verified shot(s)`);
    for (let round = 0; round < rounds.length; round++) {
      const before = cands.size;
      for (const q of rounds[round]) {
        if (tried.has(q.toLowerCase())) continue;
        tried.add(q.toLowerCase());
        try {
          for (const c of await searchWebCrawl(q, { pool: true, previews: round ? Number(env("POOL_ROUND_PREVIEWS", "6")) : undefined, product: name, forbidden: round >= relaxedFrom ? plan.forbidden.filter((w) => w.toLowerCase() !== "review") : plan.forbidden })) if (!cands.has(c.id)) cands.set(c.id, c);
        } catch (err) {
          log(`[pool] ${name}: search "${q}" failed: ${String(err).slice(0, 120)}`);
        }
      }
      // Videos beyond YouTube search: Amazon product videos and Google/Bing video results for the exact
      // model (python/product_web.py). Previewed like any web-crawl hit; the exact-model + strict vision
      // check below decides. URLs are logged to <project>/web_video_sources.json.
      if (round === 0 && env("PRODUCT_WEB_VIDEOS", "on").toLowerCase() !== "off") {
        const vids = await productWebVideos(`${name} ${cfg.category}`.trim(), log);
        const logF = path.join(dir, "web_video_sources.json");
        const vlog: Record<string, unknown[]> = fs.existsSync(logF) ? JSON.parse(fs.readFileSync(logF, "utf8")) : {};
        vlog[name] = [];
        let added = 0;
        for (const v of vids.slice(0, Number(env("PRODUCT_WEB_VIDEOS_MAX", "14")))) {
          let ok = 0;
          try {
            for (const c of await searchWebCrawl(v.url, { pool: true, product: name })) if (!cands.has(c.id)) (cands.set(c.id, c), ok++);
          } catch (err) {
            log(`[pool] ${name}: web video ${v.url.slice(0, 80)} failed: ${String(err).slice(0, 100)}`);
          }
          added += ok;
          vlog[name].push({ ...v, previewed: ok > 0, at: new Date().toISOString() });
        }
        fs.writeFileSync(logF, JSON.stringify(vlog, null, 1));
        log(`[pool] ${name}: ${vids.length} Amazon/Google/Bing video result(s) -> ${added} previewed candidate(s) (${[...new Set(vids.map((v) => v.provider))].join(", ") || "none"})`);
      }
      if (round && cands.size === before) {
        log(`[pool] ${name}: round ${round + 1} found no new videos`);
        continue;
      }
      // Real shot length (webCrawl.ts sets shotLen); long uncut shots give two pool entries.
      const shots: Candidate[] = [];
      for (const c of cands.values()) {
        if (!(c.frames ?? []).some((f) => fs.existsSync(f))) continue;
        const len = (c as Candidate & { shotLen?: number }).shotLen ?? c.duration ?? cfg.maxShotSec;
        if (len < 1.5) continue;
        // Long PySceneDetect shots are split into distinct sub-segments (~2.4 s each, max 8) so the
        // timeline gets different moments of the same take instead of reusing one window.
        const parts = len >= 3.6 ? Math.min(12, Math.floor(len / 1.8)) : 1;
        if (parts === 1) {
          shots.push(Object.assign({ ...c }, { shotLen: Math.min(len, 6) }));
          continue;
        }
        const seg = len / parts;
        const fr = c.frames ?? [];
        for (let k = 0; k < parts; k++) {
          const f0 = Math.floor((fr.length * k) / parts);
          const f1 = Math.max(f0 + 1, Math.floor((fr.length * (k + 1)) / parts));
          const frames = fr.length ? fr.slice(f0, f1) : fr;
          shots.push(Object.assign({ ...c, id: k ? `${c.id}_${String.fromCharCode(97 + k)}` : c.id, shotStart: (c.shotStart ?? 0) + seg * k, frames: frames.length ? frames : fr }, { shotLen: Math.max(1.5, seg - 0.3) }));
        }
      }
      log(`[pool] ${name}: ${shots.length} shots from ${new Set(shots.map((c) => c.pageUrl)).size} videos, ${refs.length} reference photo(s)`);
      if (!shots.length) continue;
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
        if (chosen.length >= Math.max(cfg.target, need) * 2) break;
        const up = s.c.author ?? s.c.pageUrl;
        if ((perUp.get(up) ?? 0) >= Math.max(cfg.maxPerUploader, Math.ceil(need / 6))) continue;
        const e = emb[s.c.id];
        if (e && chosen.some((x) => emb[x.c.id] && cos(emb[x.c.id], e) > 0.96)) continue;
        chosen.push(s);
        perUp.set(up, (perUp.get(up) ?? 0) + 1);
      }

      // Exact-model check (Claude, required): only shots Claude confirms show this exact product are
      // product footage. Unknown (not checked / failed batch) counts as NOT verified.
      if (visionVerifyEnabled() && env("PRODUCT_VISION", "on").toLowerCase() !== "off" && chosen.length) {
        const text = exactModelPrompt(name, cfg.category);
        const items = [];
        for (let k = 0; k < chosen.length; k += 4)
          items.push({ sceneId: 9000 + k, text, before: "", cands: chosen.slice(k, k + 4).map((s) => ({ id: s.c.id, frames: (s.c.frames ?? []).slice(0, 3) })) });
        const verdict = await verifyCandidates(items, `${name} review`, path.join(dir, "vision_pool.json"), log);
        const n0 = chosen.length;
        const keep = chosen.filter((s, i) => verdict.get(`${9000 + Math.floor(i / 4) * 4}|${s.c.id}`) === true);
        log(`[pool] ${name}: Claude confirmed exact model ${keep.length}/${n0}`);
        chosen.splice(0, chosen.length, ...keep);
      } else if (chosen.length) {
        log(`[pool] ${name}: exact-model check unavailable (no ANTHROPIC_API_KEY / PRODUCT_VISION=off): ${chosen.length} shot(s) kept but NOT verified`);
      }
      verifiedRun = visionVerifyEnabled() && env("PRODUCT_VISION", "on").toLowerCase() !== "off";
      bestChosen = chosen;
      lastRes = res;
      log(`[pool] ${name}: round ${round + 1}/${rounds.length}: ${chosen.length} verified shot(s) (need ${need})`);
      if (chosen.length >= need) break;
      if (round + 1 === relaxedFrom && chosen.length >= cfg.minTarget) break; // strict pass reached the minimum: no Review titles
    if (round + 1 === relaxedFrom) log(`[pool] ${name}: strict pass gave ${chosen.length} verified (< min ${cfg.minTarget}); second pass allows 'Review' titles (talking heads still rejected)`);
    else if (round + 1 < rounds.length) log(`[pool] ${name}: below ${need}, retrying with expanded queries: ${rounds[round + 1].join(" | ")}`);
    }
    const chosen = bestChosen;
    const res = lastRes;
    if (!res || !chosen.length) {
      needOf.set(name, { need, chapterSec, queries: [...tried] });
      log(`[pool] ${name}: INSUFFICIENT FOOTAGE - 0 verified clips after ${tried.size} searches; this chapter will not be filled with stock`);
      continue;
    }
    // Shot-type mix: fill by the niche's weights (largest deficit first), then top up by score.
    const wsum = Object.values(cfg.mix).reduce((a, b) => a + (b ?? 0), 0);
    if (wsum > 0) {
      const picked: Picked[] = [];
      const cnt = new Map<ShotType, number>();
      const left = [...chosen];
      while (picked.length < Math.max(cfg.target, need) && left.length) {
        const need = (k: ShotType) => (cfg.mix[k] === undefined ? -2 : 0) + ((cfg.mix[k] ?? 0) / wsum) * (picked.length + 1) - (cnt.get(k) ?? 0);
        let bi = 0;
        for (let k = 1; k < left.length; k++) if (need(left[k].type) > need(left[bi].type) + 1e-9) bi = k;
        const [x] = left.splice(bi, 1);
        picked.push(x);
        cnt.set(x.type, (cnt.get(x.type) ?? 0) + 1);
      }
      chosen.splice(0, chosen.length, ...picked);
    }
    chosen.splice(Math.max(cfg.target, need));
    const mixLog = chosen.reduce<Record<string, number>>((m, x) => ((m[x.type] = (m[x.type] ?? 0) + 1), m), {});
    log(`[pool] ${name}: shot types ${JSON.stringify(mixLog)}${chosen.length < cfg.minTarget ? ` (below target ${need})` : ""}`);

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
        all.push({ id, product: name, path: file, url: c.pageUrl, author: c.author, license: c.license, duration: secs, imgSim: Math.round(s.img * 1000) / 1000, textSim: Math.round(s.txt * 1000) / 1000, sceneSim, frames: c.frames ?? [], shotType: s.type, srcStart: c.shotStart ?? 0, verified: verifiedRun });
      } catch (err) {
        log(`[pool] ${name}: HD fetch failed: ${String(err).slice(0, 120)}`);
      }
    }
    needOf.set(name, { need, chapterSec, queries: [...tried] });
    const mine = all.filter((p) => p.product === name);
    const ups = new Set(mine.map((p) => p.author));
    if (mine.some((p) => p.verified)) {
      fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
      fs.writeFileSync(cacheFile, JSON.stringify(mine, null, 1));
    }
    log(`[pool] ${name}: ${ok} shot(s) in the pool from ${ups.size} uploader(s), ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  // Per-shot QA (PySceneDetect + CLIP + motion): drop talking heads / frozen shots.
  const final = await filterPoolByShotQa(all, cfg.category, log);
  fs.writeFileSync(outFile, JSON.stringify(final, null, 1));
  // Pool gate: verified shots per product after QA. Below minTarget = insufficient footage (warned on
  // the review page and in QA; the timeline reuses other moments of the verified videos, never stock).
  for (const [name, n] of needOf) {
    const verified = final.filter((p) => p.product === name && isVerifiedShot(p)).length;
    status[name] = { verified, need: n.need, chapterSec: Math.round(n.chapterSec), insufficient: verified < cfg.minTarget, queries: n.queries };
    log(`[pool] gate ${name}: ${verified} verified / target ${n.need}${verified < cfg.minTarget ? ` -> INSUFFICIENT FOOTAGE (< ${cfg.minTarget})` : verified < n.need ? " (short: verified moments will be reused)" : " ok"}`);
  }
  fs.writeFileSync(path.join(dir, "product_pool_status.json"), JSON.stringify(status, null, 1));
  return final.length;
}

export function readProductPool(dir: string): PoolShot[] {
  const f = path.join(dir, "product_pool.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as PoolShot[]) : [];
}
