import fs from "node:fs";
import path from "node:path";
import { HistoryEntry, historyDir, loadHistory } from "../../channelHistory.js";
import { embed } from "../../models/embed.js";
import { containment, cosine, ngrams, tokenCosine } from "../../originality/similarity.js";
import { windows } from "./originality.js";

/**
 * Self-repetition: the same n-gram + embedding check that guards against competitors, run against
 * the channel's own last 20 scripts and titles. A section with more than 20% of its 5-grams in an
 * earlier script, or an embedding cosine over 0.85 with a ~120-word window of one, is flagged
 * (and rewritten once by the script writer). This protects against YouTube's "inauthentic /
 * repetitive content" judgement on channels that make many similar videos.
 * Window vectors are stored in the history entry, so an earlier script is embedded only once.
 */

export interface SelfRepeatReport {
  checkedAgainst: number;
  sections: { index: number; ngram: number; cosine: number | null; against: string; flagged: boolean }[];
  title: { score: number; against: string; flagged: boolean } | null;
  flagged: number;
  clean: boolean;
}

type Win = { text: string; vec: number[] | null };

/** Window vectors of a history entry (computed once, saved back). */
async function entryWindows(channel: string, e: HistoryEntry & { windows?: Win[] }, emb: boolean, log: (m: string) => void): Promise<Win[]> {
  if (e.windows?.length && (!emb || e.windows.every((w) => w.vec))) return e.windows;
  const texts = windows(e.text);
  const vecs = emb ? await embed(texts, log).catch(() => null) : null;
  const ws = texts.map((t, i) => ({ text: t, vec: vecs?.[i] ?? null }));
  if (vecs) {
    const f = path.join(historyDir(channel), `${e.project}.json`);
    if (fs.existsSync(f)) fs.writeFileSync(f, JSON.stringify({ ...e, windows: ws }) + "\n");
  }
  return ws;
}

const r3 = (x: number) => Math.round(x * 1000) / 1000;

export async function selfRepetition(
  channel: string,
  sections: string[],
  newTitle: string,
  o: { exclude?: string; maxNgram?: number; maxCosine?: number; useEmbeddings?: boolean; log?: (m: string) => void } = {},
): Promise<SelfRepeatReport> {
  const log = o.log ?? (() => {});
  const maxNgram = o.maxNgram ?? 0.2;
  const maxCos = o.maxCosine ?? 0.85;
  const past = loadHistory(channel, { limit: 20, exclude: o.exclude });
  if (!past.length) return { checkedAgainst: 0, sections: sections.map((_, index) => ({ index, ngram: 0, cosine: null, against: "", flagged: false })), title: null, flagged: 0, clean: true };
  const emb = o.useEmbeddings !== false && process.env.EMBEDDINGS !== "off";
  const grams = past.map((p) => ({ title: p.title, set: ngrams(p.text, 5) }));
  const wins: (Win & { title: string })[] = [];
  for (const p of past) for (const w of await entryWindows(channel, p, emb, log)) wins.push({ ...w, title: p.title });
  const secVecs = emb && wins.some((w) => w.vec) ? await embed(sections, log).catch(() => null) : null;
  const rows = sections.map((text, index) => {
    let ng = 0;
    let against = "";
    for (const g of grams) {
      const c = containment(text, g.set, 5);
      if (c > ng) {
        ng = c;
        against = g.title;
      }
    }
    let cos: number | null = null;
    let cosAgainst = "";
    if (secVecs?.[index]) {
      for (const w of wins) {
        if (!w.vec) continue;
        const c = cosine(secVecs[index], w.vec);
        if (cos === null || c > cos) {
          cos = c;
          cosAgainst = w.title;
        }
      }
    }
    const flagged = ng > maxNgram || (cos !== null && cos > maxCos);
    return { index, ngram: r3(ng), cosine: cos === null ? null : r3(cos), against: ng > maxNgram || !cosAgainst ? against : cosAgainst, flagged };
  });
  // The title against our past titles: lexical token cosine (the title checker adds embeddings).
  let title: SelfRepeatReport["title"] = null;
  for (const t of past.map((p) => p.title).filter(Boolean)) {
    const s = r3(tokenCosine(newTitle, t));
    if (!title || s > title.score) title = { score: s, against: t, flagged: s > maxCos };
  }
  const flagged = rows.filter((x) => x.flagged).length;
  return { checkedAgainst: past.length, sections: rows, title, flagged, clean: flagged === 0 && !title?.flagged };
}
