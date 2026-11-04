import { ngrams, words } from "../../originality/similarity.js";

/**
 * Transcript preparation for the SOP extractor: numbered units (sentences, or ~18-word pieces for
 * auto-captions without punctuation), each with its position in the video as a share of the words.
 * Positions are computed here, not by the model: the model only names unit numbers.
 */

export interface Unit {
  i: number;
  text: string;
  /** Index of the unit's first word in the transcript. */
  start: number;
  words: number;
}
export interface Prepared {
  id: string;
  units: Unit[];
  totalWords: number;
  /** false = auto-captions without sentence punctuation (units are fixed-size pieces). */
  punctuated: boolean;
  durationSec: number | null;
  /** True when the duration is a guess from the word count at 150 wpm (no timing known). */
  estimatedDuration: boolean;
  wpm: number | null;
  avgSentenceWords: number | null;
}

export interface TranscriptMeta {
  durationSec?: number;
  title?: string;
  views?: number;
}

const countW = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

function pieces(ws: string[], size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < ws.length; i += size) out.push(ws.slice(i, i + size).join(" "));
  return out;
}

export function prepareTranscript(id: string, raw: string, meta: TranscriptMeta = {}): Prepared {
  const text = raw.replace(/\[(music|applause|laughter)\]/gi, " ").replace(/\s+/g, " ").trim();
  const allWords = text.split(" ").filter(Boolean);
  const stops = (text.match(/[.!?](\s|$)/g) ?? []).length;
  const punctuated = allWords.length > 0 && (stops / allWords.length) * 100 >= 2;
  let parts: string[];
  if (punctuated) {
    parts = text.split(/(?<=[.!?])\s+/).flatMap((s) => (countW(s) > 45 ? pieces(s.split(" "), 25) : [s]));
  } else parts = pieces(allWords, 18);
  const units: Unit[] = [];
  let at = 0;
  for (const p of parts.map((x) => x.trim()).filter(Boolean)) {
    const n = countW(p);
    if (!n) continue;
    units.push({ i: units.length, text: p, start: at, words: n });
    at += n;
  }
  const totalWords = at;
  const known = meta.durationSec && meta.durationSec > 0 ? meta.durationSec : null;
  const durationSec = known ?? (totalWords ? Math.round((totalWords / 150) * 60) : null);
  return {
    id,
    units,
    totalWords,
    punctuated,
    durationSec,
    estimatedDuration: !known,
    wpm: known ? Math.round(totalWords / (known / 60)) : null,
    avgSentenceWords: punctuated && units.length ? Math.round((totalWords / units.length) * 10) / 10 : null,
  };
}

/** Position of a unit as % of the video (by words). */
export function pctOf(p: Prepared, unit: number): number {
  if (!p.totalWords || !p.units.length) return 0;
  const u = p.units[Math.min(p.units.length - 1, Math.max(0, Math.round(unit)))];
  return Math.round((u.start / p.totalWords) * 1000) / 10;
}

// --------------------------------------------------------------------------------------- the cues

export const HOOK_TYPES = ["question", "bold_claim", "story", "stakes", "other"] as const;
export type HookType = (typeof HOOK_TYPES)[number];

/** Rule-based hook type from the opening (the fallback, and a sanity check on the model). */
export function hookTypeOf(opening: string): HookType {
  const first = opening.split(/(?<=[.!?])\s+/).slice(0, 3).join(" ");
  if (/\?/.test(first) || /^(why|what|how|which|have you|did you|do you|is it|can you)\b/i.test(first.trim())) return "question";
  if (/\b(if you|before you|mistake|lose|cost you|danger|risk|never buy|stop buying|could get)\b/i.test(first)) return "stakes";
  if (/\b(back in|in \d{4}|when i|one day|years ago|the story|it all started)\b/i.test(first)) return "story";
  if (/\b(best|worst|only|most|every|nobody|everyone|\d+%|\$\d+)\b/i.test(first)) return "bold_claim";
  return "other";
}

/** Cue -> a technique description in our own words (never the transcript's). */
const CUES: { kind: "rehook" | "cta" | "section" | "but" | "therefore" | "plant"; re: RegExp; technique: string }[] = [
  { kind: "rehook", re: /\b(stick (around|with me)|keep watching|coming up|in a (minute|moment|bit)|later in (this|the) video|before we get to|wait (until|till))\b/i, technique: "teases what is coming later so the viewer stays" },
  { kind: "rehook", re: /\bbut (here'?s|there'?s|that'?s) (the|a|one) (catch|problem|thing|twist)\b/i, technique: "turns with a problem or catch right after a positive point" },
  { kind: "rehook", re: /\b(the (real )?question is|here'?s where it gets)\b/i, technique: "poses a fresh question to restart curiosity" },
  { kind: "cta", re: /\b(subscribe|leave a comment|comment below|like (this|the) video|link (is )?in the description|hit the bell|notification)\b/i, technique: "asks for an action" },
  { kind: "section", re: /\b(number (one|two|three|four|five|six|seven|eight|nine|ten|\d+)|#\s?\d+|first up|next up|coming in at|at number|moving on)\b/i, technique: "names the next item and its place in the list" },
  { kind: "but", re: /^(but|however|yet|the problem is|the catch is)\b/i, technique: "contrast that complicates the previous point" },
  { kind: "therefore", re: /^(so|that'?s why|which means|because of that|as a result)\b/i, technique: "consequence that moves the story forward" },
  { kind: "plant", re: /\b(i'?ll (show|tell|explain)|we'?ll get to|more on that|by the end|you'?ll see why|later on)\b/i, technique: "promises an answer that comes later" },
];
export const cuesIn = (text: string) => CUES.filter((c) => c.re.test(text.trim()));

// -------------------------------------------------------------------------------------- leakage

/** Word n-grams (default 5) of all transcripts: the "never copy" corpus. */
export function corpusOf(texts: string[], n = 5): Set<string> {
  const s = new Set<string>();
  for (const t of texts) for (const g of ngrams(t, n)) s.add(g);
  return s;
}

/** True when the text repeats any n words of the corpus in a row. */
export function quotes(text: string, corpus: Set<string>, n = 5): boolean {
  const w = words(text);
  for (let i = 0; i + n <= w.length; i++) if (corpus.has(w.slice(i, i + n).join(" "))) return true;
  return false;
}

/**
 * Removes every run of words that matches the corpus (n-grams). Returns null when too little is
 * left to mean anything (the item is then dropped).
 */
export function stripQuoted(text: string, corpus: Set<string>, n = 5): { text: string | null; removed: number } {
  const raw = text.split(/\s+/).filter(Boolean);
  const norm = raw.map((t) => words(t).join(" "));
  // Map normalised words back to raw tokens (a token can normalise to 0 or several words).
  const flat: { w: string; tok: number }[] = [];
  norm.forEach((x, tok) => x.split(" ").filter(Boolean).forEach((w) => flat.push({ w, tok })));
  const kill = new Set<number>();
  for (let i = 0; i + n <= flat.length; i++) if (corpus.has(flat.slice(i, i + n).map((x) => x.w).join(" "))) for (let k = i; k < i + n; k++) kill.add(flat[k].tok);
  if (!kill.size) return { text, removed: 0 };
  const kept = raw.filter((_, i) => !kill.has(i));
  const left = kept.join(" ").replace(/\s+([,.;:!?])/g, "$1").trim();
  return { text: words(left).length >= 3 && kill.size / raw.length <= 0.4 ? left : null, removed: kill.size };
}
