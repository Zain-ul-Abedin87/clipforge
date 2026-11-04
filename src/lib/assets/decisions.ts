/**
 * Decision log of the asset step (decisions.json): for each scene, the clip that won and the next
 * best candidates with every part of their score, plus the reason each one lost. Read by people
 * ("why did this clip end up here?") and by the review page; it never changes a pick.
 */

export interface ScoreParts {
  /** CLIP similarity, or the stock site's own rank when CLIP is not running. */
  match: number;
  matchFrom: "clip" | "site rank";
  /** Penalties (0 or negative). */
  still: number;
  vision: number;
  model: number;
  reuse: number;
}

export interface ScoredCandidate {
  id: string;
  source: string;
  kind: string;
  url?: string;
  query: string | null;
  total: number;
  parts: ScoreParts;
}

export interface SceneDecision {
  scene: number;
  chosen: ScoredCandidate;
  alternatives: (ScoredCandidate & { lostBecause: string })[];
  /** Set when the clip in assets.json is not the scored winner (download fallback, nearby reuse). */
  final?: { url: string; source: string; note: string };
}

const PENALTY_REASON: Record<"still" | "vision" | "model" | "reuse", string> = {
  still: "a still photo (moving footage is preferred)",
  vision: "the vision check said it does not fit the narration",
  model: "its title names a different model",
  reuse: "already used in other scenes",
};

/** Why `alt` lost to `win`: its biggest penalty that the winner did not have, else a lower match. */
export function lostBecause(alt: ScoredCandidate, win: ScoredCandidate): string {
  let worst: keyof typeof PENALTY_REASON | null = null;
  let gap = 0;
  for (const k of Object.keys(PENALTY_REASON) as (keyof typeof PENALTY_REASON)[]) {
    const d = win.parts[k] - alt.parts[k];
    if (d > gap + 1e-9) [worst, gap] = [k, d];
  }
  if (worst) return PENALTY_REASON[worst];
  return `lower ${alt.parts.matchFrom === "clip" ? "CLIP match" : "stock-site rank"} (${alt.parts.match.toFixed(3)} vs ${win.parts.match.toFixed(3)})`;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const tidy = (c: ScoredCandidate): ScoredCandidate => ({ ...c, total: round(c.total), parts: { ...c.parts, match: round(c.parts.match), still: round(c.parts.still), vision: round(c.parts.vision), model: round(c.parts.model), reuse: round(c.parts.reuse) } });

export function decideScene(scene: number, chosenId: string, scored: ScoredCandidate[], keep = 3): SceneDecision {
  const chosen = scored.find((c) => c.id === chosenId) ?? scored[0];
  const alternatives = scored
    .filter((c) => c !== chosen)
    .sort((a, b) => b.total - a.total)
    .slice(0, Math.max(0, keep))
    .map((a) => ({ ...tidy(a), lostBecause: lostBecause(a, chosen) }));
  return { scene, chosen: tidy(chosen), alternatives };
}
