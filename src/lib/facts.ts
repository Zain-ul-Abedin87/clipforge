import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "./env.js";
import { agentEnabled, agentModel } from "./agent/footage.js";
import type { Scene } from "./scenes.js";

/**
 * Script fact sheet (any product niche: tech, kitchen, tools, outdoor, ...). The LLM reads the
 * narration once and returns, per product in spoken order: name, rank, price as said, 3-6 key
 * specs as label/value pairs, pros, cons and a one-line verdict. Cards, chapters, the comparison
 * table and the publish pack all read <project>/facts.json. Without an API key (or on failure) the
 * planner's own card text (scenes.json graphics) is parsed instead, so nothing blocks.
 */

export interface Spec { label: string; value: string }
export interface ProductFacts {
  name: string;
  rank?: number;
  price?: string;
  specs: Spec[];
  pros: string[];
  cons: string[];
  verdict?: string;
}
export interface Facts { source: "llm" | "heuristic"; topic: string; products: ProductFacts[] }

const Schema = z.object({
  topic: z.string(),
  products: z.array(
    z.object({
      name: z.string(),
      rank: z.number().int().nullable(),
      price: z.string().nullable(),
      specs: z.array(z.object({ label: z.string(), value: z.string() })),
      pros: z.array(z.string()),
      cons: z.array(z.string()),
      verdict: z.string().nullable(),
    }),
  ),
});

const SYSTEM = `You extract an on-screen fact sheet from the narration of a product listicle video. The products can be anything (phones, blenders, drills, tents, guns, cars).
Return:
- topic: 3-8 words, what the video ranks (e.g. "budget noise-cancelling headphones").
- products: every ranked/reviewed product, in the order it is presented. Use exactly the product names from the given list when one matches.
  - rank: the number the narrator gives it (#1, number 5, "first on our list" = the position) or null.
  - price: the price as on a price tag, from the script only ("$279", "$400-$480", "Around $300"). null if not said. Never guess.
  - specs: 3-6 short facts for a spec card, label 1-2 words, value max 18 chars, both as said in the script, normalised to digits and units ("Weight": "10.6 oz", "Battery": "30 h", "Capacity": "10+1"). Only facts stated in the script. No price here.
  - pros / cons: 1-3 each, max 6 words each, from the script.
  - verdict: max 8 words, or null.`;

const cacheKey = (scenes: Scene[], products: string[]) =>
  crypto.createHash("sha1").update(JSON.stringify({ m: agentModel(), products, t: scenes.map((s) => s.text), v: 2 })).digest("hex");

export function readFacts(dir: string): Facts | null {
  const f = path.join(dir, "facts.json");
  if (!fs.existsSync(f)) return null;
  try {
    return JSON.parse(fs.readFileSync(f, "utf8").replace(/^\uFEFF/, "")).facts as Facts;
  } catch {
    return null;
  }
}

/** Products in spoken order (planner product_name + titles of rank cards). */
export function productOrder(scenes: Scene[]): string[] {
  const out: string[] = [];
  for (const s of scenes) if (s.product_name && !out.includes(s.product_name)) out.push(s.product_name);
  return out;
}

export async function extractFacts(dir: string, scenes: Scene[], log: (m: string) => void): Promise<Facts> {
  const products = productOrder(scenes);
  const key = cacheKey(scenes, products);
  const file = path.join(dir, "facts.json");
  if (fs.existsSync(file)) {
    try {
      const c = JSON.parse(fs.readFileSync(file, "utf8"));
      if (c.key === key && c.facts) return c.facts as Facts;
    } catch { /* re-extract */ }
  }
  let facts: Facts | null = null;
  if (agentEnabled() && env("FACTS", "on").toLowerCase() !== "off") {
    try {
      const client = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
      const res = await client.messages.parse({
        model: agentModel(),
        max_tokens: 8000,
        ...(agentModel().startsWith("claude-haiku") ? { output_config: { format: zodOutputFormat(Schema) } } : { output_config: { effort: "low" as const, format: zodOutputFormat(Schema) } }),
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify({ products, script: scenes.map((s) => s.text).join(" ") }) }],
      });
      const p = res.parsed_output;
      if (p?.products?.length) {
        facts = {
          source: "llm",
          topic: p.topic,
          products: p.products.map((x) => ({
            name: products.find((n) => n.toLowerCase() === x.name.toLowerCase()) ?? x.name,
            rank: x.rank ?? undefined,
            price: x.price ?? undefined,
            specs: x.specs.filter((s) => s.label && s.value).slice(0, 6),
            pros: x.pros.slice(0, 3),
            cons: x.cons.slice(0, 3),
            verdict: x.verdict ?? undefined,
          })),
        };
        log(`[facts] ${facts.products.length} product(s) from the script (${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens)`);
      }
    } catch (err) {
      log(`[facts] LLM extraction failed, using planner card text: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  facts ??= heuristicFacts(scenes, products);
  fs.writeFileSync(file, JSON.stringify({ key, facts }, null, 1));
  return facts;
}

/** Fallback: the planner's graphics (spec_card lines, price_badge, pros_cons, "#2: Name" titles). */
export function heuristicFacts(scenes: Scene[], products: string[]): Facts {
  const out: ProductFacts[] = products.map((name) => ({ name, specs: [], pros: [], cons: [] }));
  const by = (n?: string) => out.find((p) => p.name === n);
  for (const s of scenes) {
    const g = s.graphic;
    if (!g) continue;
    const rankM = g.title.match(/#\s*(\d+)\s*[:\-]?\s*(.+)$/);
    const p = by(s.product_name) ?? (rankM ? out.find((x) => rankM[2].toLowerCase().includes(x.name.toLowerCase())) : undefined);
    if (!p) continue;
    if (g.rank !== undefined) p.rank ??= g.rank;
    if (rankM) p.rank ??= Number(rankM[1]);
    if (g.kind === "price_badge" && g.price) p.price ??= g.price;
    if (g.kind === "spec_card") for (const l of g.lines) p.specs.push(splitSpec(l.replace(/^[+-]\s*/, "")));
    if (g.kind === "pros_cons") for (const l of g.lines) (l.trim().startsWith("-") ? p.cons : p.pros).push(l.replace(/^[+-]\s*/, "").trim());
  }
  return { source: "heuristic", topic: "", products: out };
}

/** "10.6 oz empty" -> {label: "Weight"?...}: label:value, "label - value", else a unit-based guess. */
export function splitSpec(line: string): Spec {
  const m = line.match(/^([^:]{2,24}):\s*(.+)$/) ?? line.match(/^(.{2,24}?)\s+-\s+(.+)$/);
  if (m) return { label: m[1].trim(), value: m[2].trim() };
  const num = line.match(/^([~≈]?\$?\d[\d.,+\-x"']*\s*[a-zA-Z%"']{0,6})\s*(.*)$/);
  if (num && num[2]) return { label: num[2].trim().slice(0, 24), value: num[1].trim() };
  return { label: line.trim(), value: "" };
}

/** Numeric part of a value for bars ("10+1" -> 11, "22 oz" -> 22, "$1,299" -> 1299). */
export function numOf(v: string): number | null {
  const plus = v.match(/(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)/);
  if (plus) return Number(plus[1]) + Number(plus[2]);
  const m = v.replace(/,/g, "").match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function normalisePrice(p?: string): number | null {
  return p ? numOf(p) : null;
}
