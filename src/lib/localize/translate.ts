import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { llm } from "../agents/llm/llm.js";
import { withStage } from "../models/loader.js";
import { loadFeatures } from "../settings/features.js";
import { LanguageSpec } from "./languages.js";

/**
 * Script translation for a language version of a video. The facts must survive word for word, so
 * product names and every token with a digit (model numbers, prices, specs, ranks) are swapped for
 * markers (⟦1⟧, ⟦2⟧ ...) before the model sees the text and put back afterwards. A paragraph whose
 * markers do not come back intact is tried again, then kept in the original language and flagged:
 * never a guessed fact. US units and prices are kept (a converted number would be a new claim) and
 * flagged for the creator, as are paragraphs much shorter or longer than the original.
 */

export type Ask = (system: string, user: string) => Promise<string>;

export interface ParagraphResult {
  source: string;
  text: string;
  /** False = the model could not keep the protected terms: the original is kept. */
  translated: boolean;
  issues: string[];
}

export interface TranslationResult {
  text: string;
  paragraphs: ParagraphResult[];
  flagged: number;
  sourceWords: number;
  words: number;
}

const MARK = /⟦(\d+)⟧/g;
const countWords = (s: string) => s.split(/\s+/).filter(Boolean).length;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Product names and digit tokens -> markers. Names first, longest first ("Glock 19 Gen 5" before "Glock 19"). */
export function protect(text: string, names: string[]): { text: string; terms: string[] } {
  const terms: string[] = [];
  const slot = (t: string) => {
    let i = terms.indexOf(t);
    if (i < 0) i = terms.push(t) - 1;
    return `⟦${i + 1}⟧`;
  };
  let out = text;
  for (const n of [...new Set(names.map((x) => x.trim()).filter((x) => x.length >= 2))].sort((a, b) => b.length - a.length)) {
    out = out
      .split(/(⟦\d+⟧)/)
      .map((part) => (part.startsWith("⟦") ? part : part.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(n)}(?![\\p{L}\\p{N}])`, "giu"), (m) => slot(m))))
      .join("");
  }
  // Any token with a digit: P365, 9mm, $499, 4.5, 2024, AR-15, #3.
  const TOKEN = /[#$€£]?[\p{L}\p{N}]+(?:[.,\-/+][\p{L}\p{N}]+)*%?/gu;
  out = out
    .split(/(⟦\d+⟧)/)
    .map((part) => (part.startsWith("⟦") ? part : part.replace(TOKEN, (m) => (/\d/.test(m) ? slot(m) : m))))
    .join("");
  return { text: out, terms };
}

/** 4.5 -> 4,5 and 1,200 -> 1200 for languages that write a decimal comma (the value is unchanged). */
export function localNumber(token: string, spec: LanguageSpec, on = true): string {
  if (!on || !spec.decimalComma) return token;
  const m = token.match(/^([#$€£]?)(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(%?|[\p{L}"]{1,4})$/u);
  if (!m) return token;
  const [, cur, int, dec, unit] = m;
  return `${cur}${int.replace(/,/g, "")}${dec !== undefined ? `,${dec}` : ""}${unit}`;
}

/** Markers back to their terms; null when a marker is missing or unknown. */
export function restore(translated: string, protectedText: string, terms: string[], fmt: (t: string) => string = (t) => t): string | null {
  const need = new Set([...protectedText.matchAll(MARK)].map((m) => Number(m[1])));
  const got = new Set([...translated.matchAll(MARK)].map((m) => Number(m[1])));
  for (const n of need) if (!got.has(n)) return null;
  for (const n of got) if (!need.has(n)) return null;
  return translated.replace(MARK, (_m, i: string) => fmt(terms[Number(i) - 1])).replace(/\s+/g, " ").trim();
}

const US_UNITS = /\b(?:inch(?:es)?|feet|foot|ft|yards?|miles?|mph|pounds?|lbs?|ounces?|oz|gallons?|fahrenheit|°\s?F|grains?)\b|\d\s?"/i;
const US_PRICE = /\$\s?\d|\bdollars?\b|\bUSD\b|\bbucks\b/i;

/** What the creator should check in a paragraph (from the original text). */
export function reviewNotes(source: string, target: string, spec: LanguageSpec, ratio = { min: 0.6, max: 1.7 }): string[] {
  const notes: string[] = [];
  if (US_PRICE.test(source)) notes.push(`US price kept as in the original: check the price for ${spec.name} viewers before publishing.`);
  if (US_UNITS.test(source)) notes.push("US unit kept (the number is unchanged): convert it only if you know the exact metric value.");
  const r = countWords(target) / Math.max(1, countWords(source));
  if (r < ratio.min) notes.push(`Much shorter than the original (${Math.round(r * 100)}% of the words): check nothing was left out.`);
  if (r > ratio.max) notes.push(`Much longer than the original (${Math.round(r * 100)}% of the words): check nothing was added.`);
  return notes;
}

/** Paragraphs (blank-line separated); a very long paragraph is cut at sentence ends (~250 words). */
export function paragraphsOf(text: string, maxWords = 250): string[] {
  const out: string[] = [];
  for (const p of text.replace(/\r\n/g, "\n").split(/\n\s*\n/).map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean)) {
    if (countWords(p) <= maxWords) {
      out.push(p);
      continue;
    }
    let cur: string[] = [];
    for (const s of p.split(/(?<=[.!?])\s+/)) {
      if (cur.length && countWords([...cur, s].join(" ")) > maxWords) {
        out.push(cur.join(" "));
        cur = [];
      }
      cur.push(s);
    }
    if (cur.length) out.push(cur.join(" "));
  }
  return out;
}

export function systemPrompt(from: LanguageSpec, to: LanguageSpec): string {
  return [
    `You translate YouTube video narration from ${from.name} into ${to.name}.`,
    `Write natural spoken ${to.name}, the way a native ${to.name}-speaking YouTube creator would say it out loud. Not word for word.`,
    `Markers like ⟦1⟧ stand for product names and numbers. Copy every marker exactly, each one at least once; move it where ${to.name} grammar needs it. Never translate, change or drop a marker, and never write the number or name it stands for yourself.`,
    "Do not add facts, opinions, jokes or claims that are not in the original, and do not leave any out.",
    `Rank headings like "Number ⟦3⟧" become the usual ${to.name} wording with the marker kept (the rank stays a digit).`,
    "Address the viewer the same way in every paragraph.",
    "Answer with the translation of the paragraph only.",
  ].join("\n");
}

const Out = z.object({ text: z.string() });

/** The configured model (local Ollama first, llm_settings.json "script" stage). */
export const modelAsk: Ask = async (system, user) => {
  const res = await withStage("script", () =>
    llm().messages.parse({ model: env("LLM_MODEL", "claude-haiku-4-5"), max_tokens: 3000, output_config: { format: zodOutputFormat(Out) }, system, messages: [{ role: "user", content: user }] }),
  );
  return (res.parsed_output?.text ?? "").replace(/\s+/g, " ").trim();
};

export interface TranslateOpts {
  from: LanguageSpec;
  to: LanguageSpec;
  /** Product names (and glossary spellings): never translated. */
  names: string[];
  ask?: Ask;
  log?: (m: string) => void;
}

/** One paragraph: protect -> ask (2 tries) -> restore, else the original is kept and flagged. */
export async function translateParagraph(source: string, o: TranslateOpts, previous = ""): Promise<ParagraphResult> {
  const ask = o.ask ?? modelAsk;
  const f = loadFeatures().localize;
  const p = protect(source, o.names);
  const sys = systemPrompt(o.from, o.to);
  let hint = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = `${previous ? `Previous paragraph, already translated (context only, do not repeat it):\n${previous}\n\n` : ""}Translate this paragraph:${hint}\n${p.text}`;
    let answer = "";
    try {
      answer = await ask(sys, user);
    } catch (err) {
      o.log?.(`[translate] model error: ${(err as Error).message.slice(0, 160)}`);
      throw err;
    }
    const text = restore(answer, p.text, p.terms, (t) => localNumber(t, o.to, f.localNumbers));
    if (text) return { source, text, translated: true, issues: reviewNotes(source, text, o.to, { min: f.minRatio, max: f.maxRatio }) };
    o.log?.(`[translate] markers changed by the model (try ${attempt}): ${answer.slice(0, 100)}`);
    hint = ` (Your last answer changed or dropped markers. Copy EVERY marker exactly: ${[...new Set([...p.text.matchAll(MARK)].map((m) => m[0]))].join(" ")})`;
  }
  return { source, text: source, translated: false, issues: [`Not translated: the model kept changing the product names or numbers, so the ${o.from.name} text is kept. Translate this part by hand.`] };
}

export async function translateScript(text: string, o: TranslateOpts): Promise<TranslationResult> {
  const paragraphs: ParagraphResult[] = [];
  let previous = "";
  for (const src of paragraphsOf(text)) {
    const r = await translateParagraph(src, o, previous);
    paragraphs.push(r);
    previous = r.translated ? r.text : "";
  }
  const out = paragraphs.map((p) => p.text).join("\n\n");
  return { text: out, paragraphs, flagged: paragraphs.filter((p) => p.issues.length).length, sourceWords: countWords(text), words: countWords(out) };
}
