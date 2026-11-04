/**
 * Edit polish: beat punch-in zoom and "a visual change every 3-5 s".
 *
 *  - Beats are emphasised words in the narration: numbers / prices, superlatives, product-ish
 *    capitalised words, words after a pause, and words in CAPS. Each beat gets a quick 6% punch-in
 *    (4 frames in, 10 frames out) on the footage (cards drawn on top are not zoomed).
 *  - Gaps: any stretch longer than maxVisualSec without a cut or a beat gets an extra punch-in in
 *    the middle, so the picture changes at least every 3-5 s even on a long card or still.
 */

export interface BeatWord {
  word: string;
  start: number;
  end: number;
}

const EMPH = /^(\$?\d[\d,.]*%?|best|worst|only|never|always|cheapest|fastest|lightest|toughest|biggest|smallest|most|least|insane|massive|huge|free|winner|number|first|last|new)$/i;

/** 0-3: how much a word stands out (for picking beats). */
export function emphasis(w: BeatWord, prev?: BeatWord): number {
  const raw = w.word.replace(/[^\p{L}\p{N}$%.,]/gu, "");
  let s = 0;
  if (EMPH.test(raw.replace(/[.,]+$/, ""))) s += 2;
  if (/^[A-Z]{2,}$/.test(raw)) s += 1;
  if (/^[A-Z][a-z]+\d|^[A-Z]\d|\d[A-Z]/.test(raw)) s += 1; // model names (P365, G19, X5)
  if (prev && w.start - prev.end >= 0.35) s += 1; // after a pause
  return s;
}

/** Beat times (seconds): strongest words first, at least `minGap` s apart. */
export function beatTimes(words: BeatWord[], o: { minGap?: number; minScore?: number; max?: number } = {}): number[] {
  const minGap = o.minGap ?? 2.5;
  const scored = words.map((w, i) => ({ t: w.start, s: emphasis(w, words[i - 1]) })).filter((x) => x.s >= (o.minScore ?? 2));
  scored.sort((a, b) => b.s - a.s || a.t - b.t);
  const out: number[] = [];
  for (const x of scored) {
    if (out.length >= (o.max ?? 10_000)) break;
    if (out.every((t) => Math.abs(t - x.t) >= minGap)) out.push(x.t);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Adds a beat in the middle of every stretch longer than `maxSec` that has no cut and no beat.
 * `cuts`: times where the picture changes (scene / sub-shot starts), sorted. Returns all beats.
 */
export function fillVisualGaps(cuts: number[], beats: number[], duration: number, maxSec: number): number[] {
  const marks = [...new Set([0, ...cuts, ...beats, duration])].sort((a, b) => a - b);
  const extra: number[] = [];
  for (let i = 1; i < marks.length; i++) {
    const gap = marks[i] - marks[i - 1];
    if (gap <= maxSec) continue;
    const n = Math.ceil(gap / maxSec) - 1;
    for (let k = 1; k <= n; k++) extra.push(Math.round((marks[i - 1] + (gap * k) / (n + 1)) * 100) / 100);
  }
  return [...beats, ...extra].sort((a, b) => a - b);
}

/** Longest stretch (s) without a cut or a beat. */
export function longestStill(cuts: number[], beats: number[], duration: number): { sec: number; at: number } {
  const marks = [...new Set([0, ...cuts, ...beats, duration])].sort((a, b) => a - b);
  let best = { sec: 0, at: 0 };
  for (let i = 1; i < marks.length; i++) if (marks[i] - marks[i - 1] > best.sec) best = { sec: Math.round((marks[i] - marks[i - 1]) * 100) / 100, at: marks[i - 1] };
  return best;
}

/**
 * FFmpeg zoompan for punch-ins at the given frames (relative to the segment): zoom 1 -> 1.06 in 4
 * frames, back in 10. Empty string when there are none.
 */
export function punchFilter(frames: number[], w = 1920, h = 1080, amount = 0.06): string {
  const fs = frames.filter((f) => f >= 0).slice(0, 24);
  if (!fs.length) return "";
  const term = (f: number) => `between(on,${f},${f + 4})*(on-${f})/4+between(on,${(f + 4.001).toFixed(3)},${f + 14})*(1-(on-${f + 4})/10)`;
  const z = `1+${amount}*(${fs.map(term).join("+")})`;
  return `zoompan=z='${z}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${w}x${h}:fps=30`;
}
