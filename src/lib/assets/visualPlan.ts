import fs from "node:fs";
import path from "node:path";
import { genericStockAllowed } from "./sources.js";
import { assetKeyOf, writeLedger } from "./licenseLedger.js";
import type { Asset, Assets, Candidate } from "./types.js";
import { mapPrompts, SegmentIn, VisualPrompt } from "./prompt-mapper.js";
import { downloadPexels, pexelsConfigured, searchPexelsVideos } from "./stock/pexels.js";
import { downloadPixabay, pixabayConfigured, searchPixabayVideos } from "./stock/pixabay.js";
import { generateImage } from "./imagegen.js";
import { readLicenseSidecar } from "./stock/license.js";
import { loadFeatures } from "../settings/features.js";
import { activeLoader } from "../models/loader.js";
import { readJson, writeJson } from "../project.js";
import type { Scene } from "../scenes.js";

/**
 * Visual plan (Phase 4): one UNIQUE visual per segment, ranked
 *   0 product footage > 1 product photo > 2 stock video > 3 generated picture.
 * Product segments only take their own product media (tiers 0-1): never stock, never generated
 * (exact-model policy). Non-product segments may take stock (Pexels / Pixabay, keys in .env) and,
 * when nothing real is left, a locally generated picture (ComfyUI, features.json stock.imagegen).
 * Every chosen asset's source and licence is logged and kept in visual_plan.json; downloads and
 * generated pictures get a `<file>.license.json` sidecar.
 */

export type Tier = 0 | 1 | 2 | 3;
export const TIER_LABEL: Record<Tier, string> = { 0: "product footage", 1: "product photo", 2: "stock", 3: "generated" };

export interface RankedCandidate {
  /** Identity across segments (the same clip must not be picked twice). */
  key: string;
  tier: Tier;
  score: number;
  source: string;
  license: string;
  kind: "video" | "image";
  /** Existing local file (current asset) or a stock candidate to download. */
  file?: string;
  stock?: Candidate;
}

export interface Pick {
  id: number;
  cand?: RankedCandidate;
  /** Nothing unused left and the segment may be generated. */
  generate?: boolean;
  /** Nothing unused: the least-used candidate repeats (counted). */
  forced?: boolean;
}

/** Tier of an existing asset for a segment. */
export function tierOf(a: Pick_<Asset, "source" | "kind">, isProduct: boolean): Tier | null {
  if (a.source === "graphic") return null;
  if (isProduct) return a.kind === "video" ? 0 : 1;
  if (a.source === "pexels" || a.source === "pixabay" || a.source === "storyblocks" || a.source === "unsplash") return 2;
  // Own / press-kit / vault media on a non-product line is still real footage of the topic.
  return a.kind === "video" ? 0 : 1;
}
type Pick_<T, K extends keyof T> = { [P in K]: T[P] };

/**
 * Greedy unique assignment: the most constrained segments (fewest candidates) choose first, each
 * takes its best unused candidate (lowest tier, then highest score). A segment with nothing unused
 * is generated when allowed, else repeats its least-used candidate (forced reuse).
 */
export function assignUnique(segs: { id: number; allowGenerated: boolean }[], cands: Map<number, RankedCandidate[]>): { picks: Pick[]; forcedReuse: number } {
  const used = new Map<string, number>();
  const order = [...segs].sort((a, b) => (cands.get(a.id)?.length ?? 0) - (cands.get(b.id)?.length ?? 0) || a.id - b.id);
  const picks = new Map<number, Pick>();
  let forcedReuse = 0;
  for (const s of order) {
    const list = [...(cands.get(s.id) ?? [])].sort((a, b) => a.tier - b.tier || b.score - a.score);
    const free = list.find((c) => !used.has(c.key));
    if (free) {
      used.set(free.key, 1);
      picks.set(s.id, { id: s.id, cand: free });
    } else if (s.allowGenerated) picks.set(s.id, { id: s.id, generate: true });
    else if (list.length) {
      const least = [...list].sort((a, b) => (used.get(a.key) ?? 0) - (used.get(b.key) ?? 0) || a.tier - b.tier)[0];
      used.set(least.key, (used.get(least.key) ?? 0) + 1);
      picks.set(s.id, { id: s.id, cand: least, forced: true });
      forcedReuse++;
    } else picks.set(s.id, { id: s.id });
  }
  return { picks: segs.map((s) => picks.get(s.id)!), forcedReuse };
}

export interface PlanEntry {
  id: number;
  query: string;
  imagePrompt: string;
  tier: Tier | null;
  tierLabel: string;
  source: string;
  license: string;
  key: string | null;
  file: string | null;
  forced: boolean;
  generated: boolean;
}

export interface VisualPlan {
  at: string;
  segments: PlanEntry[];
  summary: { segments: number; unique: number; forcedReuse: number; byTier: Record<string, number>; missing: number; withLicense: number };
}

export async function runVisualPlan(dir: string, o: { apply?: boolean; log?: (m: string) => void } = {}): Promise<VisualPlan> {
  const log = o.log ?? ((m: string) => console.log(m));
  const cfg = loadFeatures().stock;
  const scenes = readJson<Scene[]>(path.join(dir, "scenes.json"));
  const assetsFile = path.join(dir, "assets.json");
  const assets: Assets = fs.existsSync(assetsFile) ? readJson<Assets>(assetsFile) : {};
  const segs: (SegmentIn & { isProduct: boolean })[] = scenes
    .filter((s) => s.type !== "graphic")
    .map((s) => ({ id: s.id, text: s.text, product: s.type === "product" ? s.product_name ?? null : null, isProduct: s.type === "product" && !!s.product_name }));
  const prompts = new Map<number, VisualPrompt>((await mapPrompts(segs, log)).map((p) => [p.id, p]));
  // The text model is done: free the VRAM before any image generation.
  if (cfg.imagegen) await activeLoader()?.release();

  const stockOn = (cfg.pexels && pexelsConfigured()) || (cfg.pixabay && pixabayConfigured());
  if (!stockOn) log(`[visuals] stock search off (features.json stock.pexels / stock.pixabay, and PEXELS_API_KEY / PIXABAY_API_KEY in .env)`);
  const cands = new Map<number, RankedCandidate[]>();
  for (const s of segs) {
    const list: RankedCandidate[] = [];
    const a = assets[String(s.id)];
    const t = a ? tierOf(a, s.isProduct) : null;
    if (a && t !== null) list.push({ key: assetKeyOf(a), tier: t, score: a.match ?? 1, source: a.source, license: a.license, kind: a.kind, file: a.path });
    // Stock only for non-product lines (product lines show the exact model or nothing).
    if (!s.isProduct && stockOn) {
      const q = prompts.get(s.id)!.query;
      const found: Candidate[] = [];
      try {
        if (cfg.pexels) found.push(...(await searchPexelsVideos(q)).slice(0, cfg.perQuery));
        if (cfg.pixabay) found.push(...(await searchPixabayVideos(q)).slice(0, cfg.perQuery));
      } catch (err) {
        log(`[visuals] stock search "${q}" failed: ${String((err as Error).message).slice(0, 120)}`);
      }
      for (const c of found) list.push({ key: `${c.source}:${c.id.replace(/_\d+$/, "")}`, tier: 2, score: c.score, source: c.source, license: c.license, kind: c.kind, stock: c });
    }
    cands.set(s.id, list);
  }
  const { picks, forcedReuse } = assignUnique(
    segs.map((s) => ({ id: s.id, allowGenerated: prompts.get(s.id)!.allowGenerated && cfg.imagegen })),
    cands,
  );

  const entries: PlanEntry[] = [];
  for (const p of picks) {
    const pr = prompts.get(p.id)!;
    let file = p.cand?.file ?? null;
    let license = p.cand?.license ?? "";
    let source = p.cand?.source ?? "";
    let generated = false;
    if (o.apply && p.cand?.stock) {
      try {
        const d = p.cand.stock.source === "pixabay" ? await downloadPixabay(p.cand.stock, pr.query) : await downloadPexels(p.cand.stock, pr.query);
        file = d.file;
        license = d.license.license;
      } catch (err) {
        log(`[visuals] #${p.id} download failed: ${String((err as Error).message).slice(0, 120)}`);
      }
    }
    if (o.apply && p.generate) {
      try {
        const g = await generateImage(pr.imagePrompt, { url: cfg.comfyUrl, ckpt: cfg.comfyCheckpoint, log });
        file = g.file;
        license = g.license.license;
        source = "imagegen";
        generated = true;
      } catch (err) {
        log(`[visuals] #${p.id} image generation failed: ${String((err as Error).message).slice(0, 160)}`);
      }
    }
    const tier: Tier | null = generated ? 3 : p.cand?.tier ?? null;
    const e: PlanEntry = { id: p.id, query: pr.query, imagePrompt: pr.imagePrompt, tier, tierLabel: tier === null ? (p.generate ? "generated (pending)" : "none") : TIER_LABEL[tier], source: source || (p.generate ? "imagegen" : ""), license: license || (p.generate ? "generated on apply" : ""), key: p.cand?.key ?? (generated ? `imagegen:${file}` : null), file, forced: !!p.forced, generated };
    entries.push(e);
    log(`[visuals] #${p.id} ${e.tierLabel}${e.forced ? " (FORCED REUSE)" : ""}: ${e.source || "-"} | ${e.license || "no licence"} | "${pr.query}"`);
  }

  if (o.apply) {
    // Only scenes without a real picture (missing, or a fallback card on a footage scene) change.
    let changed = 0;
    for (const e of entries) {
      const cur = assets[String(e.id)];
      if (!e.file || (cur && cur.source !== "graphic")) continue;
      const side = readLicenseSidecar(e.file);
      assets[String(e.id)] = { path: e.file, source: (e.generated ? "imagegen" : e.source) as Asset["source"], license: e.license, url: side?.pageUrl || "", kind: e.generated || /\.(png|jpe?g|webp)$/i.test(e.file) ? "image" : "video", author: side?.author, query: e.query, note: `visual plan: ${e.tierLabel}` };
      changed++;
    }
    if (changed) {
      writeJson(assetsFile, assets);
      writeLedger(dir, scenes, assets);
    }
    log(`[visuals] applied ${changed} visual(s) to assets.json (only scenes that had no real picture)${genericStockAllowed() ? "" : "; GENERIC_STOCK stays off for the assets step"}`);
  }

  const keys = entries.map((e) => e.key).filter((k): k is string => !!k);
  const byTier: Record<string, number> = {};
  for (const e of entries) byTier[e.tierLabel] = (byTier[e.tierLabel] ?? 0) + 1;
  const plan: VisualPlan = {
    at: new Date().toISOString(),
    segments: entries,
    summary: { segments: entries.length, unique: new Set(keys).size, forcedReuse, byTier, missing: entries.filter((e) => !e.key && !e.generated).length, withLicense: entries.filter((e) => e.license).length },
  };
  writeJson(path.join(dir, "visual_plan.json"), plan);
  log(`[visuals] ${plan.summary.segments} segment(s): ${plan.summary.unique} unique visual(s), forced reuse ${forcedReuse}, ${plan.summary.missing} without a visual, ${plan.summary.withLicense} with source + licence logged; tiers ${JSON.stringify(byTier)}`);
  return plan;
}
