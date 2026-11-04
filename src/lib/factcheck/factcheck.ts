import { numbersIn, splitSentences } from "../agents/script/facts.js";
import type { Source } from "../research/wiki.js";

/**
 * Fact checker for scripts on any topic (documentaries). A claim is a sentence with a number / date,
 * a superlative ("the first", "the largest") or a named thing. Each claim is matched against the
 * sources (the creator's links, notes, Wikipedia) passage by passage:
 *  - supported:   a passage about the same thing contains every number the claim states (or, for a
 *                 claim without numbers, the AI quoted a passage that says it). The AI never decides
 *                 alone: its quote must be found word for word in a source, with the claim's numbers.
 *  - contradicted: the AI quoted a passage that says otherwise (quote checked the same way);
 *  - not_found:   no source confirms it;
 *  - unchecked:   no numbers and no AI available to judge the wording.
 * Contradicted claims are always removed; not_found ones too when factcheck.removeUnverified is on.
 * "If it can't be verified, it cannot be claimed."
 */

export type Verdict = "supported" | "contradicted" | "not_found" | "unchecked";

export interface Claim {
  sentence: string;
  numbers: string[];
  verdict: Verdict;
  sourceId?: string;
  url?: string;
  title?: string;
  /** The passage (or AI quote found in it) that supports / contradicts the claim. */
  quote?: string;
  /** Why a claim is not verified although part of it is (e.g. its numbers are, a superlative is not). */
  note?: string;
  by: "numbers" | "ai" | "none";
}

export interface FactCheck {
  claims: Claim[];
  counts: Record<Verdict, number>;
  removed: string[];
}

export type Judge = (claim: string, passages: { id: string; text: string }[]) => Promise<{ verdict: "supported" | "contradicted" | "not_found"; sourceId?: string; quote?: string }>;

const STOP = new Set("this that with from have were their there which about would could should these those than then them they into been only also more most when what where while after before over under very much many some such each other your will just like because between through during".split(" "));
/** Counting numbers ("three reasons", "the 2 sides") are not checked; years and measures are. */
const SMALL = new Set(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
const SUPERLATIVE = /\b(first|last|largest|biggest|smallest|oldest|newest|longest|shortest|highest|lowest|fastest|slowest|greatest|most|least|record|\w+iest|more than (?:\w+ ){0,3}(?:any|all)|than (?:\w+ ){0,3}any other)\b/i;
/** A small number followed by a unit or scale is a measure, not a count: "5 kilometres", "3 million". */
const MEASURE = /\b(\d+(?:[.,]\d+)?)\s*(%|percent|per cent|km|kilomet(?:re|er)s?|m\b|met(?:re|er)s?|miles?|feet|ft|kg|kilograms?|tons?|tonnes?|years?|months?|days?|hours?|minutes?|seconds?|million|billion|trillion|thousand|hundred|dollars?|euros?|pounds?|degrees?|°)/gi;

export const words = (s: string) => new Set(s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").split(/[^\p{L}\p{Nd}]+/u).filter((w) => w.length >= 4 && !STOP.has(w)));
const norm = (s: string) => s.toLowerCase().replace(/[‘’“”"']/g, "").replace(/\s+/g, " ").trim();

/** Sentences that state something checkable. */
export function claimsIn(script: string): { sentence: string; numbers: string[] }[] {
  const out: { sentence: string; numbers: string[] }[] = [];
  for (const sentence of splitSentences(script)) {
    const measured = new Set([...sentence.matchAll(MEASURE)].map((m) => String(Number(m[1].replace(/,/g, "")))));
    const nums = numbersIn(sentence).filter((n) => !SMALL.has(n) || measured.has(n));
    // A named thing: capitalised words in a row ("Port Klang", "Strait of Malacca"), not at the start.
    const named = /\s[A-Z][\p{L}'-]+\s+(?:(?:of|the|de|del|da|von|van|al)\s+)?[A-Z][\p{L}'-]+/u.test(sentence);
    if (nums.length || SUPERLATIVE.test(sentence) || named) out.push({ sentence, numbers: [...new Set(nums)] });
  }
  return out;
}

export interface Passage {
  sourceId: string;
  text: string;
  words: Set<string>;
  numbers: Set<string>;
}

/** Sources cut into overlapping 3-sentence passages. */
export function passages(sources: Source[]): Passage[] {
  const out: Passage[] = [];
  for (const s of sources) {
    const sent = splitSentences(s.text.replace(/\n+/g, ". "));
    for (let i = 0; i < sent.length; i += 2) {
      const text = sent.slice(i, i + 3).join(" ");
      if (text.length < 20) continue;
      out.push({ sourceId: s.id, text, words: words(text), numbers: new Set(numbersIn(text)) });
    }
  }
  return out;
}

/** The passages most about the claim (shared content words), best first. */
export function bestPassages(claim: string, all: Passage[], minOverlap: number, n = 3): Passage[] {
  const w = words(claim);
  return all
    .map((p) => ({ p, score: [...w].filter((x) => p.words.has(x)).length }))
    .filter((x) => x.score >= minOverlap)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map((x) => x.p);
}

export async function checkClaims(script: string, sources: Source[], o: { judge?: Judge | null; minOverlap?: number } = {}): Promise<FactCheck> {
  const all = passages(sources);
  const byId = new Map(sources.map((s) => [s.id, s]));
  const claims: Claim[] = [];
  for (const c of claimsIn(script)) {
    const top = bestPassages(c.sentence, all, o.minOverlap ?? 2);
    const cite = (p: { sourceId: string; text: string }) => ({ sourceId: p.sourceId, url: byId.get(p.sourceId)?.url, title: byId.get(p.sourceId)?.title, quote: p.text.slice(0, 400) });
    // 1. Numbers: one passage about the same thing holds every number the claim states.
    // A superlative riding along ("more than any other waterway") must be in the passage too:
    // matching numbers alone do not verify it.
    const sup = c.sentence.match(SUPERLATIVE)?.[0]?.toLowerCase();
    const hit = c.numbers.length ? top.find((p) => c.numbers.every((x) => p.numbers.has(x))) : undefined;
    const supOk = !sup || (hit && hit.text.toLowerCase().includes(sup));
    if (hit && supOk) {
      claims.push({ ...c, verdict: "supported", by: "numbers", ...cite(hit) });
      continue;
    }
    const partly = hit && !supOk ? `the numbers are in the source, but "${sup}" is not` : undefined;
    // 2. The AI reads the passages; its quote must be in one of them, with the claim's numbers.
    if (o.judge && top.length) {
      try {
        const r = await o.judge(c.sentence, top.map((p) => ({ id: p.sourceId, text: p.text })));
        const q = r.quote ? norm(r.quote) : "";
        const where = q.length >= 12 ? top.find((p) => norm(p.text).includes(q)) : undefined;
        const numbersOk = c.numbers.every((x) => where?.numbers.has(x));
        if (where && r.verdict === "supported" && numbersOk) {
          claims.push({ ...c, verdict: "supported", by: "ai", ...cite(where), quote: r.quote });
          continue;
        }
        if (where && r.verdict === "contradicted") {
          claims.push({ ...c, verdict: "contradicted", by: "ai", ...cite(where), quote: r.quote });
          continue;
        }
      } catch {
        /* the AI failed: judged by the numbers alone */
      }
      claims.push({ ...c, verdict: "not_found", by: "ai", ...(partly ? { note: partly } : {}) });
      continue;
    }
    claims.push({ ...c, verdict: c.numbers.length ? "not_found" : "unchecked", by: c.numbers.length ? "numbers" : "none", ...(partly ? { note: partly } : {}) });
  }
  const counts = { supported: 0, contradicted: 0, not_found: 0, unchecked: 0 } as Record<Verdict, number>;
  for (const c of claims) counts[c.verdict]++;
  return { claims, counts, removed: [] };
}

/** The script without contradicted claims (and without unconfirmed ones when `removeUnverified`). */
export function applyCheck(script: string, fc: FactCheck, removeUnverified: boolean): { text: string; removed: string[] } {
  const drop = new Set(fc.claims.filter((c) => c.verdict === "contradicted" || (removeUnverified && c.verdict === "not_found")).map((c) => c.sentence));
  const removed: string[] = [];
  const paragraphs = script.split(/\n\s*\n/).map((p) =>
    splitSentences(p)
      .filter((s) => (drop.has(s) ? (removed.push(s), false) : true))
      .join(" "),
  );
  return { text: paragraphs.filter((p) => p.trim()).join("\n\n"), removed };
}
