import type { AlignedWord, Sentence } from "../../commands/align.js";
import type { Section } from "../scenes.js";
import { norm } from "../text.js";

export interface Span {
  start: number;
  end: number;
  section: number;
  text: string;
}

const HEADER_RE = /^(?:and\s+)?(?:(?:coming\s+in\s+)?at\s+|our\s+)?(?:number|no\.?|#)\s*([a-z0-9-]+)\b/i;
const OUTRO_RE = /\b(that wraps up|wrap(?:s|ping)? (?:it|things) up|thanks for watching|let us know in the comments|see you in the next|that's (?:it|all) for)\b/i;

function rankOf(sentence: string): number | null {
  const m = sentence.trim().match(HEADER_RE);
  if (!m) return null;
  const n = Number(norm(m[1]));
  return Number.isInteger(n) && n >= 1 && n <= 25 ? n : null;
}

/** Longest strictly monotonic run of ranks (5,4,3,2,1 or 1,2,3...), so stray "number" mentions are ignored. */
function pickHeaderChain(cands: { idx: number; rank: number }[]): { idx: number; rank: number }[] {
  let best: typeof cands = [];
  for (const dir of [-1, 1]) {
    // O(n^2) LIS - candidate lists are tiny.
    const len = cands.map(() => 1);
    const prev = cands.map(() => -1);
    for (let i = 0; i < cands.length; i++) {
      for (let j = 0; j < i; j++) {
        if (cands[i].rank - cands[j].rank === dir && len[j] + 1 > len[i]) {
          len[i] = len[j] + 1;
          prev[i] = j;
        }
      }
    }
    let end = len.indexOf(Math.max(0, ...len));
    const chain: typeof cands = [];
    while (end >= 0) {
      chain.unshift(cands[end]);
      end = prev[end];
    }
    if (chain.length > best.length) best = chain;
  }
  return best.length >= 3 ? best : [];
}

function findProduct(texts: string[], glossary: string[]): string | undefined {
  for (const t of texts) {
    const hit = glossary.filter((g) => t.includes(g)).sort((a, b) => b.length - a.length)[0];
    if (hit) return hit;
  }
  // "Number five. The Benelli M4." -> "Benelli M4"
  for (const t of texts) {
    const m = t.match(/\b(?:the|is the|it's the)\s+((?:[A-Z0-9][\w&/.-]*\s?){1,5})/);
    if (m) return m[1].trim().replace(/[.,!?]+$/, "");
  }
  return undefined;
}

/** Detects "Number 5 ... Number 1" listicle structure; falls back to a single body section. */
export function detectSections(sentences: Sentence[], duration: number, glossary: string[]): Section[] {
  const cands = sentences
    .map((s, idx) => ({ idx, rank: rankOf(s.text) }))
    .filter((c): c is { idx: number; rank: number } => c.rank !== null);
  const chain = pickHeaderChain(cands);

  if (!chain.length) return [{ id: 0, kind: "body", start: 0, end: duration }];

  const sections: Section[] = [];
  const firstHeader = sentences[chain[0].idx];
  if (firstHeader.start > 1) sections.push({ id: 0, kind: "intro", start: 0, end: firstHeader.start });

  chain.forEach((c, k) => {
    const s = sentences[c.idx];
    const nextStart = k + 1 < chain.length ? sentences[chain[k + 1].idx].start : duration;
    const near = sentences.slice(c.idx, c.idx + 2).map((x) => x.text);
    sections.push({
      id: sections.length,
      kind: "item",
      start: sections.length === 0 ? 0 : s.start,
      end: nextStart,
      rank: c.rank,
      product_name: findProduct(near, glossary),
    });
  });

  // Outro: first wrap-up sentence after the last header, within the last section.
  const last = sections[sections.length - 1];
  const lastHeaderIdx = chain[chain.length - 1].idx;
  const outro = sentences.find((s, i) => i > lastHeaderIdx + 2 && OUTRO_RE.test(s.text));
  if (outro && duration - outro.start < 120) {
    last.end = outro.start;
    sections.push({ id: sections.length, kind: "outro", start: outro.start, end: duration });
  }
  return sections;
}

interface Unit {
  start: number;
  end: number;
  text: string;
  /** Cost of cutting a scene right after this unit (0 at sentence end, higher mid-sentence). */
  cutCost: number;
}

function unitsFromWords(words: AlignedWord[], from: number, to: number, maxUnitSec: number): Unit[] {
  const ws = words.filter((w) => w.start >= from - 0.001 && w.start < to - 0.001);
  const units: Unit[] = [];
  let cur: AlignedWord[] = [];
  const flush = (cutCost: number) => {
    if (!cur.length) return;
    units.push({ start: cur[0].start, end: cur[cur.length - 1].end, text: cur.map((w) => w.word).join(" "), cutCost });
    cur = [];
  };
  for (let i = 0; i < ws.length; i++) {
    cur.push(ws[i]);
    const w = ws[i].word;
    const dur = ws[i].end - cur[0].start;
    if (/[.!?]["')\]]*$/.test(w)) flush(0);
    else if (/[,;:]$/.test(w) && dur >= maxUnitSec * 0.5) flush(1);
    else if (dur >= maxUnitSec) flush(3);
  }
  flush(0);
  return units;
}

/**
 * Splits a section into scenes with DP: every scene within [min, max] seconds, as close to avg as
 * possible, preferring cuts at sentence ends. Scene i spans from its first unit's start to the next
 * scene's first unit start, so scenes are contiguous (no gaps) by construction.
 */
function partition(units: Unit[], from: number, to: number, min: number, max: number, avg: number) {
  const n = units.length;
  const startAt = (i: number) => (i === 0 ? from : units[i].start);
  const endAt = (j: number) => (j === n ? to : units[j].start);
  const best = new Array<number>(n + 1).fill(Infinity);
  const back = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = j - 1; i >= 0; i--) {
      const d = endAt(j) - startAt(i);
      if (d > max + 6) break;
      if (best[i] === Infinity) continue;
      const violation = d < min ? (min - d) * 100 : d > max ? (d - max) * 100 : 0;
      const cost = best[i] + (d - avg) ** 2 + violation + (j < n ? units[j - 1].cutCost : 0);
      if (cost < best[j]) {
        best[j] = cost;
        back[j] = i;
      }
    }
  }
  if (best[n] === Infinity) return null;
  const cuts: number[] = [];
  for (let j = n; j > 0; j = back[j]) cuts.unshift(back[j]);
  return cuts.map((i, k) => {
    const j = k + 1 < cuts.length ? cuts[k + 1] : n;
    return { start: startAt(i), end: endAt(j), text: units.slice(i, j).map((u) => u.text).join(" ") };
  });
}

const fits = (spans: { start: number; end: number }[], min: number, max: number) =>
  spans.every((s) => s.end - s.start >= min - 0.002 && s.end - s.start <= max + 0.002);

export function splitIntoScenes(
  sections: Section[],
  words: AlignedWord[],
  limits: { minLengthSec: number; maxLengthSec: number; avgLengthSec: number },
): Span[] {
  const { minLengthSec: min, maxLengthSec: max, avgLengthSec: avg } = limits;

  // A section shorter than one minimum scene cannot stand alone: fold it into its neighbour.
  const merged: Section[] = [];
  for (const s of sections) {
    const prev = merged[merged.length - 1];
    if (prev && s.end - s.start < min) prev.end = s.end;
    else if (prev && prev.end - prev.start < min) {
      prev.end = s.end;
      Object.assign(prev, { kind: s.kind, rank: s.rank, product_name: s.product_name });
    } else merged.push({ ...s });
  }
  merged.forEach((s, i) => (s.id = i));
  sections.splice(0, sections.length, ...merged);

  const spans: Span[] = [];
  for (const sec of sections) {
    // Sentence-level units first; drop to word-level only if that cannot satisfy the limits.
    let parts = partition(unitsFromWords(words, sec.start, sec.end, 5), sec.start, sec.end, min, max, avg);
    if (!parts || !fits(parts, min, max)) {
      parts = partition(unitsFromWords(words, sec.start, sec.end, 0.01), sec.start, sec.end, min, max, avg) ?? parts;
    }
    for (const p of parts ?? [{ start: sec.start, end: sec.end, text: "" }]) {
      spans.push({ ...p, start: round(p.start), end: round(p.end), section: sec.id });
    }
  }
  return spans;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
