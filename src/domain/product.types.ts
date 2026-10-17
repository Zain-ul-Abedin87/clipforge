/**
 * Product domain: who makes it, which exact model / variant / generation it is, which specs the
 * script talks about, and which product + spec a scene is "about" (its active subject).
 * Pure data types plus tiny pure helpers; no I/O.
 */

/** Exact identity: "Ryobi" / "RY401150" / variant "HP" / generation "2". */
export interface ProductIdentity {
  manufacturer: string;
  model: string;
  variant?: string;
  generation?: string;
}

/** Research record per product (workspace/<project>/product_research.json). */
export interface ProductRecord extends ProductIdentity {
  /** The name as the script says it ("EGO Power+ LM2135SP"). */
  name: string;
  /** Canonical product page without tracking (https://www.amazon.com/dp/<ASIN>). */
  amazonUrl?: string;
  asin?: string;
  /** The user's affiliate link (tag=...). Description / pinned comment only, never a footage search term. */
  affiliateUrl?: string;
  /** Manufacturer spec / product pages. */
  specUrls: string[];
  /** verified = identity confirmed by the user or an official page; needs_review = ambiguous. */
  status: "verified" | "needs_review" | "unverified";
  notes?: string;
  updatedAt?: string;
}

/** Parsed identity tokens of a name or a video title (see productResearch.parseIdentity). */
export interface ModelIdentity {
  /** Lower-case word tokens (numbers as digits). */
  tokens: string[];
  /** "3" for "Gen 3", "3rd generation", "Mk III". */
  generation?: string;
  variants: string[];
  /** Tokens mixing letters and digits, or plain numbers: "p365", "s24", "15". Years excluded. */
  modelNumbers: string[];
}

/** Where a spec value came from: the narration, the maker's page, or a review. */
export type SpecSource = "script" | "manufacturer" | "review";

/** One concrete spec ("Motor" / "brushless", "Run time" / "60 min", "Deck" / "21 in steel"). */
export interface ProductSpec {
  key: string;
  label: string;
  value: string;
  unit?: string;
  source: SpecSource;
  sourceUrl?: string;
}

/**
 * A spec the narration mentions that can be SHOWN ("brushless motor" -> close-up of the motor).
 * `keywords` are what we look for in YouTube captions / titles; `visual` is the shot to find.
 */
export interface SpecVisualTag {
  /** Canonical spec name, e.g. "brushless motor". */
  spec: string;
  /** Words / phrases that mean this spec in speech ("brushless", "brush-less motor"). */
  keywords: string[];
  /** What the shot should show, for CLIP ("close up of the brushless motor housing"). */
  visual: string;
  /** Specs with nothing filmable (e.g. battery chemistry) can fall back to a diagram. */
  diagramFallback?: boolean;
}

/** What a scene is about. Locked at plan time so footage, overlays and QA agree. */
export interface ActiveSubject {
  /** Key of the product (see productKey) or null for a generic / intro scene. */
  productKey: string | null;
  product?: ProductIdentity;
  spec?: SpecVisualTag;
  /** 0..1 how sure the planner is (name in the sentence = high; inherited from the section = lower). */
  confidence: number;
  /** "named" = the sentence names it; "section" = inherited from the listicle item; "nearest" = borrowed. */
  reason: "named" | "section" | "nearest" | "none";
}

const slug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

/** Stable id for a product: "ryobi_ry401150-hp". */
export function productKey(p: Pick<ProductIdentity, "manufacturer" | "model" | "variant">): string {
  const model = p.variant && !p.model.toLowerCase().includes(p.variant.toLowerCase()) ? `${p.model} ${p.variant}` : p.model;
  return `${slug(p.manufacturer)}_${slug(model)}`;
}

/** "Ryobi RY401150 HP gen 2" (variant / generation only when not already in the model). */
export function identityText(p: ProductIdentity): string {
  const m = p.model.toLowerCase();
  const variant = p.variant && !m.includes(p.variant.toLowerCase()) ? p.variant : "";
  const gen = p.generation && !m.includes(p.generation.toLowerCase()) ? `gen ${p.generation}` : "";
  return [p.manufacturer, p.model, variant, gen].filter(Boolean).join(" ");
}
