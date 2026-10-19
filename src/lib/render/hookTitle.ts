/**
 * Hook title (cards/ "HookTitle"): the opening line(s) as big kinetic words over the teaser montage.
 * Words come from aligned.json, so each one pops in when it is spoken; they are shown a few at a
 * time (short-form caption style) and the words that carry the hook (numbers, "best", "never",
 * "mistake"...) get the accent colour. One card per scene the hook overlaps (a layer cannot
 * outlive its scene segment), times relative to that scene's start.
 */

export interface HookWord {
  word: string;
  start: number;
  end: number;
}

export interface HookChunk {
  /** Seconds after the card starts. */
  from: number;
  to: number;
  words: { w: string; at: number; hi: boolean }[];
}

export interface HookTitleProps {
  chunks: HookChunk[];
}

const HI_RE = /^(\$?\d[\d,.]*%?|#\d+|best|worst|never|only|secret|stop|mistakes?|wrong|why|cheap(?:est)?|free|biggest|fastest|top|most|nobody|everyone|every|don't|won't|can't|shocking|truth|actually)$/i;
const MAX_WORDS = 3;
/** Gap between words that starts a new chunk (a breath). */
const BREAK_GAP = 0.35;

const clean = (w: string) => w.replace(/^[^\w$#]+|[^\w%]+$/g, "");

/** Chunks of <= 3 words, broken at sentence ends and pauses; null when no word is inside. */
export function hookTitleProps(words: HookWord[], sceneStart: number, sceneEnd: number, hookEnd: number): HookTitleProps | null {
  const until = Math.min(sceneEnd, hookEnd);
  const inside = words.filter((w) => w.start >= sceneStart - 0.05 && w.start < until - 0.05 && clean(w.word));
  if (!inside.length) return null;
  const groups: HookWord[][] = [];
  let cur: HookWord[] = [];
  inside.forEach((w, i) => {
    const prev = inside[i - 1];
    const brk = prev && (/[.!?,;:]$/.test(prev.word.trim()) || w.start - prev.end > BREAK_GAP);
    if (cur.length && (cur.length >= MAX_WORDS || brk)) {
      groups.push(cur);
      cur = [];
    }
    cur.push(w);
  });
  if (cur.length) groups.push(cur);
  const rel = (t: number) => Math.max(0, Math.round((t - sceneStart) * 100) / 100);
  const cardEnd = rel(Math.min(sceneEnd, hookEnd + 0.4));
  return {
    chunks: groups.map((g, k) => {
      const ws = g.map((w) => ({ w: clean(w.word), at: rel(w.start), hi: HI_RE.test(clean(w.word)) }));
      // No keyword in the chunk: the longest real word (>= 6 letters) carries it.
      if (!ws.some((x) => x.hi)) {
        const long = [...ws].sort((a, b) => b.w.length - a.w.length)[0];
        if (long && long.w.length >= 6) long.hi = true;
      }
      const next = groups[k + 1];
      const to = next ? rel(next[0].start) : Math.min(cardEnd, rel(g[g.length - 1].end + 0.4));
      return { from: rel(g[0].start - 0.05), to: Math.max(to, rel(g[0].start) + 0.2), words: ws };
    }),
  };
}

/** Plain text of the props, for the drawtext fallback layer. */
export const hookText = (p: HookTitleProps) => p.chunks.map((c) => c.words.map((w) => w.w).join(" ")).join(" ");
