import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../../env.js";
import { llm, llmAvailable } from "../llm/llm.js";
import { withStage } from "../../models/loader.js";
import { words } from "../../originality/similarity.js";
import { dropUnsourced, numbersIn, SourcedFact, splitSentences, unsourcedClaims } from "./facts.js";
import type { Outline, OutlineSection } from "./outline.js";

/**
 * Section writer: one model call per section (intro, each product, outro), so every request is
 * small enough for an 8K context. Each section is held to its word budget, may only state numbers
 * from its product's sourced facts, and is rewritten when it is too close to a competitor.
 */

export const countWords = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const Out = z.object({ text: z.string() });

const STYLE = `You write one section of a spoken YouTube script for a faceless channel (an AI voice reads it).
- Plain spoken American English, short sentences, no headings, no lists, no markdown, no emojis, no stage directions.
- Original wording: never reuse a competitor's phrasing.
- Numbers: ONLY the facts listed for this section (same values and units). Never invent specs, prices, dates or test results. If no facts are listed, state no numbers at all.
- Hit the target word count closely.`;

export interface SectionText {
  section: OutlineSection;
  text: string;
  words: number;
  attempts: number;
  unsourcedRemoved: number;
}

function prompt(s: OutlineSection, topic: string, facts: SourcedFact[], target: number, prevLine: string, extra = ""): string {
  const what =
    s.kind === "intro"
      ? `The INTRO of a countdown video about ${topic}. Open with this hook idea (in your own words): ${s.angle} Tease the #1 pick without naming it.`
      : s.kind === "outro"
        ? `The OUTRO of a countdown video about ${topic}. ${s.angle}`
        : `The section for #${s.rank}: ${s.product}. Angle: ${s.angle} Start by naming the product and its rank.`;
  const f = facts.length ? `Facts you may state (and only these):\n${facts.map((x) => `- ${x.label}: ${x.value}`).join("\n")}` : "Facts: none (state no numbers).";
  return `${what}\n${f}\n${prevLine ? `The previous section ended with: "${prevLine}"\n` : ""}Target: ${target} words.${extra ? `\n${extra}` : ""}`;
}

export type Ask = (system: string, user: string) => Promise<string>;

/** The default writer: the local model on the "script" stage. */
export const modelWriter: Ask = async (system, user) => {
  const res = await withStage("script", () =>
    llm().messages.parse({ model: env("LLM_MODEL", "claude-haiku-4-5"), max_tokens: 2500, output_config: { format: zodOutputFormat(Out) }, system, messages: [{ role: "user", content: user }] }),
  );
  return (res.parsed_output?.text ?? "").replace(/\s+/g, " ").trim();
};

/** Rule-based section (no model): sourced facts as plain sentences, then trimmed / padded to budget. */
export function ruleSection(s: OutlineSection, topic: string, facts: SourcedFact[]): string {
  const parts =
    s.kind === "intro"
      ? [s.angle, `We looked at specs, prices and real-world trade-offs so you can pick the right one.`, `Stick around for number one, because it is not the one most people expect.`]
      : s.kind === "outro"
        ? [`That wraps up our list of ${topic}.`, s.angle, `Tell us in the comments which one you would buy.`]
        : [`Number ${s.rank} is the ${s.product}.`, s.angle, ...facts.map((f) => `Its ${f.label.toLowerCase()} is ${f.value}.`)];
  return fitWords(parts.join(" "), s.words);
}

/** Trims whole sentences (never the first) or adds closing sentences until within +-3 words. */
export function fitWords(text: string, target: number): string {
  let sents = splitSentences(text);
  while (countWords(sents.join(" ")) > target + 3 && sents.length > 1) {
    // Drop the sentence without numbers whose removal lands closest to the target.
    const cur = countWords(sents.join(" "));
    let best = -1;
    let bestD = Infinity;
    sents.forEach((s, i) => {
      if (i === 0) return;
      const d = Math.abs(cur - countWords(s) - target) + (numbersIn(s).length ? 5 : 0);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    if (best < 0) break;
    const next = sents.filter((_, i) => i !== best);
    if (countWords(next.join(" ")) < target - 3 && countWords(sents.join(" ")) - target < target - countWords(next.join(" "))) break;
    sents = next;
  }
  let out = sents.join(" ");
  const pads = ["That matters more than it sounds.", "Keep that in mind.", "It is a fair trade for most buyers.", "Worth a close look."];
  for (let k = 0; countWords(out) < target - 3 && k < 40; k++) out += " " + pads[k % pads.length];
  const w = out.split(/\s+/);
  return countWords(out) > target + 3 ? w.slice(0, target).join(" ").replace(/[,;:]?$/, ".") : out;
}

/** Writes one section within +-3% (and +-3 words) of its budget: up to 3 model attempts, closest kept. */
export async function writeSection(s: OutlineSection, topic: string, facts: SourcedFact[], prevLine: string, ask: Ask | null, log: (m: string) => void = () => {}): Promise<SectionText> {
  const target = s.words;
  // Product names (and the outline's list of them) may contain numbers.
  const names = [s.product ?? "", ...(s.names ?? [])];
  const tol = Math.max(3, Math.round(target * 0.03));
  if (!ask) {
    const text = ruleSection(s, topic, facts);
    return { section: s, text, words: countWords(text), attempts: 0, unsourcedRemoved: 0 };
  }
  let best = "";
  let attempts = 0;
  let extra = "";
  for (; attempts < 3; ) {
    attempts++;
    let text = "";
    try {
      text = await ask(STYLE, prompt(s, topic, facts, target, prevLine, extra));
    } catch (err) {
      log(`[script] section ${s.product ?? s.kind} attempt ${attempts} failed: ${String((err as Error).message).slice(0, 100)}`);
      continue;
    }
    // Unsourced numbers: one rewrite round asking for the fix.
    const bad = unsourcedClaims(text, facts, names);
    if (bad.length && attempts < 3) {
      extra = `Your last draft stated numbers that are not in the facts (${bad.flatMap((b) => b.numbers).join(", ")}). Remove them; use only the listed facts.`;
      best = !best || Math.abs(countWords(text) - target) < Math.abs(countWords(best) - target) ? text : best;
      continue;
    }
    if (!best || Math.abs(countWords(text) - target) < Math.abs(countWords(best) - target)) best = text;
    const n = countWords(text);
    if (Math.abs(n - target) <= tol) break;
    extra = `Your last draft had ${n} words; rewrite it to ${target} words (${n > target ? "shorter" : "longer"}).`;
  }
  if (!best) best = ruleSection(s, topic, facts);
  const before = splitSentences(best).length;
  let text = dropUnsourced(best, facts, names);
  const removed = before - splitSentences(text).length;
  if (removed) log(`[script] ${s.product ?? s.kind}: removed ${removed} sentence(s) with unsourced numbers`);
  if (Math.abs(countWords(text) - target) > tol) text = fitWords(text, target);
  log(`[script] ${s.kind === "product" ? `#${s.rank} ${s.product}` : s.kind}: ${countWords(text)}/${target} words in ${attempts} attempt(s)`);
  return { section: s, text, words: countWords(text), attempts, unsourcedRemoved: removed };
}

export async function writeSections(outline: Outline, facts: SourcedFact[], ask: Ask | null, log: (m: string) => void = () => {}): Promise<SectionText[]> {
  const out: SectionText[] = [];
  for (const s of outline.sections) {
    const own = s.kind === "product" ? facts.filter((f) => f.product === s.product) : [];
    const prev = out.length ? splitSentences(out[out.length - 1].text).at(-1) ?? "" : "";
    out.push(await writeSection(s, outline.topic, own, prev, ask, log));
  }
  return out;
}

/** Total words within +-tolerance of the target: trims or pads the sections furthest off. */
export function balanceTotal(sections: SectionText[], target: number, tolerance: number): SectionText[] {
  const total = () => sections.reduce((s, x) => s + x.words, 0);
  for (let guard = 0; Math.abs(total() - target) > target * tolerance && guard < sections.length * 2; guard++) {
    const over = total() > target;
    const pick = [...sections].sort((a, b) => (over ? b.words - b.section.words - (a.words - a.section.words) : a.words - a.section.words - (b.words - b.section.words)))[0];
    const want = Math.max(10, pick.words + (target - total()));
    pick.text = fitWords(pick.text, want);
    pick.words = countWords(pick.text);
  }
  return sections;
}

export const llmWriter = (): Ask | null => (llmAvailable() ? modelWriter : null);
export { words };
