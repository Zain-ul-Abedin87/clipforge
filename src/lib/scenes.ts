export const SCENE_TYPES = ["stock", "product", "graphic", "image"] as const;
export type SceneType = (typeof SCENE_TYPES)[number];

export const GRAPHIC_KINDS = ["title_card", "spec_card", "price_badge", "pros_cons", "intro_card", "end_card"] as const;
export type GraphicKind = (typeof GRAPHIC_KINDS)[number];

export interface Graphic {
  kind: GraphicKind;
  title: string;
  lines: string[];
  price?: string;
  rank?: number;
}

export type SectionKind = "intro" | "item" | "outro" | "body";

export interface Section {
  id: number;
  kind: SectionKind;
  start: number;
  end: number;
  rank?: number;
  product_name?: string;
}

/** scenes.json contract: [{id,start,end,text,type,queries[],product_name?}] plus planner extras. */
export interface Scene {
  id: number;
  start: number;
  end: number;
  text: string;
  type: SceneType;
  queries: string[];
  product_name?: string;
  section: number;
  graphic?: Graphic;
  labeledBy: "llm" | "heuristic";
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Hard checks for M2: schema, continuity (no gaps/overlaps), 6-12s lengths. */
export function validateScenes(
  scenes: Scene[],
  duration: number,
  limits: { minLengthSec: number; maxLengthSec: number },
): ValidationResult {
  const errors: string[] = [];
  const eps = 0.002;
  if (!scenes.length) errors.push("no scenes");
  scenes.forEach((s, i) => {
    if (s.id !== i) errors.push(`scene ${i}: id ${s.id} out of order`);
    if (!(s.end > s.start)) errors.push(`scene ${i}: end <= start`);
    if (!SCENE_TYPES.includes(s.type)) errors.push(`scene ${i}: bad type ${s.type}`);
    if (!Array.isArray(s.queries) || s.queries.some((q) => typeof q !== "string" || !q.trim()))
      errors.push(`scene ${i}: bad queries`);
    if (s.type !== "graphic" && s.queries.length === 0) errors.push(`scene ${i}: no queries`);
    if (s.type === "graphic" && !s.graphic) errors.push(`scene ${i}: graphic scene without graphic spec`);
    if (s.type === "product" && !s.product_name) errors.push(`scene ${i}: product scene without product_name`);
    const d = s.end - s.start;
    if (d < limits.minLengthSec - eps || d > limits.maxLengthSec + eps)
      errors.push(`scene ${i}: length ${d.toFixed(2)}s outside ${limits.minLengthSec}-${limits.maxLengthSec}s`);
    if (i > 0 && Math.abs(s.start - scenes[i - 1].end) > eps)
      errors.push(`scene ${i}: gap/overlap of ${(s.start - scenes[i - 1].end).toFixed(3)}s`);
  });
  if (scenes.length) {
    if (Math.abs(scenes[0].start) > eps) errors.push(`first scene starts at ${scenes[0].start}, not 0`);
    const last = scenes[scenes.length - 1];
    if (Math.abs(last.end - duration) > 0.05) errors.push(`last scene ends at ${last.end}, audio is ${duration}`);
  }
  return { ok: errors.length === 0, errors };
}
