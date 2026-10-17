import crypto from "node:crypto";
import { norm, similarity } from "./text.js";

export type PairKind = "match" | "similar" | "sub" | "ins_a" | "ins_b";
/** One step of the alignment path. a/b are indexes into the two sequences (-1 for a gap). */
export interface Pair {
  a: number;
  b: number;
  kind: PairKind;
}

const digitsOf = (s: string) => s.replace(/[^0-9]/g, "");

const MATCH = 2;
const SIMILAR = 1;
const SUB = -1;
const GAP = -1;

/**
 * Banded Needleman-Wunsch over normalized tokens.
 * The band follows the diagonal scaled by length ratio, so memory stays O(n * band)
 * (a 25-min script is ~4k tokens -> a few MB, not the 16M cells of a full matrix).
 */
export function alignTokens(a: string[], b: string[], minBand = 250): Pair[] {
  const n = a.length;
  const m = b.length;
  const ratio = n === 0 ? 1 : m / n;
  const band = Math.max(minBand, Math.abs(n - m) + 100);
  const width = 2 * band + 1;
  const NEG = -1e9;

  // Row i covers columns [center(i) - band, center(i) + band].
  const center = (i: number) => Math.round(i * ratio);
  const score = new Float64Array((n + 1) * width).fill(NEG);
  const dir = new Uint8Array((n + 1) * width); // 1 diag, 2 up (gap in b), 3 left (gap in a)
  const kindOf = new Uint8Array((n + 1) * width); // 0 match, 1 similar, 2 sub

  const idx = (i: number, j: number) => {
    const k = j - center(i) + band;
    return k < 0 || k >= width ? -1 : i * width + k;
  };
  const get = (i: number, j: number) => {
    if (j < 0 || j > m) return NEG;
    const k = idx(i, j);
    return k < 0 ? NEG : score[k];
  };

  for (let i = 0; i <= n; i++) {
    const lo = Math.max(0, center(i) - band);
    const hi = Math.min(m, center(i) + band);
    for (let j = lo; j <= hi; j++) {
      const k = idx(i, j);
      if (i === 0 && j === 0) {
        score[k] = 0;
        continue;
      }
      let best = NEG;
      let d = 0;
      let kd = 0;
      if (i > 0 && j > 0) {
        const sa = a[i - 1];
        const sb = b[j - 1];
        let s: number;
        let kk: number;
        if (sa === sb) [s, kk] = [MATCH, 0];
        // Fuzzy spelling match only when the numbers agree: "gen3" vs "gen5" is a different product.
        else if (sa.length > 2 && sb.length > 2 && digitsOf(sa) === digitsOf(sb) && similarity(sa, sb) >= 0.7) [s, kk] = [SIMILAR, 1];
        else [s, kk] = [SUB, 2];
        const v = get(i - 1, j - 1) + s;
        if (v > best) [best, d, kd] = [v, 1, kk];
      }
      if (i > 0) {
        const v = get(i - 1, j) + GAP;
        if (v > best) [best, d] = [v, 2];
      }
      if (j > 0) {
        const v = get(i, j - 1) + GAP;
        if (v > best) [best, d] = [v, 3];
      }
      score[k] = best;
      dir[k] = d;
      kindOf[k] = kd;
    }
  }

  const path: Pair[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const k = idx(i, j);
    if (k < 0) throw new Error(`alignment left the band at (${i}, ${j}); texts differ too much`);
    const d = dir[k];
    if (d === 1) {
      const kind: PairKind = kindOf[k] === 0 ? "match" : kindOf[k] === 1 ? "similar" : "sub";
      path.push({ a: i - 1, b: j - 1, kind });
      i--;
      j--;
    } else if (d === 2) {
      path.push({ a: i - 1, b: -1, kind: "ins_a" });
      i--;
    } else {
      path.push({ a: -1, b: j - 1, kind: "ins_b" });
      j--;
    }
  }
  return path.reverse();
}

// ---------------------------------------------------------------------------------------------
// Mode C discrepancies: where the voiceover (the timing truth) and the supplied script disagree.

export type DiscrepancyType = "omission" | "addition" | "substitution";
export type DiscrepancyReason = "number" | "negation" | "model_variant";
export const RESOLUTIONS = ["keep_audio", "correct_transcript", "modify_script"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export interface Discrepancy {
  /** Stable across re-runs: type + both texts + occurrence number. */
  id: string;
  /** omission = in the script, not spoken; addition = spoken, not in the script; substitution = both differ. */
  type: DiscrepancyType;
  severity: "significant" | "minor";
  reasons: DiscrepancyReason[];
  script: string;
  heard: string;
  /** Inclusive token ranges (script tokens / heard words); null when that side is empty. */
  scriptRange: [number, number] | null;
  heardRange: [number, number] | null;
  /** Inclusive range into the alignment path. */
  pairRange: [number, number];
  /** Additions only: the script token index the spoken words came before (scriptTokens.length = at the end). */
  insertAt?: number;
  /** Audio time of the difference (for an omission: the gap where the words should have been). */
  start: number;
  end: number;
  resolution?: Resolution;
}

const NEGATIONS = new Set(["not", "no", "never", "none", "nor", "neither", "nothing", "nobody", "without", "cannot", "cant", "dont", "doesnt", "didnt", "isnt", "arent", "wasnt", "werent", "wont", "wouldnt", "shouldnt", "couldnt", "hasnt", "havent", "hadnt", "aint"]);
/** Words that name a model variant / generation ("Pro" vs "Max", "Gen 3" vs "Gen 5", "Mk II"). */
const VARIANT_WORDS = new Set(["pro", "max", "plus", "mini", "ultra", "lite", "air", "se", "xl", "xs", "fe", "neo", "gen", "generation", "mk", "mark", "series", "edition", "standard", "compact", "ii", "iii", "iv", "vi", "vii", "classic", "elite", "sport", "turbo", "slim", "studio", "note", "fold", "flip"]);

const hasDigit = (t: string) => /\d/.test(t);
const isModelCode = (t: string) => /[a-z]/.test(t) && /\d/.test(t); // p365, g3c, s24, rtx4090
const bag = (xs: string[]) => xs.slice().sort().join(" ");

/** Why a difference matters. Empty = minor (filler, spelling). */
export function classifyDifference(scriptWords: string[], heardWords: string[], context: string[] = []): DiscrepancyReason[] {
  const a = scriptWords.map(norm).filter(Boolean);
  const b = heardWords.map(norm).filter(Boolean);
  const reasons: DiscrepancyReason[] = [];
  if (bag(a.filter(hasDigit)) !== bag(b.filter(hasDigit))) reasons.push("number");
  if (bag(a.filter((t) => NEGATIONS.has(t))) !== bag(b.filter((t) => NEGATIONS.has(t)))) reasons.push("negation");
  const variant = (xs: string[]) => xs.filter((t) => VARIANT_WORDS.has(t) || isModelCode(t));
  const ctxVariant = context.map(norm).some((t) => VARIANT_WORDS.has(t) || isModelCode(t));
  if (bag(variant(a)) !== bag(variant(b)) || (ctxVariant && reasons.includes("number"))) reasons.push("model_variant");
  return reasons;
}

/**
 * Groups every run of non-matching alignment steps into one discrepancy. Fuzzy ("similar") pairs
 * are spelling noise and do not count. Severity is "significant" when numbers, negations or model
 * variants differ.
 */
export function findDiscrepancies(scriptTokens: string[], heard: { word: string; start: number; end: number }[], pairs: Pair[]): Discrepancy[] {
  const out: Discrepancy[] = [];
  const seen = new Map<string, number>();
  let i = 0;
  while (i < pairs.length) {
    if (pairs[i].kind === "match" || pairs[i].kind === "similar") {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < pairs.length && pairs[j + 1].kind !== "match" && pairs[j + 1].kind !== "similar") j++;
    const run = pairs.slice(i, j + 1);
    const sIdx = run.filter((p) => p.a >= 0).map((p) => p.a);
    const hIdx = run.filter((p) => p.b >= 0).map((p) => p.b);
    const type: DiscrepancyType = !hIdx.length ? "omission" : !sIdx.length ? "addition" : "substitution";
    const script = sIdx.map((k) => scriptTokens[k]).join(" ");
    const heardText = hIdx.map((k) => heard[k].word).join(" ");
    // Two script words before the run, so "Gen 3" vs "Gen 5" knows it is about a generation.
    const before = sIdx.length ? scriptTokens.slice(Math.max(0, sIdx[0] - 2), sIdx[0]) : [];
    const reasons = classifyDifference(sIdx.map((k) => scriptTokens[k]), hIdx.map((k) => heard[k].word), before);
    // Audio time: the heard words, or the gap between the neighbouring heard words.
    const prevHeard = pairs.slice(0, i).reverse().find((p) => p.b >= 0);
    const nextHeard = pairs.slice(j + 1).find((p) => p.b >= 0);
    const start = hIdx.length ? heard[hIdx[0]].start : prevHeard ? heard[prevHeard.b].end : 0;
    const end = hIdx.length ? heard[hIdx[hIdx.length - 1]].end : nextHeard ? heard[nextHeard.b].start : start;
    const sig = `${type}|${sIdx.map((k) => norm(scriptTokens[k])).join(" ")}|${hIdx.map((k) => norm(heard[k].word)).join(" ")}`;
    const n = seen.get(sig) ?? 0;
    seen.set(sig, n + 1);
    out.push({
      id: "d_" + crypto.createHash("sha1").update(`${sig}|${n}`).digest("hex").slice(0, 10),
      type,
      severity: reasons.length ? "significant" : "minor",
      reasons,
      script,
      heard: heardText,
      scriptRange: sIdx.length ? [sIdx[0], sIdx[sIdx.length - 1]] : null,
      heardRange: hIdx.length ? [hIdx[0], hIdx[hIdx.length - 1]] : null,
      pairRange: [i, j],
      ...(type === "addition" ? { insertAt: pairs.slice(j + 1).find((p) => p.a >= 0)?.a ?? scriptTokens.length } : {}),
      start,
      end,
    });
    i = j + 1;
  }
  return out;
}
