import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../../env.js";
import { llm, llmAvailable } from "../llm/llm.js";
import { withStage } from "../../models/loader.js";
import type { SourcedFact } from "./facts.js";
import { briefPrompt, ChannelBrief } from "../../channelBrief.js";

/**
 * Script outline: intro (hook), one section per product (countdown order), outro. Word budgets add
 * up exactly to the target: intro ~8%, outro ~5%, the rest split over the products (the #1 pick
 * gets a little more). The model (stage script) adds an angle per section; rules fill in without it.
 */

export interface OutlineSection {
  kind: "intro" | "product" | "outro";
  product?: string;
  rank?: number;
  words: number;
  angle: string;
  factIds: string[];
  /** All product names of the video (intro / outro may name them; their numbers are not claims). */
  names?: string[];
  /** Retention beat instructions for this section (src/lib/agents/script/beats.ts). */
  beats?: string[];
  /** SOP rules / do / don't the writer follows. */
  rules?: string[];
}
export interface Outline {
  topic: string;
  targetWords: number;
  sections: OutlineSection[];
}

/** Integer budgets that sum to `total` (largest-remainder rounding). */
export function splitBudget(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const raw = weights.map((w) => (total * w) / sum);
  const out = raw.map(Math.floor);
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0]);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) out[order[k][1]]++;
  return out;
}

const Angles = z.object({ sections: z.array(z.object({ product: z.string(), angle: z.string() })), hook: z.string() });

export async function buildOutline(topic: string, products: string[], targetWords: number, facts: SourcedFact[], log: (m: string) => void = () => {}, brief?: ChannelBrief | null): Promise<Outline> {
  // Countdown: the last product in the list is #1.
  const weights = [0.08, ...products.map((_, i) => (i === products.length - 1 ? 1.2 : 1) * (0.87 / products.length)), 0.05];
  const budgets = splitBudget(targetWords, weights);
  const angles = new Map<string, string>();
  let hook = `The ${products.length} best ${topic}, ranked from good to the one worth your money.`;
  if (llmAvailable()) {
    try {
      const res = await withStage("script", () =>
        llm().messages.parse({
          model: env("LLM_MODEL", "claude-haiku-4-5"),
          max_tokens: 1500,
          output_config: { format: zodOutputFormat(Angles) },
          system: `You plan a countdown YouTube script. For each product give a one-sentence angle (who it is for, what sets it apart) based only on the facts given. Also a one-sentence hook for the intro. Original wording, no hype words like 'game-changer'.${brief ? `\n${briefPrompt(brief)}` : ""}`,
          messages: [{ role: "user", content: JSON.stringify({ topic, products: products.map((p) => ({ product: p, facts: facts.filter((f) => f.product === p).map((f) => `${f.label}: ${f.value}`) })) }) }],
        }),
      );
      for (const s of res.parsed_output?.sections ?? []) angles.set(s.product, s.angle);
      if (res.parsed_output?.hook) hook = res.parsed_output.hook;
    } catch (err) {
      log(`[script] outline angles failed (${String((err as Error).message).slice(0, 100)}); rule angles`);
    }
  }
  const sections: OutlineSection[] = [{ kind: "intro", words: budgets[0], angle: hook, factIds: [] }];
  products.forEach((p, i) =>
    sections.push({ kind: "product", product: p, rank: products.length - i, words: budgets[i + 1], angle: angles.get(p) ?? `What ${p} does well, who should buy it, and its trade-offs.`, factIds: facts.filter((f) => f.product === p).map((f) => f.id) }),
  );
  sections.push({ kind: "outro", words: budgets.at(-1)!, angle: "Recap the top pick and invite a comment.", factIds: [] });
  for (const s of sections) s.names = products;
  log(`[script] outline: ${sections.length} sections, ${targetWords} words (${budgets.join("/")})`);
  return { topic, targetWords, sections };
}
