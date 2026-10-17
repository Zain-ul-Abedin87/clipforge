import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./project.js";
import { norm } from "./text.js";
import type { ModelIdentity, ProductRecord } from "../domain/product.types.js";

export type { ModelIdentity, ProductRecord };


export interface ResearchFile {
  products: ProductRecord[];
}

const FILE = "product_research.json";

export function readResearch(dir: string): ProductRecord[] {
  const f = path.join(dir, FILE);
  return fs.existsSync(f) ? readJson<ResearchFile>(f).products ?? [] : [];
}

export function writeResearch(dir: string, products: ProductRecord[]): void {
  writeJson(path.join(dir, FILE), { products } satisfies ResearchFile);
}

// ---------------------------------------------------------------------------------------------
// Amazon URLs

/** ASIN from an Amazon product URL (/dp/, /gp/product/, /gp/aw/d/, /product/), or null. */
export function parseAsin(url: string): string | null {
  const m = /(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|\/exec\/obidos\/asin\/)([A-Z0-9]{10})(?=[/?#]|$)/i.exec(url);
  return m ? m[1].toUpperCase() : null;
}

const isAmazonHost = (u: URL) => /(^|\.)amazon\.[a-z.]+$/i.test(u.hostname) || /(^|\.)amzn\.(to|com)$/i.test(u.hostname);

/**
 * Splits a pasted Amazon link into the canonical product URL (no tracking) and the affiliate link
 * (kept only when it carries an Associates tag or is a short amzn.to link).
 */
export function splitAmazonUrl(raw: string): { amazonUrl?: string; asin?: string; affiliateUrl?: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error(`not a URL: ${raw}`);
  }
  if (!isAmazonHost(u)) throw new Error(`not an Amazon link: ${u.hostname}`);
  const asin = parseAsin(u.pathname);
  const affiliate = u.searchParams.has("tag") || /amzn\.(to|com)$/i.test(u.hostname) ? u.toString() : undefined;
  const host = /amzn\./i.test(u.hostname) ? "www.amazon.com" : u.hostname.replace(/^smile\./, "www.");
  return { ...(asin ? { asin, amazonUrl: `https://${host}/dp/${asin}` } : {}), ...(affiliate ? { affiliateUrl: affiliate } : {}) };
}

// ---------------------------------------------------------------------------------------------
// Model identity

export const DEFAULT_VARIANT_WORDS = ["pro", "max", "plus", "mini", "ultra", "lite", "air", "se", "xl", "fe", "neo", "edition", "compact", "slim", "sport", "elite", "studio"];
const ROMAN: Record<string, string> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", x: "10" };
const ORDINAL: Record<string, string> = { first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6", seventh: "7", eighth: "8", ninth: "9", tenth: "10" };


const GEN_RE = /\b(?:gen(?:eration)?\.?\s*|mk\.?\s*|mark\s+)(\d+|[ivx]+)\b|\b(\d+)(?:st|nd|rd|th)\s*gen(?:eration)?\b|\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)[\s-]+gen(?:eration)?\b/i;
const isYear = (t: string) => /^(19|20)\d\d$/.test(t);

export function parseIdentity(text: string, variantWords: string[] = DEFAULT_VARIANT_WORDS): ModelIdentity {
  const g = GEN_RE.exec(text);
  const generation = g ? (g[1] ? (ROMAN[g[1].toLowerCase()] ?? g[1]) : g[2] ?? ORDINAL[g[3]!.toLowerCase()]) : undefined;
  // Remove the generation phrase so its number is not read as a model number.
  const rest = g ? text.replace(g[0], " ") : text;
  const tokens = rest.split(/[\s/(),\-–—]+/).map(norm).filter(Boolean);
  const vw = new Set(variantWords.map((v) => v.toLowerCase()));
  return {
    tokens,
    generation,
    variants: [...new Set(tokens.filter((t) => vw.has(t)))].sort(),
    modelNumbers: [...new Set(tokens.filter((t) => /\d/.test(t) && !isYear(t)))].sort(),
  };
}

export type MatchVerdict = "match" | "conflict" | "needs_review" | "no_match";
export interface ModelMatch {
  verdict: MatchVerdict;
  reasons: string[];
}

/** Identity of a record as one string ("Apple AirPods Pro 2nd generation"). */
export function recordText(r: Pick<ProductRecord, "manufacturer" | "model" | "variant" | "generation">): string {
  // Variant / generation are often already part of the model name ("AirPods Pro 2"): add them only when missing.
  const have = new Set(`${r.manufacturer} ${r.model}`.split(/[\s/(),\-]+/).map(norm).filter(Boolean));
  const variant = r.variant && !r.variant.split(/\s+/).map(norm).every((t) => have.has(t)) ? r.variant : "";
  const gen = r.generation && !have.has(norm(r.generation)) ? `gen ${r.generation}` : "";
  return [r.manufacturer, r.model, variant, gen].filter(Boolean).join(" ");
}

/**
 * Exact manufacturer / model / variant check of a candidate's title (stock title, page title, file
 * name) against the product the scene is about.
 * - conflict: names another generation, another model number, another variant, or another manufacturer
 *   (from `knownManufacturers`). Rejected in strict niches.
 * - needs_review: the family is there but the variant / generation cannot be confirmed from the title.
 * - match: manufacturer (when required), model numbers, variants and generation all agree.
 * - no_match: the title is not about this product at all.
 */
export function verifyModelMatch(
  expected: Pick<ProductRecord, "manufacturer" | "model" | "variant" | "generation"> | string,
  candidateTitle: string,
  opts: { variantWords?: string[]; requireManufacturer?: boolean; knownManufacturers?: string[] } = {},
): ModelMatch {
  const vw = opts.variantWords ?? DEFAULT_VARIANT_WORDS;
  const expText = typeof expected === "string" ? expected : recordText(expected);
  const exp = parseIdentity(expText, vw);
  const cand = parseIdentity(candidateTitle, vw);
  const manufacturer = typeof expected === "string" ? exp.tokens[0] : norm(expected.manufacturer.split(/\s+/)[0] ?? "");
  const reasons: string[] = [];
  const candSet = new Set(cand.tokens);

  // Family = the model's own words that are neither variants nor numbers ("airpods", "galaxy", "watch").
  const family = exp.tokens.filter((t) => t !== manufacturer && !exp.variants.includes(t) && !exp.modelNumbers.includes(t));
  const familyHit = family.filter((t) => candSet.has(t)).length;
  const numberHit = exp.modelNumbers.filter((t) => candSet.has(t)).length;
  if ((family.length && !familyHit && !numberHit) || (!family.length && exp.modelNumbers.length && !numberHit)) {
    return { verdict: "no_match", reasons: ["product family / model number not in the title"] };
  }

  const others = (opts.knownManufacturers ?? []).map((m) => norm(m)).filter((m) => m && m !== manufacturer);
  const otherBrand = others.find((m) => candSet.has(m));
  if (otherBrand) reasons.push(`conflict: manufacturer ${otherBrand}`);
  if (exp.generation && cand.generation && exp.generation !== cand.generation) reasons.push(`conflict: generation ${cand.generation} vs ${exp.generation}`);
  if (!exp.generation && cand.generation && exp.modelNumbers.length === 0) reasons.push(`conflict: generation ${cand.generation} (none expected)`);
  // Model numbers: any number in the title that the product does not have is another model.
  const extraNumbers = cand.modelNumbers.filter((t) => !exp.modelNumbers.includes(t) && !(exp.generation && t === exp.generation));
  const missingNumbers = exp.modelNumbers.filter((t) => !candSet.has(t) && !(cand.generation && t === cand.generation));
  if (extraNumbers.length && missingNumbers.length) reasons.push(`conflict: model ${extraNumbers.join("/")} vs ${missingNumbers.join("/")}`);
  else if (extraNumbers.length) reasons.push(`conflict: extra model number ${extraNumbers.join("/")}`);
  const extraVariants = cand.variants.filter((v) => !exp.variants.includes(v));
  if (extraVariants.length) reasons.push(`conflict: variant ${extraVariants.join("/")}`);
  if (reasons.length) return { verdict: "conflict", reasons };

  const missingVariants = exp.variants.filter((v) => !candSet.has(v));
  if (missingVariants.length) reasons.push(`variant ${missingVariants.join("/")} not named`);
  if (exp.generation && !cand.generation && !candSet.has(exp.generation)) reasons.push(`generation ${exp.generation} not named`);
  if (missingNumbers.length) reasons.push(`model number ${missingNumbers.join("/")} not named`);
  if (opts.requireManufacturer && manufacturer && !candSet.has(manufacturer)) reasons.push(`manufacturer ${manufacturer} not named`);
  return reasons.length ? { verdict: "needs_review", reasons } : { verdict: "match", reasons: ["manufacturer, model, variant and generation agree"] };
}

// ---------------------------------------------------------------------------------------------
// Records

/** First guess of a record from the name the script uses ("Sony WH-1000XM5" -> Sony / WH-1000XM5). */
/** Brands whose name is more than one word (the first word alone would split "John Deere Z930M" wrongly). */
export const MULTIWORD_BRANDS = ["John Deere", "Cub Cadet", "Troy-Bilt", "Bad Boy", "Briggs & Stratton", "Black+Decker", "Black & Decker", "Smith & Wesson", "Sig Sauer", "Rock Island Armory", "Spartan Mowers", "Big Dog", "Hustler Turf"];

export function recordFromName(name: string, variantWords: string[] = DEFAULT_VARIANT_WORDS): ProductRecord {
  const multi = MULTIWORD_BRANDS.find((b) => name.toLowerCase().startsWith(b.toLowerCase() + " "));
  const words = name.trim().split(/\s+/);
  const brandWords = multi ? multi.split(/\s+/).length : 1;
  const manufacturer = words.slice(0, brandWords).join(" ");
  const rest = words.slice(brandWords).join(" ");
  const id = parseIdentity(rest, variantWords);
  const variant = words.slice(1).filter((w) => id.variants.includes(norm(w))).join(" ");
  return {
    name,
    manufacturer,
    model: rest,
    ...(variant ? { variant } : {}),
    ...(id.generation ? { generation: id.generation } : {}),
    specUrls: [],
    status: "unverified",
  };
}

/** Adds a record for every product name not yet researched; returns the full list. */
export function ensureProductRecords(dir: string, names: string[]): ProductRecord[] {
  const list = readResearch(dir);
  const have = new Set(list.map((r) => r.name.toLowerCase()));
  let added = 0;
  for (const n of names) {
    if (!n || have.has(n.toLowerCase())) continue;
    list.push(recordFromName(n));
    have.add(n.toLowerCase());
    added++;
  }
  if (added) writeResearch(dir, list);
  return list;
}

/** Applies a user edit (Amazon link, spec pages, corrected identity) to one record. */
export function updateProductRecord(dir: string, name: string, patch: Partial<ProductRecord> & { amazon?: string }): ProductRecord {
  const list = readResearch(dir);
  let rec = list.find((r) => r.name.toLowerCase() === name.toLowerCase());
  if (!rec) list.push((rec = recordFromName(name)));
  for (const k of ["manufacturer", "model", "variant", "generation", "notes"] as const) {
    if (typeof patch[k] === "string") rec[k] = patch[k]!.trim().slice(0, 200) || undefined!;
  }
  if (patch.amazon) Object.assign(rec, splitAmazonUrl(patch.amazon));
  if (Array.isArray(patch.specUrls)) {
    rec.specUrls = patch.specUrls.map((u) => String(u).trim()).filter((u) => {
      try {
        return /^https?:$/.test(new URL(u).protocol);
      } catch {
        return false;
      }
    });
  }
  if (patch.status === "verified" || patch.status === "needs_review" || patch.status === "unverified") rec.status = patch.status;
  rec.updatedAt = new Date().toISOString();
  writeResearch(dir, list);
  return rec;
}

/**
 * Footage search phrase for a product: identity words only. Affiliate links, ASINs and any URL are
 * refused so commerce data can never leak into footage search.
 */
export function footageQuery(r: ProductRecord, suffix = ""): string {
  const q = [recordText(r), suffix].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  assertNoCommerceData(q, r);
  return q;
}

export function assertNoCommerceData(query: string, r?: Pick<ProductRecord, "asin" | "affiliateUrl" | "amazonUrl">): void {
  if (/https?:\/\/|www\.|amzn\.|[?&]tag=/i.test(query)) throw new Error(`footage query contains a link: "${query}"`);
  if (r?.asin && query.toUpperCase().includes(r.asin)) throw new Error(`footage query contains the ASIN: "${query}"`);
}
