import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import type { Section } from "../scenes.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";

/**
 * Hook / intro / outro boundaries from the narration itself (plan step, any video type).
 *  - hookEnd: end of the opening line(s) a viewer hears first (1-2 sentences, >= 3 s). The intro
 *    teaser and hook title are cut against it; it is stored on the first section, not split off,
 *    because a 3 s section would be folded into its neighbour by splitIntoScenes.
 *  - introEnd: where the set-up stops and the content starts (non-listicles only; a countdown's
 *    first "Number 5" header is the intro end and stays the source of truth there).
 *  - outroStart: the wrap-up ("so which one would you pick?", "thanks for watching").
 * The LLM reads the numbered sentences once; every answer is range-checked and the regex
 * heuristic fills whatever it leaves out or gets wrong, so a missing key never breaks the plan.
 */

export interface BoundSentence {
  text: string;
  start: number;
  end: number;
}

export interface Bounds {
  hookEnd: number;
  introEnd?: number;
  outroStart?: number;
  source: "llm" | "heuristic";
}

/** Wrap-up lines. Only searched near the end (see outroWindow), so a mid-video "let me know" is ignored. */
export const OUTRO_RE = new RegExp(
  "\\b(" +
    [
      "that wraps up",
      "wrap(?:s|ping)? (?:it|things|this) up",
      "thanks? (?:you )?for watching",
      "let (?:us|me) know in the comments",
      "see you (?:in the next|next time)",
      "that's (?:it|all) for",
      "final thoughts",
      "before you go",
      "in conclusion",
      "to sum (?:it|things|this) up",
      "(?:so|and) there you have it",
      "that's (?:my|our) (?:list|picks|countdown)",
      "which (?:one )?(?:would|will|do) you (?:pick|choose|go with|get|buy)",
      "if i had to (?:pick|choose)",
      "hope (?:this|that) (?:video )?helped",
    ].join("|") +
    ")\\b",
  "i",
);

/** Calls to action that end a video ("subscribe", "hit the bell"), used when no wrap-up line is found. */
export const CTA_RE = /\b(subscribe|hit the (?:bell|like)|like (?:this|the) video|drop a comment|comment below)\b/i;

const HOOK_MIN = 3;
const HOOK_MAX = 15;
const OUTRO_MAX = 120;

/** Earliest a wrap-up may start: in the last 120 s and in the last 40 % of the video. */
const outroWindow = (duration: number) => Math.max(duration - OUTRO_MAX, duration * 0.6);

/** Regex-only boundaries. `afterIdx`: the outro must come after this sentence (a countdown's last header). */
export function heuristicBounds(sentences: BoundSentence[], duration: number, afterIdx = -1): Bounds {
  let hookEnd = sentences[0]?.end ?? Math.min(duration, HOOK_MIN);
  for (let i = 1; i < Math.min(2, sentences.length) && hookEnd < HOOK_MIN; i++) hookEnd = sentences[i].end;
  if (hookEnd > HOOK_MAX && sentences[0]) hookEnd = Math.max(sentences[0].end, Math.min(hookEnd, HOOK_MAX));
  const from = outroWindow(duration);
  const late = sentences.map((s, i) => ({ s, i })).filter(({ s, i }) => i > afterIdx && s.start >= from && s.start > hookEnd);
  const wrap = late.find(({ s }) => OUTRO_RE.test(s.text)) ?? late.find(({ s }) => CTA_RE.test(s.text));
  return { hookEnd: round(hookEnd), ...(wrap ? { outroStart: round(wrap.s.start) } : {}), source: "heuristic" };
}

const Schema = z.object({
  hook_end_sentence: z.number().int(),
  intro_end_sentence: z.number().int().nullable(),
  outro_start_sentence: z.number().int().nullable(),
});
export type RawBounds = z.infer<typeof Schema>;

/**
 * Range checks on the LLM's sentence indices; anything implausible falls back to the heuristic
 * for that field (hook <= 30 s, intro end after the hook and in the first 40 %, outro in the window).
 */
export function pickBounds(raw: RawBounds | null, sentences: BoundSentence[], duration: number, fallback: Bounds): Bounds {
  if (!raw || !sentences.length) return fallback;
  const at = (i: number | null) => (i !== null && Number.isInteger(i) && i >= 0 && i < sentences.length ? sentences[i] : undefined);
  const hook = at(raw.hook_end_sentence);
  const hookEnd = hook && hook.end <= 30 && hook.end >= Math.min(HOOK_MIN, sentences[0].end) ? hook.end : fallback.hookEnd;
  const intro = at(raw.intro_end_sentence);
  const introEnd = intro && intro.end >= hookEnd && intro.end <= duration * 0.4 ? intro.end : fallback.introEnd;
  // intro_end / outro_start are the last intro sentence and the first outro sentence.
  const outro = at(raw.outro_start_sentence);
  const outroStart = outro && outro.start >= outroWindow(duration) && outro.start > hookEnd ? outro.start : fallback.outroStart;
  return {
    hookEnd: round(hookEnd),
    ...(introEnd !== undefined ? { introEnd: round(introEnd) } : {}),
    ...(outroStart !== undefined ? { outroStart: round(outroStart) } : {}),
    source: "llm",
  };
}

const SYSTEM =
  "You find the structure of a YouTube narration. Sentences are numbered from 0. Return: hook_end_sentence = the last sentence of the opening hook (the first 1-2 lines meant to grab attention, usually under 15 seconds); intro_end_sentence = the last sentence of the introduction before the main content starts (null if the video goes straight into content); outro_start_sentence = the first sentence of the closing wrap-up / verdict recap / call to action at the end (null if there is none). Never pick an outro in the middle of the video.";

/** LLM boundaries with heuristic fallback. `ask` is injectable for tests. */
export async function findBounds(
  sentences: BoundSentence[],
  duration: number,
  opts: { useLlm: boolean; afterIdx?: number; log?: (m: string) => void; ask?: (prompt: string) => Promise<RawBounds | null> },
): Promise<Bounds> {
  const log = opts.log ?? (() => {});
  const fallback = heuristicBounds(sentences, duration, opts.afterIdx);
  if (!opts.useLlm || !sentences.length || (!opts.ask && !llmAvailable())) return fallback;
  const lines = sentences.map((s, i) => `${i} [${s.start.toFixed(1)}s]: ${s.text.slice(0, 200)}`).join("\n");
  const prompt = `Video length ${duration.toFixed(0)} s.\n${lines}`;
  try {
    const raw = opts.ask ? await opts.ask(prompt) : await askLlm(prompt);
    const b = pickBounds(raw, sentences, duration, fallback);
    // A countdown's outro must still come after its last header.
    const header = opts.afterIdx !== undefined && opts.afterIdx >= 0 ? sentences[opts.afterIdx] : undefined;
    if (header && b.outroStart !== undefined && b.outroStart < header.end) {
      const { outroStart: _, ...rest } = b;
      return fallback.outroStart !== undefined ? { ...rest, outroStart: fallback.outroStart } : rest;
    }
    return b;
  } catch (err) {
    log(`[plan] intro/outro LLM failed (${String((err as Error).message ?? err).slice(0, 120)}); heuristic used`);
    return fallback;
  }
}

async function askLlm(prompt: string): Promise<RawBounds | null> {
  const res = await llm().messages.parse({
    model: env("ROUTE_MODEL", env("LLM_MODEL", "claude-haiku-4-5")),
    max_tokens: 300,
    output_config: { format: zodOutputFormat(Schema) },
    system: SYSTEM,
    messages: [{ role: "user", content: prompt }],
  });
  return res.parsed_output ?? null;
}

/**
 * Applies boundaries to the detected sections:
 *  - hookEnd goes on the first section;
 *  - a video without an intro (one "body" section) gets intro = [0, first sentence end >= introEnd
 *    and >= minLen], when both sides stay at least minLen long;
 *  - a video without an outro gets one from outroStart (split out of the section it falls in).
 * Script-labelled sections (`labelled`) keep their intro/outro; only hookEnd is added.
 */
export function applyBounds(sections: Section[], b: Bounds, sentences: BoundSentence[], duration: number, minLen: number, labelled = false): Section[] {
  let out = sections.map((s) => ({ ...s }));
  if (!labelled && out.length === 1 && out[0].kind === "body") {
    const want = Math.max(minLen, b.introEnd ?? b.hookEnd);
    const cut = sentences.find((s) => s.end >= want - 0.05)?.end;
    if (cut !== undefined && cut <= Math.max(30, minLen * 2) && duration - cut >= minLen) {
      out = [
        { id: 0, kind: "intro", start: 0, end: round(cut) },
        { ...out[0], id: 1, start: round(cut) },
      ];
    }
  }
  if (!labelled && b.outroStart !== undefined && !out.some((s) => s.kind === "outro")) {
    const i = out.findIndex((s) => b.outroStart! > s.start && b.outroStart! < s.end);
    const sec = out[i];
    if (sec && b.outroStart - sec.start >= minLen && duration - b.outroStart >= minLen) {
      const tail: Section = { id: 0, kind: "outro", start: b.outroStart, end: sec.end };
      sec.end = b.outroStart;
      out.splice(i + 1, 0, tail);
    }
  }
  out.forEach((s, i) => (s.id = i));
  out[0].hookEnd = b.hookEnd;
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
