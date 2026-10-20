import { distinctiveTokens } from "../productNames.js";

/**
 * Outro recap grid (Remotion RecapGrid): every product with its rank, each lit up when the outro
 * narration names it, then a subscribe end card. Product-agnostic: a product is "named" when a
 * distinctive word of its name (a model code, a non-generic word) or "number N" for its rank is
 * spoken inside the outro.
 */

export interface RecapItem { name: string; rank?: number }
export interface RecapScene { start: number; end: number }
export interface RecapProps {
  items: { rank?: number | null; name: string }[];
  highlights: { i: number; at: number }[];
  endAt: number | null;
  endText: string;
  enter: boolean;
  exit: boolean;
}

const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];

/** When (s) each product is first named inside [from, to): by a distinctive name word or "number N". */
export function mentionTimes(items: RecapItem[], words: { word: string; start: number }[], from: number, to: number): Map<number, number> {
  const out = new Map<number, number>();
  const w = words.filter((x) => x.start >= from - 0.05 && x.start < to);
  const toks = items.map((it) => distinctiveTokens(it.name));
  for (let k = 0; k < w.length; k++) {
    const t = norm(w[k].word);
    if (!t) continue;
    // "number 3" / "number three" / "#3"
    const next = k + 1 < w.length ? norm(w[k + 1].word) : "";
    const rankSaid = t === "number" ? (/^\d+$/.test(next) ? Number(next) : NUMBER_WORDS.indexOf(next)) : /^\d+$/.test(t) && /#/.test(w[k].word) ? Number(t) : -1;
    items.forEach((it, i) => {
      if (out.has(i)) return;
      if ((it.rank !== undefined && rankSaid === it.rank) || toks[i].includes(t)) out.set(i, w[k].start);
    });
  }
  return out;
}

/**
 * One RecapGrid card per outro scene. Items in countdown order (highest rank number first); times in
 * each card are relative to its scene. The end card takes the last `endSec` seconds of the outro.
 */
export function recapCards(items: RecapItem[], words: { word: string; start: number }[], scenes: RecapScene[], opts: { endSec?: number; endText?: string } = {}): RecapProps[] {
  if (items.length < 2 || !scenes.length) return [];
  const ordered = [...items].sort((a, b) => (b.rank ?? 0) - (a.rank ?? 0));
  const from = scenes[0].start;
  const to = scenes[scenes.length - 1].end;
  const said = mentionTimes(ordered, words, from, to);
  const endSec = Math.min(opts.endSec ?? 4, Math.max(0, (to - from) * 0.4));
  const endAbs = endSec >= 1.5 ? to - endSec : null;
  const all = [...said.entries()].map(([i, at]) => ({ i, at })).sort((a, b) => a.at - b.at);
  return scenes.map((s, k) => ({
    items: ordered.map((it) => ({ rank: it.rank ?? null, name: it.name })),
    highlights: all.map((h) => ({ i: h.i, at: Math.round((h.at - s.start) * 100) / 100 })),
    endAt: endAbs !== null && endAbs < s.end ? Math.max(0, Math.round((endAbs - s.start) * 100) / 100) : null,
    endText: opts.endText ?? "Thanks for watching",
    enter: k === 0,
    exit: k === scenes.length - 1,
  }));
}
