import fs from "node:fs";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../../env.js";
import { netFetch } from "../../net.js";
import { estimateTokens, llm, llmAvailable } from "../llm/llm.js";
import { withStage } from "../../models/loader.js";

/**
 * Sourced facts for the script writer. Every spec the script may state carries the page it came
 * from (url + title). Facts come from:
 *  - a facts file you write or edit (<project>/facts_sources.json: [{product, label, value, url, title}]);
 *  - product pages you list (<project>/sources.json: {"Product": ["https://..."]}): each page is
 *    fetched and the local model extracts specs from ITS text only (the page URL is the source).
 * The claim checker then makes sure every number / unit in the finished script matches a sourced
 * fact of that section's product; anything else is an unsourced claim and is rewritten or removed.
 */

export interface FactSource {
  url: string;
  title: string;
}
export interface SourcedFact {
  id: string;
  product: string;
  label: string;
  value: string;
  source: FactSource;
}

const PageFacts = z.object({ facts: z.array(z.object({ label: z.string(), value: z.string() })) });

export function htmlToText(html: string): { title: string; text: string } {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const text = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/li|\/tr|\/h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
  return { title, text };
}

/** Spec-like lines first (they hold numbers), cut to what fits the model's context. */
export function specText(text: string, maxTokens = 3500): string {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 3 && l.length < 300);
  const specy = lines.filter((l) => /\d/.test(l));
  const rest = lines.filter((l) => !/\d/.test(l));
  let out = "";
  for (const l of [...specy, ...rest]) {
    if (estimateTokens([{ role: "user", content: out + l }]) > maxTokens) break;
    out += l + "\n";
  }
  return out.trim();
}

let n = 0;
const nextId = () => `F${++n}`;
export const resetFactIds = () => (n = 0);

export function loadFactsFile(file: string): SourcedFact[] {
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { product: string; label: string; value: string; url: string; title?: string }[];
  return raw.filter((f) => f.product && f.label && f.value && /^https?:\/\//.test(f.url ?? "")).map((f) => ({ id: nextId(), product: f.product, label: f.label, value: f.value, source: { url: f.url, title: f.title ?? f.url } }));
}

/** Specs of `product` from one page's text (local model, stage script). Only facts in that text. */
export async function factsFromPage(product: string, page: { url: string; title: string; text: string }, log: (m: string) => void = () => {}): Promise<SourcedFact[]> {
  if (!llmAvailable()) return [];
  const body = specText(page.text);
  if (!body) return [];
  try {
    const res = await withStage("script", () =>
      llm().messages.parse({
        model: env("LLM_MODEL", "claude-haiku-4-5"),
        max_tokens: 1500,
        output_config: { format: zodOutputFormat(PageFacts) },
        system: `You extract product specifications for "${product}" from a web page. Return only facts written in the page text (label 1-3 words, value with its unit, e.g. "Capacity": "10+1 rounds", "Weight": "17.8 oz", "Price": "$499"). Never add facts the text does not state. If the page is about another product, return an empty list.`,
        messages: [{ role: "user", content: `Page: ${page.title}\n\n${body}` }],
      }),
    );
    const facts = (res.parsed_output?.facts ?? []).filter((f) => f.label.trim() && f.value.trim() && pageHas(body, f.value));
    log(`[script] facts: ${facts.length} spec(s) for ${product} from ${page.url}`);
    return facts.map((f) => ({ id: nextId(), product, label: f.label.trim(), value: f.value.trim(), source: { url: page.url, title: page.title || page.url } }));
  } catch (err) {
    log(`[script] facts from ${page.url} failed: ${String((err as Error).message).slice(0, 120)}`);
    return [];
  }
}

/** A value's numbers must appear in the page text (a model cannot invent a spec). */
export function pageHas(text: string, value: string): boolean {
  const nums = numbersIn(value);
  if (!nums.length) return text.toLowerCase().includes(value.toLowerCase().slice(0, 20));
  const pageNums = new Set(numbersIn(text));
  return nums.every((x) => pageNums.has(x));
}

export async function factsFromUrls(product: string, urls: string[], log: (m: string) => void = () => {}, f: typeof fetch = netFetch as unknown as typeof fetch): Promise<SourcedFact[]> {
  const out: SourcedFact[] = [];
  for (const url of urls.slice(0, 4)) {
    try {
      const res = await f(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ClipForge research)" }, signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out.push(...(await factsFromPage(product, { url, ...htmlToText(await res.text()) }, log)));
    } catch (err) {
      log(`[script] could not read ${url}: ${String((err as Error).message).slice(0, 100)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Claim checker

/** Numbers in a text, normalised ("1,200" -> "1200", "17.80" -> "17.8"). Years 1900-2099 are kept. */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d[\d,]*(?:\.\d+)?/g)].map((m) => String(Number(m[0].replace(/,/g, ""))));
}

const SMALL = new Set(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

export interface ClaimIssue {
  sentence: string;
  numbers: string[];
}

/**
 * Sentences that state a number not found in `facts` (of this section's product). Small counting
 * numbers (1-10, the list rank "number 7", "two reasons") are allowed.
 */
export function unsourcedClaims(text: string, facts: SourcedFact[], allowed: string[] = []): ClaimIssue[] {
  // Numbers inside product names ("Glock 43X", "Sig P365") are names, not claims.
  const known = new Set([...facts.flatMap((f) => numbersIn(f.value)), ...allowed.flatMap((x) => numbersIn(x))]);
  const issues: ClaimIssue[] = [];
  for (const sentence of splitSentences(text)) {
    const nums = numbersIn(sentence).filter((x) => !SMALL.has(x) && !known.has(x));
    if (nums.length) issues.push({ sentence, numbers: nums });
  }
  return issues;
}

export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Removes sentences with unsourced numbers (last resort after a rewrite round). */
export function dropUnsourced(text: string, facts: SourcedFact[], allowed: string[] = []): string {
  const bad = new Set(unsourcedClaims(text, facts, allowed).map((i) => i.sentence));
  return splitSentences(text).filter((s) => !bad.has(s)).join(" ");
}
