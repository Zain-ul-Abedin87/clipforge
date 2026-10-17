import fs from "node:fs";
import path from "node:path";
import type { ProductRecord, SpecVisualTag } from "../../domain/product.types.js";
import { env } from "../env.js";
import type { PoolShot } from "../assets/productPool.js";
import { readJson, writeJson } from "../project.js";
import { diagramName, generateDiagram } from "./generative/manimAgent.js";
import { findKeywordItems, findVaultFor, harvestKeyword, harvestModel, HarvestResult, KeywordHarvestOpts, HarvestOpts } from "./youtube/ytExtractor.js";

/**
 * Auto-fetch on demand. Before the assets step picks footage, it works out what is missing:
 *   - a product with no model vault, or fewer than AUTO_FETCH_MIN_CLIPS verified clips;
 *   - a spec the narration names (micro_scenes.json) with no vault clip cut around it.
 * The pipeline waits ("pauses") while these are fetched from YouTube (titles matched with typo
 * tolerance, digits exact), saved to the vault, then continues. An internal spec that still has
 * no real footage (battery chemistry, voltage, cooling...) gets a generated diagram instead.
 */

export interface FetchNeed {
  product: string;
  brand: string;
  model: string;
  kind: "model" | "spec";
  spec?: SpecVisualTag;
  /** For the log: why it is needed. */
  why: string;
}

export interface FootageState {
  /** Verified video clips in the product's vault (0 = no vault). */
  clips: (product: string) => number;
  /** The vault already has clips cut around this spec. */
  hasSpec: (product: string, spec: string) => boolean;
}

/** What to fetch, in order: whole-model vaults first (spec searches reuse their titles), then specs. */
export function planFetches(products: ProductRecord[], specsByProduct: Record<string, SpecVisualTag[]>, state: FootageState, minClips = 6): FetchNeed[] {
  const out: FetchNeed[] = [];
  for (const p of products) {
    const n = state.clips(p.name);
    if (n < minClips) out.push({ product: p.name, brand: p.manufacturer, model: p.model, kind: "model", why: n ? `only ${n} clip(s) in the vault` : "no vault yet" });
  }
  for (const p of products) {
    for (const spec of specsByProduct[p.name] ?? []) {
      if (!state.hasSpec(p.name, spec.spec)) out.push({ product: p.name, brand: p.manufacturer, model: p.model, kind: "spec", spec, why: `narration names "${spec.spec}"` });
    }
  }
  return out;
}

export interface DiagramEntry {
  product: string;
  spec: string;
  file: string;
  engine: "manim" | "template";
  createdAt: string;
}

export interface AutoFetchReport {
  needs: FetchNeed[];
  done: { need: FetchNeed; added: number; error?: string }[];
  diagrams: DiagramEntry[];
}

const diagramsFile = (dir: string) => path.join(dir, "diagrams.json");
export const readDiagrams = (dir: string): DiagramEntry[] => (fs.existsSync(diagramsFile(dir)) ? readJson<DiagramEntry[]>(diagramsFile(dir)) : []);

/** Injectable for tests (default: the real YouTube harvesters and diagram agent). */
export interface AutoFetchDeps {
  harvestModel: (o: HarvestOpts) => Promise<Pick<HarvestResult, "added">>;
  harvestKeyword: (o: KeywordHarvestOpts) => Promise<Pick<HarvestResult, "added">>;
  generateDiagram: typeof generateDiagram;
  state: FootageState;
}

export const realState: FootageState = {
  clips: (p) => findVaultFor(p)?.manifest.items.filter((i) => i.kind === "video").length ?? 0,
  hasSpec: (p, s) => !!findKeywordItems(p, s),
};

const defaultDeps: AutoFetchDeps = { harvestModel, harvestKeyword, generateDiagram, state: realState };

export const autoFetchEnabled = () => env("AUTO_FETCH", env("AUTO_HARVEST", "on")).toLowerCase() !== "off";

/**
 * Fetches what is missing, then returns. Each fetch is independent: a failure is logged and the
 * rest continue. Diagrams are written to <project>/diagrams/ and listed in diagrams.json.
 */
export async function ensureFootage(
  dir: string,
  o: {
    products: ProductRecord[];
    specsByProduct: Record<string, SpecVisualTag[]>;
    /** Narration of the micro-scenes that name each product + spec (diagram facts). */
    narrationFor: (product: string, spec: string) => string;
    category: string;
    log: (m: string) => void;
  },
  deps: Partial<AutoFetchDeps> = {},
): Promise<AutoFetchReport> {
  const d = { ...defaultDeps, ...deps };
  const needs = planFetches(o.products, o.specsByProduct, d.state, Number(env("AUTO_FETCH_MIN_CLIPS", "6")) || 6);
  const report: AutoFetchReport = { needs, done: [], diagrams: readDiagrams(dir) };
  if (!needs.length) return report;
  o.log(`[auto-fetch] pausing assets: ${needs.length} gap(s) to fill - ${needs.map((n) => (n.kind === "model" ? `${n.product} (${n.why})` : `${n.product} / ${n.spec!.spec}`)).join(", ")}`);
  const others = (p: string) => o.products.filter((x) => x.name !== p).map((x) => x.model);
  for (const need of needs) {
    try {
      const r =
        need.kind === "model"
          ? await d.harvestModel({ brand: need.brand, model: need.model, category: o.category, otherModels: others(need.product), log: o.log })
          : await d.harvestKeyword({ brand: need.brand, model: need.model, keyword: need.spec!.spec, aliases: need.spec!.keywords, category: o.category, otherModels: others(need.product), log: o.log });
      report.done.push({ need, added: r.added });
    } catch (err) {
      report.done.push({ need, added: 0, error: String((err as Error).message ?? err).slice(0, 200) });
      o.log(`[auto-fetch] ${need.product}${need.spec ? ` / ${need.spec.spec}` : ""}: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  // Internal specs with no real footage at all: a generated diagram.
  for (const need of needs.filter((n) => n.kind === "spec" && n.spec!.diagramFallback)) {
    if (d.state.hasSpec(need.product, need.spec!.spec)) continue;
    if (report.diagrams.some((x) => x.product === need.product && x.spec === need.spec!.spec && fs.existsSync(x.file))) continue;
    try {
      const outFile = path.join(dir, "diagrams", diagramName(need.product, need.spec!.spec));
      const r = await d.generateDiagram({ spec: need.spec!, product: need.product, narration: o.narrationFor(need.product, need.spec!.spec), seconds: 5, outFile }, { log: o.log });
      report.diagrams = [...report.diagrams.filter((x) => !(x.product === need.product && x.spec === need.spec!.spec)), { product: need.product, spec: need.spec!.spec, file: r.file, engine: r.engine, createdAt: new Date().toISOString() }];
    } catch (err) {
      o.log(`[auto-fetch] diagram ${need.product} / ${need.spec!.spec}: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  writeJson(diagramsFile(dir), report.diagrams);
  writeJson(path.join(dir, "auto_fetch.json"), { at: new Date().toISOString(), ...report });
  const added = report.done.reduce((a, b) => a + b.added, 0);
  o.log(`[auto-fetch] resuming: +${added} clip(s), ${report.diagrams.length} diagram(s), ${report.done.filter((x) => x.error).length} failure(s)`);
  return report;
}

/** Diagrams as verified pool shots for their product, tagged with the spec (pacing prefers them on that line). */
export function diagramPoolShots(dir: string): PoolShot[] {
  return readDiagrams(dir)
    .filter((x) => fs.existsSync(x.file))
    .map((x) => ({
      id: `diagram_${path.basename(x.file, ".mp4")}`,
      product: x.product,
      path: x.file,
      url: "",
      license: `Generated by ClipForge (${x.engine === "manim" ? "Manim diagram" : "diagram template"})`,
      duration: 5,
      imgSim: 0.3,
      textSim: 0.3,
      sceneSim: {},
      frames: [],
      shotType: "closeup",
      verified: true,
      keyword: x.spec,
    }));
}
