/**
 * Per-channel style preset, read from channels/<name>/style.json (edited in Settings):
 *   "cards":  { "font": "Anton", "primary": "#FFD60A", "panel": "#0c0c0cEB", "text": "#FFFFFF",
 *               "set": ["RankCard", ...], "graphicsEverySec": 25 }
 *   "pacing": { "targetShotSec": 2.5 }
 * Missing keys fall back to the old look, so older style.json files keep working.
 */

export const ALL_CARDS = ["RankCard", "PriceCard", "SpecCard", "LowerThird", "SpecBars", "ProsCons", "PriceTag", "CompareTable"] as const;
export type CardComp = (typeof ALL_CARDS)[number];
export const CARD_FONTS = ["Anton", "Impact", "Arial Black", "Segoe UI Black", "Georgia", "Verdana"];

export interface CardPreset {
  font: string;
  primary: string;
  panel: string;
  text: string;
  set: Set<CardComp>;
  graphicsEverySec: number;
  /** true when style.json has a "cards" block (then the theme is passed to every card). */
  custom: boolean;
}

export function cardPreset(style: Record<string, unknown>): CardPreset {
  const c = (style.cards ?? null) as Record<string, unknown> | null;
  const set = Array.isArray(c?.set) ? (c!.set as string[]).filter((x): x is CardComp => (ALL_CARDS as readonly string[]).includes(x)) : [...ALL_CARDS];
  const every = Number(c?.graphicsEverySec);
  return {
    font: typeof c?.font === "string" && c.font ? c.font : "Anton",
    primary: typeof c?.primary === "string" ? c.primary : "#FFD60A",
    panel: typeof c?.panel === "string" ? c.panel : "rgba(12,12,12,.92)",
    text: typeof c?.text === "string" ? c.text : "#FFFFFF",
    set: new Set(set),
    graphicsEverySec: Number.isFinite(every) && every >= 8 && every <= 120 ? every : 25,
    custom: !!c,
  };
}

export const themeOf = (p: CardPreset) => ({ primary: p.primary, panel: p.panel, text: p.text, font: p.font });

export function pacingTarget(style: Record<string, unknown>): number | undefined {
  const v = Number((style.pacing as Record<string, unknown> | undefined)?.targetShotSec);
  return Number.isFinite(v) && v >= 1 && v <= 8 ? v : undefined;
}
