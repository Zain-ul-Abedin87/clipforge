/**
 * Originality guard: how close our text is to competitor text (titles, transcripts).
 *
 *  - ngramJaccard: overlap of word n-grams (copied phrasing);
 *  - tokenCosine: bag-of-words cosine (same words, other order);
 *  - embedding cosine (nomic-embed-text through Ollama, src/lib/models/embed.ts): same meaning;
 *  - similarity(): the max of the lexical scores, and of the embedding score when vectors are given.
 *
 * Above the threshold (titles 0.8, script 0.8 by default, features.json) the text is rewritten.
 */

const STOP = new Set("a an the and or of to in on for with is are was were be it this that these those you your i we our my at by from as vs".split(" "));

export function words(text: string, dropStop = false): string[] {
  const w = text
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  return dropStop ? w.filter((x) => !STOP.has(x)) : w;
}

export function ngrams(text: string, n: number): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  if (w.length < n) {
    if (w.length) out.add(w.join(" "));
    return out;
  }
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(" "));
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Word n-gram Jaccard (n=2 for titles, 5 for scripts). */
export const ngramJaccard = (a: string, b: string, n = 2) => jaccard(ngrams(a, n), ngrams(b, n));

/** Share of `a`'s n-grams that also appear in `b` (containment: a copied passage inside a long text). */
export function containment(a: string, b: string | Set<string>, n = 5): number {
  const A = ngrams(a, n);
  const B = typeof b === "string" ? ngrams(b, n) : b;
  if (!A.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / A.size;
}

export function tokenCosine(a: string, b: string): number {
  const va = new Map<string, number>();
  const vb = new Map<string, number>();
  for (const w of words(a, true)) va.set(w, (va.get(w) ?? 0) + 1);
  for (const w of words(b, true)) vb.set(w, (vb.get(w) ?? 0) + 1);
  let dot = 0;
  for (const [k, v] of va) dot += v * (vb.get(k) ?? 0);
  const na = Math.sqrt([...va.values()].reduce((s, v) => s + v * v, 0));
  const nb = Math.sqrt([...vb.values()].reduce((s, v) => s + v * v, 0));
  return na && nb ? dot / (na * nb) : 0;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export interface SimilarityHit {
  /** 0-1, the highest of the measures below. */
  score: number;
  ngram: number;
  tokens: number;
  embedding: number | null;
  /** The competitor text it is closest to. */
  against: string;
}

/**
 * Closest competitor text to `text`. Lexical scores always; embedding cosine when both vectors are
 * given (embeddings[i] belongs to others[i]). Embedding cosine of two unrelated sentences is ~0.4-0.6
 * with nomic-embed-text, so it is rescaled: (cos - 0.5) / 0.5, floored at 0.
 */
export function closest(text: string, others: string[], o: { n?: number; vec?: number[] | null; vecs?: (number[] | null)[] } = {}): SimilarityHit {
  let best: SimilarityHit = { score: 0, ngram: 0, tokens: 0, embedding: null, against: "" };
  others.forEach((t, i) => {
    const ng = ngramJaccard(text, t, o.n ?? 2);
    const tk = tokenCosine(text, t);
    const ev = o.vec && o.vecs?.[i] ? Math.max(0, (cosine(o.vec, o.vecs[i]!) - 0.5) / 0.5) : null;
    const score = Math.max(ng, tk * 0.95, ev ?? 0);
    if (score > best.score) best = { score: Math.round(score * 1000) / 1000, ngram: Math.round(ng * 1000) / 1000, tokens: Math.round(tk * 1000) / 1000, embedding: ev === null ? null : Math.round(ev * 1000) / 1000, against: t };
  });
  return best;
}
