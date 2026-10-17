import fs from "node:fs";
import { env } from "../env.js";
import path from "node:path";
import type { ActiveSubject, SpecVisualTag } from "../../domain/product.types.js";
import { productKey } from "../../domain/product.types.js";
import { titleHasModel } from "../agents/youtube/ytExtractor.js";
import { audioLevels, MicroCut, silentRanges, sliceScene, TimedWord } from "../engine/pacing/autoEditor.js";
import { productRegions } from "../assets/productPool.js";
import { recordFromName } from "../productResearch.js";
import { writeJson } from "../project.js";
import type { Scene } from "../scenes.js";

/**
 * Active subject per micro-scene: which product it is about and which filmable spec the line
 * names ("brushless motor" -> a close-up of the motor). Locked at plan time and written to
 * <project>/micro_scenes.json; the pacing engine cuts on these boundaries and prefers vault shots
 * that were cut around the same spoken spec.
 */

/** Filmable specs of tech gadgets / power tools / mowers, most specific first. */
export const SPEC_LEXICON: SpecVisualTag[] = [
  { spec: "brushless motor", keywords: ["brushless motor", "brushless"], visual: "close up of the brushless motor" },
  { spec: "battery", keywords: ["battery pack", "battery", "batteries", "amp hour", "ah battery"], visual: "close up of the battery being inserted" },
  { spec: "charger", keywords: ["rapid charger", "charger", "charging"], visual: "battery on the charger with lights on" },
  { spec: "battery chemistry", keywords: ["lithium ion", "lithium-ion", "cell chemistry", "energy density"], visual: "battery cells inside a pack", diagramFallback: true },
  { spec: "voltage", keywords: ["volt", "volts", "voltage"], visual: "battery voltage label close up", diagramFallback: true },
  { spec: "deck", keywords: ["steel deck", "cutting deck", "deck"], visual: "close up of the mower deck" },
  { spec: "blades", keywords: ["blades", "blade"], visual: "close up of the cutting blade" },
  { spec: "height adjustment", keywords: ["height adjustment", "cutting height", "height lever", "height settings"], visual: "hand moving the cutting height lever" },
  { spec: "self-propelled drive", keywords: ["self propelled", "self-propelled", "drive system", "rear wheel drive"], visual: "mower driving itself across the lawn" },
  { spec: "mulching", keywords: ["mulching", "mulch"], visual: "mower mulching grass clippings" },
  { spec: "grass bag", keywords: ["grass bag", "bagging", "collection bag", "catcher"], visual: "grass bag being removed and emptied" },
  { spec: "folding handle", keywords: ["folding handle", "folds", "fold flat", "vertical storage", "compact storage"], visual: "handle folding for storage" },
  { spec: "headlights", keywords: ["led headlights", "headlights", "led lights"], visual: "led headlights turned on" },
  { spec: "push button start", keywords: ["push button start", "push-button start", "start button"], visual: "finger pressing the start button" },
  { spec: "striping", keywords: ["striping", "stripes", "striping kit"], visual: "lawn stripes behind the mower" },
  { spec: "display", keywords: ["display", "screen", "touchscreen"], visual: "close up of the display" },
  { spec: "camera", keywords: ["camera", "lens", "megapixel"], visual: "close up of the camera lens" },
  { spec: "ports", keywords: ["usb-c", "usb c", "ports", "hdmi"], visual: "close up of the ports" },
  { spec: "speaker", keywords: ["speakers", "speaker", "sound quality"], visual: "close up of the speaker grille" },
  { spec: "noise cancelling", keywords: ["noise cancelling", "noise canceling", "anc"], visual: "headphones being worn", diagramFallback: true },
  { spec: "trigger", keywords: ["variable speed trigger", "trigger"], visual: "finger squeezing the trigger" },
  { spec: "chuck", keywords: ["keyless chuck", "chuck"], visual: "close up of the drill chuck" },
  { spec: "cooling", keywords: ["cooling", "vents", "airflow", "fan"], visual: "close up of the cooling vents", diagramFallback: true },
  { spec: "build quality", keywords: ["build quality", "metal body", "aluminum", "aluminium", "steel frame"], visual: "close up of the body material" },
];

const normText = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim()} `;

/** Specs the text names, longest keyword first, each spec once. */
export function detectSpecs(text: string, lexicon: SpecVisualTag[] = SPEC_LEXICON): SpecVisualTag[] {
  const t = normText(text);
  const hits: { tag: SpecVisualTag; at: number; len: number }[] = [];
  for (const tag of lexicon) {
    for (const k of [...tag.keywords].sort((a, b) => b.length - a.length)) {
      const at = t.indexOf(normText(k));
      if (at >= 0) {
        hits.push({ tag, at, len: k.length });
        break;
      }
    }
  }
  // Overlapping keywords ("brushless motor" vs "motor"): keep the longest; then in spoken order.
  return hits
    .sort((a, b) => b.len - a.len)
    .filter((h, i, all) => !all.slice(0, i).some((o) => h.at >= o.at && h.at < o.at + o.len + 1))
    .sort((a, b) => a.at - b.at)
    .map((h) => h.tag);
}

/**
 * The subject of one line: a product the line names (brand + exact model, or the model alone) wins;
 * otherwise the product of the listicle section it sits in; otherwise none.
 */
export function lockSubject(text: string, sectionProduct: string | undefined, products: string[]): ActiveSubject {
  const spec = detectSpecs(text)[0];
  const named = products
    .map((name) => ({ name, rec: recordFromName(name) }))
    .filter(({ name, rec }) => titleHasModel(text, rec.model || name))
    .sort((a, b) => b.rec.model.length - a.rec.model.length)[0];
  const pick = named?.name ?? sectionProduct;
  if (!pick) return { productKey: null, confidence: 0, reason: "none", ...(spec ? { spec } : {}) };
  const rec = recordFromName(pick);
  const product = { manufacturer: rec.manufacturer, model: rec.model, ...(rec.variant ? { variant: rec.variant } : {}), ...(rec.generation ? { generation: rec.generation } : {}) };
  return { productKey: productKey(product), product, ...(spec ? { spec } : {}), confidence: named ? 0.95 : 0.7, reason: named ? "named" : "section" };
}

export interface MicroScene extends MicroCut {
  id: number;
  sceneId: number;
  /** Product name as the script says it (pool / vault lookups use names). */
  productName?: string;
  subject: ActiveSubject;
}

export interface MicroPlan {
  version: 1;
  fps: string;
  threshold: number;
  scenes: MicroScene[];
  /** Specs per product the narration names, for keyword harvesting. */
  specsByProduct: Record<string, string[]>;
}

export const microPlanFile = (dir: string) => path.join(dir, "micro_scenes.json");

/** Niche "pacing": { "micro": true | {minSec, maxSec, targetSec} }; MICRO_SCENES=on/off overrides. */
export function microConfig(niche: unknown): { enabled: boolean; minSec: number; maxSec: number; targetSec: number } {
  const p = ((niche as { pacing?: { micro?: unknown } }).pacing?.micro ?? false) as boolean | { minSec?: number; maxSec?: number; targetSec?: number };
  const flag = env("MICRO_SCENES", "").toLowerCase();
  const enabled = flag === "on" ? true : flag === "off" ? false : !!p;
  const o = typeof p === "object" && p ? p : {};
  return { enabled, minSec: o.minSec ?? 2.5, maxSec: o.maxSec ?? 4, targetSec: o.targetSec ?? 3.2 };
}

export function readMicroPlan(dir: string): MicroPlan | null {
  const f = microPlanFile(dir);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as MicroPlan) : null;
}

/** Slices every non-graphic scene into 2.5-4 s micro-scenes and locks each one's subject. */
export async function buildMicroPlan(
  dir: string,
  o: { ffmpeg: string; audio: string; words: TimedWord[]; scenes: Scene[]; threshold?: number; minSec?: number; maxSec?: number; targetSec?: number },
  log: (m: string) => void = () => {},
): Promise<MicroPlan> {
  const threshold = o.threshold ?? 0.04;
  const levels = await audioLevels(o.ffmpeg, o.audio, 30);
  // Tight margin: we only need the centre of each pause as a cut point. (auto-editor's 0.2 s margin
  // keeps breath around speech in ITS output; here it would swallow a 0.4 s pause completely.)
  const silences = silentRanges(levels, { threshold, margin: 0.05, minSilence: 0.15 });
  const regions = productRegions(o.scenes);
  const sectionOf = new Map<number, string>();
  for (const [name, list] of regions) for (const s of list) sectionOf.set(s.id, name);
  const products = [...new Set([...regions.keys(), ...o.scenes.map((s) => s.product_name).filter((x): x is string => !!x)])];
  const out: MicroScene[] = [];
  for (const s of o.scenes) {
    const words = o.words.filter((w) => w.start >= s.start - 0.05 && w.start < s.end);
    // Graphic scenes (cards) stay one piece: the card animates over the whole line.
    const cuts = s.type === "graphic" ? sliceScene(s.start, s.end, words, [], { minSec: 1e6, maxSec: 1e6 }) : sliceScene(s.start, s.end, words, silences, { minSec: o.minSec, maxSec: o.maxSec, targetSec: o.targetSec });
    for (const c of cuts) {
      const subject = lockSubject(c.text || s.text, s.product_name ?? sectionOf.get(s.id), products);
      const productName = subject.product ? products.find((p) => productKey(recordFromName(p)) === subject.productKey) : undefined;
      out.push({ ...c, id: out.length, sceneId: s.id, ...(productName ? { productName } : {}), subject });
    }
  }
  const specsByProduct: Record<string, string[]> = {};
  for (const m of out) if (m.productName && m.subject.spec) specsByProduct[m.productName] = [...new Set([...(specsByProduct[m.productName] ?? []), m.subject.spec.spec])];
  const plan: MicroPlan = { version: 1, fps: "30", threshold, scenes: out, specsByProduct };
  writeJson(microPlanFile(dir), plan);
  const lens = out.map((m) => (m.endFrame - m.startFrame) / 30);
  log(`[micro] ${out.length} micro-scene(s) from ${o.scenes.length} scenes: avg ${(lens.reduce((a, b) => a + b, 0) / Math.max(1, lens.length)).toFixed(2)} s, ${silences.length} silence(s) detected, ${out.filter((m) => m.subject.spec).length} with a spec tag`);
  return plan;
}
