import { similarity } from "./text.js";

export type PairKind = "match" | "similar" | "sub" | "ins_a" | "ins_b";
/** One step of the alignment path. a/b are indexes into the two sequences (-1 for a gap). */
export interface Pair {
  a: number;
  b: number;
  kind: PairKind;
}

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
        else if (sa.length > 2 && sb.length > 2 && similarity(sa, sb) >= 0.7) [s, kk] = [SIMILAR, 1];
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
