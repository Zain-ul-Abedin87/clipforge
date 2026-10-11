import fs from "node:fs";
import { norm, similarity } from "./text.js";

export interface TimedWord {
  word: string;
  start: number;
  end: number;
  prob?: number;
}

export interface Correction {
  from: string;
  to: string;
  start: number;
  end: number;
  score: number;
}

export function loadGlossary(file: string | null | undefined): string[] {
  if (!file || !fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

const digitsOf = (s: string) => s.replace(/[^0-9]/g, "");

interface Term {
  display: string[];
  key: string;
  digits: string;
  len: number;
}

/**
 * Replaces misheard product names with glossary spellings, e.g.
 * "Moss Berg 500" -> "Mossberg 500", "Leather man" -> "Leatherman".
 * Model numbers must match exactly (a "Glock 17" is never rewritten to "Glock 19").
 */
export function applyGlossary(words: TimedWord[], glossary: string[]): { words: TimedWord[]; corrections: Correction[] } {
  const terms: Term[] = glossary.map((g) => {
    const display = g.split(/\s+/);
    const key = display.map(norm).join("");
    return { display, key, digits: digitsOf(g), len: display.length };
  });
  // Longest terms first so "Smith & Wesson M&P" wins over a shorter overlapping term.
  terms.sort((x, y) => y.key.length - x.key.length);

  const out: TimedWord[] = [];
  const corrections: Correction[] = [];
  let i = 0;
  while (i < words.length) {
    let best: { term: Term; span: number; score: number } | null = null;
    for (const term of terms) {
      for (let span = Math.max(1, term.len - 1); span <= term.len + 1 && i + span <= words.length; span++) {
        const window = words.slice(i, i + span);
        const joined = window.map((w) => norm(w.word)).join("");
        if (joined.length < 3 || digitsOf(joined) !== term.digits) continue;
        // Penalize windows longer/shorter than the term so neighbours ("the Sig Sauer P365") are not swallowed.
        const score = similarity(joined, term.key) - 0.1 * Math.abs(span - term.len);
        const minScore = term.key.length <= 6 ? 0.85 : 0.8;
        if (score >= minScore && (!best || score > best.score)) best = { term, span, score };
      }
    }

    if (!best) {
      out.push(words[i]);
      i++;
      continue;
    }

    const window = words.slice(i, i + best.span);
    const heard = window.map((w) => w.word).join(" ");
    // Keep trailing punctuation from what Whisper heard (sentence boundaries depend on it).
    const trail = (window[window.length - 1].word.match(/[.,!?;:]+$/) ?? [""])[0];
    const replacement = best.term.display.map((d, k, arr) => (k === arr.length - 1 ? d + trail : d));
    const already = heard === replacement.join(" ");

    const start = window[0].start;
    const end = window[window.length - 1].end;
    const totalChars = replacement.reduce((s, d) => s + d.length, 0);
    let t = start;
    for (const d of replacement) {
      const dur = ((end - start) * d.length) / totalChars;
      out.push({ word: d, start: round(t), end: round(t + dur), prob: Math.min(...window.map((w) => w.prob ?? 1)) });
      t += dur;
    }
    if (!already) corrections.push({ from: heard, to: replacement.join(" "), start, end, score: round(best.score) });
    i += best.span;
  }
  return { words: out, corrections };
}

const round = (x: number) => Math.round(x * 1000) / 1000;
