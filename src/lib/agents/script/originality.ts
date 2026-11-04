import { embed } from "../../models/embed.js";
import { containment, cosine, ngrams, words } from "../../originality/similarity.js";

/**
 * Originality report of a script against competitor transcripts: per paragraph, the share of its
 * word 5-grams found anywhere in the competitor corpus (copied phrasing) and the embedding
 * similarity to the closest ~120-word competitor window (nomic-embed-text; same meaning, other
 * words). A paragraph over either threshold must be rewritten.
 */

export interface ParagraphCheck {
  index: number;
  ngram: number;
  embedding: number | null;
  closest: string;
  flagged: boolean;
}
export interface OriginalityReport {
  paragraphs: ParagraphCheck[];
  maxNgram: number;
  maxEmbedding: number | null;
  flagged: number;
  clean: boolean;
  competitorWords: number;
}

export function windows(text: string, size = 120, step = 60): string[] {
  const w = words(text);
  const out: string[] = [];
  for (let i = 0; i < Math.max(1, w.length - size + step); i += step) out.push(w.slice(i, i + size).join(" "));
  return out.filter(Boolean);
}

export async function originalityReport(
  paragraphs: string[],
  competitors: string[],
  o: { n?: number; maxNgram?: number; maxEmbedding?: number; useEmbeddings?: boolean; log?: (m: string) => void } = {},
): Promise<OriginalityReport> {
  const n = o.n ?? 5;
  const maxNgram = o.maxNgram ?? 0.2;
  const maxEmb = o.maxEmbedding ?? 0.8;
  const corpus = new Set<string>();
  for (const t of competitors) for (const g of ngrams(t, n)) corpus.add(g);
  const wins = competitors.flatMap((t) => windows(t));
  let vecs: number[][] | null = null;
  if (o.useEmbeddings !== false && wins.length && paragraphs.length) {
    const all = await embed([...paragraphs, ...wins], o.log);
    vecs = all;
  }
  const checks: ParagraphCheck[] = paragraphs.map((p, i) => {
    const ng = Math.round(containment(p, corpus, n) * 1000) / 1000;
    let emb: number | null = null;
    let closest = "";
    if (vecs) {
      const pv = vecs[i];
      let best = -1;
      wins.forEach((w, k) => {
        const c = cosine(pv, vecs![paragraphs.length + k]);
        if (c > best) {
          best = c;
          closest = w;
        }
      });
      // Rescaled like the title check: unrelated text sits around cosine 0.5.
      emb = Math.round(Math.max(0, (best - 0.5) / 0.5) * 1000) / 1000;
    }
    return { index: i, ngram: ng, embedding: emb, closest: closest.slice(0, 160), flagged: ng > maxNgram || (emb !== null && emb > maxEmb) };
  });
  const embs = checks.map((c) => c.embedding).filter((x): x is number => x !== null);
  return {
    paragraphs: checks,
    maxNgram: Math.max(0, ...checks.map((c) => c.ngram)),
    maxEmbedding: embs.length ? Math.max(...embs) : null,
    flagged: checks.filter((c) => c.flagged).length,
    clean: checks.every((c) => !c.flagged),
    competitorWords: competitors.reduce((s, t) => s + words(t).length, 0),
  };
}
