/**
 * Niche auto-detect: Haiku reads title + script, returns a product category and search/pacing
 * hints, then we assemble a full niches/*_web.json-shaped config into <project>/niche.json.
 * Used by the "auto" channel preset. Without ANTHROPIC_API_KEY, a keyword heuristic is used.
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env, hasKey } from "./env.js";
import { agentEnabled, agentModel } from "./agent/footage.js";
import type { Niche } from "./niche.js";
import { isBrandHint, nichesDir } from "./niche.js";

export interface DetectMeta {
  source: "llm" | "heuristic";
  category: string;
  targetShotSec: number;
}

const HintSchema = z.object({
  words: z.string(),
  query: z.string(),
});

const DetectSchema = z.object({
  category: z.string(),
  label: z.string(),
  targetShotSec: z.number(),
  fallbackQuery: z.string(),
  allowStock: z.boolean(),
  productCategory: z.string(),
  productQueries: z.array(z.string()).min(3).max(10),
  stockHints: z.array(HintSchema).max(24),
  blockedTerms: z.array(z.string()).max(40),
  llmGuidance: z.string(),
  disclaimer: z.string(),
  mix: z.object({
    closeup: z.number().optional(),
    handson: z.number().optional(),
    field: z.number().optional(),
    lifestyle: z.number().optional(),
    promo: z.number().optional(),
    amazon: z.number().optional(),
  }),
});

type DetectOut = z.infer<typeof DetectSchema>;

const SYSTEM = `You classify a faceless YouTube product-listicle script so the editor can pick the right footage rules.
Return JSON with:
- category: short snake_case product world (firearms, tech_gadgets, kitchen, tools, outdoor, fitness, beauty, auto, pets, general, ...)
- label: human label, e.g. "Kitchen appliances"
- targetShotSec: average cut length. Use 2.1 for phones/headphones/gadgets, 2.5 for firearms/tactical gear, 2.3 for everything else. Stay between 1.8 and 3.0.
- fallbackQuery: safe 2-5 word stock B-roll search if nothing else matches
- allowStock: false ONLY when every product shot must be the exact named model (typical for firearms). true for most consumer niches where stock B-roll of the category is fine.
- productCategory: one word for the product pool (pistol, gadget, blender, drill, ...)
- productQueries: 5 YouTube/web search templates that include the literal token {name} (e.g. "{name} review", "{name} unboxing", "{name} close up", "{name} official", "{name} hands on"). Match the category.
- stockHints: up to 16 objects {words, query}. words is |separated whole-word stems from the narration; query is a 2-5 word stock search. Cover category B-roll, close-ups, lifestyle, retail, price. Never a hint about brands or brand comparisons and no brand names in words: brand/product mentions are handled by the exact-model product pool.
- blockedTerms: titles/tags to reject (toys, cartoons, wrong domains for the niche)
- llmGuidance: 1-3 sentences for the planner about what to show
- disclaimer: legal/safety line if needed (firearms, knives, supplements), else ""
- mix: shot-type percentages totaling ~100 among keys closeup, handson, field, lifestyle, promo, amazon (omit unused)

Stay product-agnostic: do not assume guns. Infer only from the given title and script.`;

function pacingForCategory(cat: string): number {
  const c = cat.toLowerCase();
  if (/(firearm|gun|pistol|rifle|tactical|ccw)/.test(c)) return 2.5;
  if (/(tech|gadget|phone|audio|headphone|laptop|electronics)/.test(c)) return 2.1;
  return 2.3;
}

/** Keyword fallback when there is no API key or the LLM fails. */
export function heuristicDetect(title: string, script: string): DetectOut {
  const t = `${title}\n${script}`.toLowerCase();
  const guns = /\b(pistol|handgun|rifle|shotgun|firearm|ccw|9mm|\.380|glock|sig\b|ruger|taurus|holster|ammo|concealed carry)\b/.test(t);
  const tech = /\b(phone|smartphone|headphones?|earbuds?|laptop|gadget|iphone|android|tablet|bluetooth|noise.?cancell|charger|webcam|smartwatch)\b/.test(t);
  const kitchen = /\b(blender|air fryer|cookware|kitchen|spatula|mixer|toaster|instant pot|knife set|dutch oven|coffee maker)\b/.test(t);

  if (guns) {
    return {
      category: "firearms",
      label: "Firearms / carry gear",
      targetShotSec: 2.5,
      fallbackQuery: "outdoor shooting range",
      allowStock: false,
      productCategory: "pistol",
      productQueries: ["{name} review", "{name} range test", "{name} official", "{name} shooting", "{name} close up", "{name} table review"],
      stockHints: [
        { words: "pistol|handgun|9mm|concealed carry|ccw", query: "pistol shooting range" },
        { words: "rifle|scope|ar-15", query: "rifle scope shooting range" },
        { words: "shotgun|12 gauge", query: "clay shooting shotgun" },
        { words: "holster|belt", query: "gun holster on belt" },
        { words: "ammo|ammunition|bullets?", query: "ammunition bullets close up" },
        { words: "price|budget|dollars|money", query: "money wallet cash" },
        { words: "range|target|shooting", query: "outdoor shooting range" },
        { words: "truck|vehicle|road", query: "pickup truck on dirt road" },
      ],
      blockedTerms: ["toy", "airsoft", "nerf", "cartoon", "video game", "military", "war", "soldier"],
      llmGuidance: "Firearms listicle: each product scene must show the exact named model. B-roll is ranges, gear tables, holsters, ammo, gun stores — never violence or toys.",
      disclaimer: "This video is for educational and entertainment purposes only. Always follow local laws regarding firearms.",
      mix: { closeup: 35, field: 28, handson: 19, amazon: 5, promo: 3 },
    };
  }
  if (tech) {
    return {
      category: "tech_gadgets",
      label: "Tech / gadgets",
      targetShotSec: 2.1,
      fallbackQuery: "city aerial view",
      allowStock: true,
      productCategory: "gadget",
      productQueries: ["{name} official video", "{name} promo", "{name} review", "{name} hands on", "{name} unboxing", "{name} lifestyle"],
      stockHints: [
        { words: "headphones?|earbuds?|noise.?cancell", query: "wireless headphones close up" },
        { words: "phone|smartphone|iphone|android", query: "smartphone hands close up" },
        { words: "laptop|notebook", query: "laptop on desk typing" },
        { words: "battery|charge|charging", query: "phone charging cable" },
        { words: "price|budget|dollars|deal", query: "online shopping phone" },
        { words: "unbox|box|packaging", query: "product unboxing table" },
      ],
      blockedTerms: ["cartoon", "video game"],
      llmGuidance: "Tech listicle: show the named gadget first (official/promo/hands-on), then lifestyle B-roll matching the narration.",
      disclaimer: "",
      mix: { handson: 41, lifestyle: 14, amazon: 12, promo: 11, field: 10, closeup: 8 },
    };
  }
  if (kitchen) {
    return {
      category: "kitchen",
      label: "Kitchen / appliances",
      targetShotSec: 2.3,
      fallbackQuery: "modern kitchen countertop",
      allowStock: true,
      productCategory: "appliance",
      productQueries: ["{name} review", "{name} demo", "{name} unboxing", "{name} official", "{name} in kitchen", "{name} close up"],
      stockHints: [
        { words: "blender|smoothie", query: "blender making smoothie" },
        { words: "air fryer|fry", query: "air fryer kitchen counter" },
        { words: "cookware|pan|skillet", query: "frying pan on stove" },
        { words: "knife|blade|cutting", query: "chef chopping vegetables" },
        { words: "coffee|espresso", query: "coffee maker pouring" },
        { words: "price|budget|deal", query: "kitchen store aisle" },
      ],
      blockedTerms: ["cartoon", "toy kitchen"],
      llmGuidance: "Kitchen listicle: show the appliance in use, food prep close-ups, and clean countertop lifestyle shots.",
      disclaimer: "",
      mix: { handson: 40, lifestyle: 20, closeup: 20, promo: 10, amazon: 10 },
    };
  }
  return {
    category: "general",
    label: "General products",
    targetShotSec: 2.3,
    fallbackQuery: "lifestyle product table",
    allowStock: true,
    productCategory: "product",
    productQueries: ["{name} review", "{name} unboxing", "{name} official", "{name} demo", "{name} close up"],
    stockHints: [
      { words: "price|budget|dollars|deal", query: "online shopping" },
      { words: "unbox|box|packaging", query: "product unboxing table" },
      { words: "review|hands on|demo", query: "hands holding product" },
    ],
    blockedTerms: ["cartoon"],
    llmGuidance: "General product listicle: show each named product, then literal B-roll of what the narration describes.",
    disclaimer: "",
    mix: { handson: 35, closeup: 25, lifestyle: 20, promo: 10, amazon: 10 },
  };
}

function assembleNiche(d: DetectOut): Niche & Record<string, unknown> {
  const target = Math.min(3, Math.max(1.8, Number(d.targetShotSec) || pacingForCategory(d.category)));
  const minShot = Math.round(target * 0.52 * 10) / 10;
  const maxShot = Math.round(target * 1.4 * 10) / 10;
  const queries = (d.productQueries?.length ? d.productQueries : ["{name} review", "{name} official", "{name} close up"])
    .map((q) => {
      let t = String(q).replace(/^[^\w{]+/, "").replace(/\s+/g, " ").trim();
      if (!t.includes("{name}")) t = `{name} ${t}`;
      return t;
    })
    .filter((q) => q.length > 6)
    .slice(0, 8);
  const hints: [string, string][] = (d.stockHints ?? [])
    .map((h) => [String(h.words ?? ""), String(h.query ?? "")] as [string, string])
    .filter((h) => h[0] && h[1])
    .filter((h) => !isBrandHint(h[0], h[1]))
    .slice(0, 20);
  const mixRaw = d.mix && typeof d.mix === "object"
    ? Object.fromEntries(Object.entries(d.mix).filter(([, v]) => typeof v === "number"))
    : {};
  const mix = Object.keys(mixRaw).length ? mixRaw : { handson: 40, closeup: 25, lifestyle: 20, promo: 15 };

  // Base shape matches niches/tech_web.json / guns_web.json (web crawl + product pool + pacing).
  const baseFile = path.join(nichesDir, d.allowStock === false ? "guns_web.json" : "tech_web.json");
  const base = fs.existsSync(baseFile)
    ? (JSON.parse(fs.readFileSync(baseFile, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>)
    : {};

  const niche = {
    ...base,
    name: "auto",
    label: `${d.label} (auto-detect)`,
    description: `Auto-detected niche: ${d.category}. Generated from the project script.`,
    structure: {
      detectListicle: true,
      titleCardPerItem: true,
      maxPriceBadgesPerItem: 1,
      maxProsConsPerItem: 1,
      targetGraphicShare: d.allowStock === false ? 0.25 : 0.2,
    },
    scenes: {
      avgLengthSec: d.allowStock === false ? 4 : 7,
      minLengthSec: d.allowStock === false ? 3 : 5,
      maxLengthSec: d.allowStock === false ? 5.5 : 10,
    },
    product: {
      sources: ["local", "presskit", "official", "wikimedia", "unsplash"],
      allowStock: !!d.allowStock,
      ...(d.allowStock === false ? { genericFallback: true } : {}),
    },
    stock: {
      hints,
      sectionHintCount: Math.min(5, hints.length),
      fallbackQuery: d.fallbackQuery || "lifestyle product table",
      sources: d.allowStock === false
        ? ["pixabay", "pexels", "wikimedia_video", "web_crawl"]
        : ["storyblocks", "pexels", "pixabay", "wikimedia_video", "unsplash", "archive", "web_crawl"],
      blockedTerms: [...new Set([...(d.blockedTerms ?? []), "cartoon"])],
    },
    llmGuidance: d.llmGuidance || "Show the named product, then B-roll matching the narration.",
    disclaimer: d.disclaimer || "",
    qa: { stillWarn: 0.5, stillFail: 0.65 },
    pacing: {
      enabled: true,
      targetShotSec: target,
      minShotSec: minShot,
      maxShotSec: maxShot,
      openingSec: 30,
      openingFactor: d.allowStock === false ? 0.8 : 0.95,
      laterFactor: 1.04,
      _source: `auto-detect:${d.category}`,
    },
    productPool: {
      enabled: true,
      target: 40,
      maxPerUploader: 8,
      maxShotSec: 3,
      category: d.productCategory || "product",
      imgMin: 0.72,
      queries,
      minTarget: 12,
      mix,
      dropTypes: ["talking"],
      rankCardAtSec: [12, 15],
    },
    // Drop firearm brand map unless this really is firearms (keeps official importer honest).
    official: d.category === "firearms" && (base as { official?: unknown }).official
      ? (base as { official: unknown }).official
      : undefined,
    _detect: { category: d.category, targetShotSec: target },
  };
  return niche as Niche & Record<string, unknown>;
}

async function llmDetect(title: string, script: string, log: (m: string) => void): Promise<DetectOut | null> {
  if (!agentEnabled()) return null;
  try {
    const client = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
    const model = agentModel();
    const res = await client.messages.parse({
      model,
      max_tokens: 4000,
      ...(model.startsWith("claude-haiku")
        ? { output_config: { format: zodOutputFormat(DetectSchema) } }
        : { output_config: { effort: "low" as const, format: zodOutputFormat(DetectSchema) } }),
      system: SYSTEM,
      messages: [{
        role: "user",
        content: JSON.stringify({
          title: title.slice(0, 200),
          script: script.slice(0, 12000),
        }),
      }],
    });
    if (res.parsed_output) {
      log(`[niche-detect] LLM category=${res.parsed_output.category} pace=${res.parsed_output.targetShotSec}s (${res.usage.input_tokens} in / ${res.usage.output_tokens} out)`);
      return res.parsed_output;
    }
  } catch (err) {
    log(`[niche-detect] LLM failed, using heuristic: ${String((err as Error).message ?? err).slice(0, 160)}`);
  }
  return null;
}

/** Detect niche from title+script, write <dir>/niche.json, return niche + meta. */
export async function detectAndWriteNiche(
  dir: string,
  opts: { title?: string; script: string },
  log: (m: string) => void = console.log,
): Promise<{ niche: Niche; meta: DetectMeta }> {
  fs.mkdirSync(dir, { recursive: true });
  const title = (opts.title ?? "").trim();
  const script = (opts.script ?? "").trim();
  let raw = await llmDetect(title, script, log);
  let source: DetectMeta["source"] = "llm";
  if (!raw) {
    raw = heuristicDetect(title, script);
    source = "heuristic";
    log(`[niche-detect] heuristic category=${raw.category} pace=${raw.targetShotSec}s`);
  }
  // Clamp pacing to study values when category is clear.
  if (!Number.isFinite(raw.targetShotSec)) raw.targetShotSec = pacingForCategory(raw.category);
  const niche = assembleNiche(raw);
  const out = path.join(dir, "niche.json");
  fs.writeFileSync(out, JSON.stringify(niche, null, 2) + "\n", "utf8");
  log(`[niche-detect] wrote ${out}`);
  return {
    niche: niche as Niche,
    meta: { source, category: raw.category, targetShotSec: Number((niche as { pacing?: { targetShotSec?: number } }).pacing?.targetShotSec ?? raw.targetShotSec) },
  };
}

export function readProjectNicheFile(dir: string): Niche | null {
  const f = path.join(dir, "niche.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")) as Niche;
  } catch {
    return null;
  }
}
