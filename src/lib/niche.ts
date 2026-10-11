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
  /** QA limits: share of running time that may be still images/cards before warn / fail. */
  qa?: { stillWarn?: number; stillFail?: number };
  /** Official photo importer: brand name -> manufacturer domain. */
  official?: { brands: Record<string, string> };
  llmGuidance: string;
  disclaimer: string;
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
export function nicheHints(n: Niche): [RegExp, string][] {
  return n.stock.hints.map(([words, q]) => [new RegExp("\\b(?:" + words + ")\\b", "i"), q]);
}

/** True when a stock result's title/tags hit the niche's blocked list. */
export function isBlocked(n: Niche, text: string): boolean {
  const t = text.toLowerCase();
  return n.stock.blockedTerms.some((b) => t.includes(b.toLowerCase()));
}

/** Project setting wins, then the channel's style.json, then "general". */
export function projectNicheName(project: { niche?: string }, style: Record<string, unknown>): string {
  return project.niche ?? (typeof style.niche === "string" ? style.niche : undefined) ?? "general";
}
