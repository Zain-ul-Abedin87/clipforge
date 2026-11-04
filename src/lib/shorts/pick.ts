import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { batchSize, llm, llmAvailable, splitWhenTooBig } from "../agents/llm/llm.js";
import { withStage } from "../models/loader.js";

/**
 * Shorts picker: candidate windows of whole sentences, minSec-maxSec long (default 30-58 s), scored
 * on how well they work on their own as a Short: the first sentence is a hook (local model, stage
 * "titles", 0-10), plus rule signals (a number / price, a superlative, a question, "you"). The top
 * N non-overlapping windows win.
 */

export interface TimedSentence {
  text: string;
  start: number;
  end: number;
}

export interface ShortWindow {
  start: number;
  end: number;
  first: number;
  last: number;
  text: string;
  hook: string;
  score: number;
  modelScore: number | null;
  ruleScore: number;
  title?: string;
}

/** Every window that starts at a sentence and ends at a sentence, within [minSec, maxSec] (all valid ends). */
export function candidateWindows(sentences: TimedSentence[], minSec: number, maxSec: number): Omit<ShortWindow, "score" | "modelScore" | "ruleScore">[] {
  const out: Omit<ShortWindow, "score" | "modelScore" | "ruleScore">[] = [];
  for (let i = 0; i < sentences.length; i++) {
    for (let j = i; j < sentences.length; j++) {
      const len = sentences[j].end - sentences[i].start;
      if (len > maxSec) break;
      if (len >= minSec) out.push({ start: sentences[i].start, end: sentences[j].end, first: i, last: j, text: sentences.slice(i, j + 1).map((s) => s.text).join(" "), hook: sentences[i].text });
    }
  }
  return out;
}

/** 0-10 from the text alone (no model). */
export function ruleHookScore(hook: string, body: string): number {
  let s = 3;
  if (/\$\d|\d+%|\b\d{2,}\b/.test(hook)) s += 2;
  if (/\b(best|worst|only|never|cheapest|fastest|secret|mistake|stop|don'?t|why|how)\b/i.test(hook)) s += 2;
  if (/\?\s*$/.test(hook)) s += 1;
  if (/\byou(r)?\b/i.test(hook)) s += 1;
  // Starts mid-thought ("And", "It", "This one") = weak on its own.
  if (/^(and|but|so|it|this|that|they|he|she)\b/i.test(hook.trim())) s -= 2;
  if (/\b(number one|#1|winner|top pick)\b/i.test(body)) s += 1;
  return Math.max(0, Math.min(10, s));
}

const Scores = z.object({ windows: z.array(z.object({ id: z.number().int(), hook: z.number(), standalone: z.number(), title: z.string() })) });

const SYSTEM = `You pick YouTube Shorts from a long video's narration. For each candidate (its first sentence and full text) rate:
- hook: 0-10, would the FIRST sentence stop a viewer scrolling?
- standalone: 0-10, does the text make sense without the rest of the video?
- title: a Shorts title, max 60 characters, original wording.`;

/**
 * The openings the model is asked about. Normally the best by the rules; with `spread` (a long
 * podcast or stream) the video is cut into equal parts and each part sends its own best openings,
 * so a strong moment in a quiet hour is not lost to the word rules alone.
 */
export function shortlistOpenings<T extends { start: number; ruleScore: number }>(openings: T[], count: number, spread = false): T[] {
  const best = (xs: T[]) => [...xs].sort((a, b) => b.ruleScore - a.ruleScore || a.start - b.start);
  if (!spread || openings.length <= count * 6) return best(openings).slice(0, Math.max(count * 6, 12));
  const t0 = Math.min(...openings.map((x) => x.start));
  const span = Math.max(1, Math.max(...openings.map((x) => x.start)) - t0);
  const parts = Math.max(2, count * 2);
  const bucket = (x: T) => Math.min(parts - 1, Math.floor(((x.start - t0) / span) * parts));
  const out: T[] = [];
  for (let b = 0; b < parts; b++) out.push(...best(openings.filter((x) => bucket(x) === b)).slice(0, 4));
  return best(out).slice(0, count * 8);
}

export async function pickShorts(sentences: TimedSentence[], o: { count: number; minSec: number; maxSec: number; spread?: boolean; log?: (m: string) => void }): Promise<ShortWindow[]> {
  const log = o.log ?? (() => {});
  const cands = candidateWindows(sentences, o.minSec, o.maxSec).map((c) => ({ ...c, ruleScore: ruleHookScore(c.hook, c.text), modelScore: null as number | null, score: 0 }));
  if (!cands.length) {
    log(`[shorts] no ${o.minSec}-${o.maxSec} s window of whole sentences in this video`);
    return [];
  }
  // Ask the model about the best opening sentences only (one shortest window per opening; a 7-8B
  // model, small batches). Its score then applies to every window with that opening.
  const byFirst = new Map<number, (typeof cands)[number]>();
  for (const c of cands) if (!byFirst.has(c.first) || c.end - c.start < byFirst.get(c.first)!.end - byFirst.get(c.first)!.start) byFirst.set(c.first, c);
  const shortlist = shortlistOpenings([...byFirst.values()], o.count, o.spread);
  if (llmAvailable()) {
    const ask = async (part: typeof shortlist) => {
      const res = await withStage("titles", () =>
        llm().messages.parse({
          model: env("LLM_MODEL", "claude-haiku-4-5"),
          max_tokens: 2000,
          output_config: { format: zodOutputFormat(Scores) },
          system: SYSTEM,
          messages: [{ role: "user", content: JSON.stringify(part.map((c) => ({ id: cands.indexOf(c), first_sentence: c.hook, text: c.text.slice(0, 700) }))) }],
        }),
      );
      return res.parsed_output?.windows ?? [];
    };
    try {
      const size = batchSize(12, 4);
      for (let i = 0; i < shortlist.length; i += size) {
        for (const r of await splitWhenTooBig(shortlist.slice(i, i + size), ask, log)) {
          const c = cands[r.id];
          if (!c) continue;
          const score = Math.round(((Math.max(0, Math.min(10, r.hook)) * 0.6 + Math.max(0, Math.min(10, r.standalone)) * 0.4) * 10)) / 10;
          for (const x of cands) if (x.first === c.first) Object.assign(x, { modelScore: score, title: r.title.slice(0, 80) });
        }
      }
    } catch (err) {
      log(`[shorts] hook scoring by the model failed (${String((err as Error).message).slice(0, 100)}); rule scores only`);
    }
  }
  for (const c of cands) c.score = c.modelScore === null ? c.ruleScore : Math.round((c.modelScore * 0.7 + c.ruleScore * 0.3) * 10) / 10;
  const picked: ShortWindow[] = [];
  // Best score first; at equal score the shorter window (leaves room for the other Shorts).
  for (const c of [...cands].sort((a, b) => b.score - a.score || a.end - a.start - (b.end - b.start) || a.start - b.start)) {
    if (picked.length >= o.count) break;
    if (picked.some((p) => c.start < p.end && c.end > p.start)) continue;
    picked.push(c);
  }
  picked.sort((a, b) => a.start - b.start);
  log(`[shorts] ${cands.length} candidate window(s) from ${byFirst.size} opening(s), picked ${picked.length}: ${picked.map((p) => `${p.start.toFixed(1)}-${p.end.toFixed(1)} s (score ${p.score}${p.modelScore === null ? ", rules" : ""})`).join(", ")}`);
  return picked;
}
