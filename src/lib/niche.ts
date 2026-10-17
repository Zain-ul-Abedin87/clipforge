import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

/** A video-type rule set (niches/<name>.json): how scenes, footage and graphics are chosen. */
export interface Niche {
  name: string;
  label: string;
  description?: string;
  structure: {
    detectListicle: boolean;
    titleCardPerItem: boolean;
    maxPriceBadgesPerItem: number;
    maxProsConsPerItem: number;
    targetGraphicShare: number;
  };
  product: { sources: string[]; allowStock: boolean; genericFallback?: boolean };
  stock: { hints: [string, string][]; sectionHintCount?: number; fallbackQuery: string; blockedTerms: string[] };
  /**
   * QA limits: share of running time that may be still images/cards before warn / fail; how an
   * unverified product model counts; how often one clip may appear in a video.
   */
  qa?: { stillWarn?: number; stillFail?: number; unverifiedProduct?: "warn" | "fail"; maxClipUses?: number };
  /** Exact-model rules for product media (src/lib/productResearch.ts). */
  productMatch?: { strict?: boolean; requireManufacturer?: boolean; requireModel?: boolean; requireVariant?: boolean; onConflict?: "reject" | "manual_review"; onUnverified?: "manual_review" | "accept"; variantWords?: string[] };
  /** Background music for this video type; false switches it off even when the channel enables it. */
  music?: { enabled?: boolean };
  /** Affiliate settings: links are kept for the description only, never used for footage search. */
  affiliate?: { separateFromFootage?: boolean; disclosure?: string };
  /** Official photo importer: brand name -> manufacturer domain. */
  official?: { brands: Record<string, string> };
  llmGuidance: string;
  disclaimer: string;
  /** Scene pacing for this video type; overrides the channel's style.json scenes. */
  scenes?: { avgLengthSec: number; minLengthSec: number; maxLengthSec: number };
}

/**
 * Where footage may come from (VidRush-style switch per project):
 * - "stock_cc": the video type's normal order (own clips, press kit, stock sites, CC / public domain).
 * - "cc_pd": only Creative Commons and public domain sources, plus the user's own clips.
 */
export const FOOTAGE_MODES = ["stock_cc", "cc_pd"] as const;
export type FootageMode = (typeof FOOTAGE_MODES)[number];
export const FOOTAGE_MODE_LABELS: Record<FootageMode, string> = {
  stock_cc: "Stock + CC / public domain",
  cc_pd: "CC & public domain only",
};

/** Sources that hold only CC or public-domain media (own clips are the user's, always allowed). */
const CC_PD_STOCK = ["wikimedia_video", "archive", "youtube_cc"];
const CC_PD_PRODUCT = ["local", "wikimedia"];

export function footageMode(project: { footage?: string }): FootageMode {
  return (FOOTAGE_MODES as readonly string[]).includes(project.footage ?? "") ? (project.footage as FootageMode) : "stock_cc";
}

/** The niche with its source lists narrowed to what the project's footage mode allows. */
export function applyFootageMode(n: Niche, mode: FootageMode): Niche {
  if (mode === "stock_cc") return n;
  const stock = n.stock as Niche["stock"] & { sources?: string[] };
  const listed = stock.sources ?? ["pixabay", "pexels"];
  const sources = listed.filter((s) => CC_PD_STOCK.includes(s));
  for (const s of CC_PD_STOCK) if (!sources.includes(s)) sources.push(s);
  return {
    ...n,
    product: { ...n.product, sources: n.product.sources.filter((s) => CC_PD_PRODUCT.includes(s)) },
    stock: { ...stock, sources } as Niche["stock"],
  };
}

/** The project's video type with its footage mode applied: what plan / assets / swaps should use. */
export function loadProjectNiche(project: { niche?: string; footage?: string; name?: string }, style: Record<string, unknown>, projectDirPath?: string): Niche {
  // Auto-detect writes <project>/niche.json; prefer it over a fixed niches/*.json file.
  const dir = projectDirPath || (typeof project.name === "string" && project.name ? path.join(paths.workspace, project.name) : "");
  if (dir) {
    const local = path.join(dir, "niche.json");
    if (fs.existsSync(local)) {
      const n = JSON.parse(fs.readFileSync(local, "utf8").replace(/^\uFEFF/, "")) as Niche;
      return applyFootageMode(n, footageMode(project));
    }
  }
  return applyFootageMode(loadNiche(projectNicheName(project, style)), footageMode(project));
}

/** Cache key path for plan/assets: project niche.json wins when present. */
export function nicheFingerprintPath(dir: string, nicheName: string): string {
  const local = path.join(dir, "niche.json");
  if (fs.existsSync(local)) return local;
  return path.join(nichesDir, `${nicheName}.json`);
}

export const nichesDir = path.join(paths.root, "niches");

export function listNiches(): Niche[] {
  if (!fs.existsSync(nichesDir)) return [];
  return fs
    .readdirSync(nichesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => loadNiche(path.basename(f, ".json")));
}

export function loadNiche(name = "general"): Niche {
  const file = path.join(nichesDir, `${name}.json`);
  if (!fs.existsSync(file)) {
    if (name !== "general") return loadNiche("general");
    throw new Error(`Niche rule set not found: ${file}`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as Niche;
}

/** The stock hint table compiled to whole-word regexes ("pistol|handgun" -> /\b(?:pistol|handgun)\b/i). */
export function nicheHints(n: Niche, productNames: string[] = []): [RegExp, string][] {
  // Brand mentions belong to the product pool (exact model), never to "brand comparison" stock.
  const brandTok = new Set(productNames.flatMap((x) => x.toLowerCase().split(/\s+/)).filter((t) => t.length > 2));
  return n.stock.hints
    .filter(([words, q]) => !isBrandHint(words, q) && !words.split("|").some((w) => brandTok.has(w.trim().toLowerCase())))
    .map(([words, q]) => [new RegExp("\\b(?:" + words + ")\\b", "i"), q]);
}

/** A stock hint about brands ("mower brand comparison", "Toro|Exmark|Honda") is not stock material. */
export function isBrandHint(words: string, query: string): boolean {
  if (/\bbrands?\b|\bcomparison\b|\bvs\.?\b|\bversus\b/i.test(query)) return true;
  const w = words.split("|").map((x) => x.trim()).filter(Boolean);
  return w.length >= 2 && w.filter((x) => /^[A-Z][a-z]+$/.test(x)).length === w.length && !/\b(close|engine|motor)\b/i.test(query);
}

/** True when a stock result's title/tags hit the niche's blocked list. */
export function isBlocked(n: Niche, text: string): boolean {
  const t = text.toLowerCase();
  return n.stock.blockedTerms.some((b) => t.includes(b.toLowerCase()));
}

/** Project setting wins, then the channel's style.json, then "general". */
export function projectNicheName(project: { niche?: string }, style: Record<string, unknown>): string {
  const fromStyle = typeof style.niche === "string" ? style.niche : undefined;
  // "auto" is not a niches/*.json file — fall through to general until detect writes project niche.json.
  const styleNiche = fromStyle && fromStyle !== "auto" ? fromStyle : undefined;
  const fromProject = project.niche && project.niche !== "auto" ? project.niche : undefined;
  return fromProject ?? styleNiche ?? "general";
}
