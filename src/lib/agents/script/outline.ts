import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../../env.js";
import { llm, llmAvailable } from "../llm/llm.js";
import { withStage } from "../../models/loader.js";
import type { SourcedFact } from "./facts.js";
import { briefPrompt, ChannelBrief } from "../../channelBrief.js";
import { FormatId, formatOf } from "./formats.js";

/**
 * Script outline: intro (hook), one section per product (countdown order), outro. Word budgets add
 * up exactly to the target: intro ~8%, outro ~5%, the rest split over the products (the #1 pick
 * gets a little more). The model (stage script) adds an angle per section; rules fill in without it.
 */

export interface OutlineSection {
  kind: "intro" | "product" | "compare" | "outro";
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
  /** The format's instruction for this section (formats.ts). */
  what?: string;
  /** The rule-mode opening line. */
  lead?: string;
  /** Items whose sourced facts this section may state. */
  factItems?: string[];
}
export interface Outline {
  topic: string;
  format: FormatId;
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

export async function buildOutline(topic: string, products: string[], targetWords: number, facts: SourcedFact[], log: (m: string) => void = () => {}, brief?: ChannelBrief | null, format?: FormatId): Promise<Outline> {
  const fmt = formatOf(format);
  // The format's section plan (countdown: the last product in the list is #1).
  const plan = fmt.plan(topic, products);
  const budgets = splitBudget(targetWords, plan.map((p) => p.weight));
  const angles = new Map<string, string>();
  let hook = fmt.id === "countdown" ? `The ${products.length} best ${topic}, ranked from good to the one worth your money.` : plan[0].lead;
  if (llmAvailable()) {
    try {
      const res = await withStage("script", () =>
        llm().messages.parse({
          model: env("LLM_MODEL", "claude-haiku-4-5"),
          max_tokens: 1500,
          output_config: { format: zodOutputFormat(Angles) },
          system: `You plan a YouTube script. Format: ${fmt.rules} For each item give a one-sentence angle (what sets it apart, who it matters to) based only on the facts given. Also a one-sentence hook for the intro. Original wording, no hype words like 'game-changer'.${brief ? `\n${briefPrompt(brief)}` : ""}`,
          messages: [{ role: "user", content: JSON.stringify({ topic, products: products.map((p) => ({ product: p, facts: facts.filter((f) => f.product === p).map((f) => `${f.label}: ${f.value}`) })) }) }],
        }),
      );
      for (const s of res.parsed_output?.sections ?? []) angles.set(s.product, s.angle);
      if (res.parsed_output?.hook) hook = res.parsed_output.hook;
    } catch (err) {
      log(`[script] outline angles failed (${String((err as Error).message).slice(0, 100)}); rule angles`);
    }
  }
  const sections: OutlineSection[] = plan.map((p, i) => ({
    kind: p.kind,
    product: p.product,
    rank: p.rank,
    words: budgets[i],
    angle:
      p.kind === "intro"
        ? hook
        : p.kind === "outro"
          ? fmt.id === "countdown"
            ? "Recap the top pick and invite a comment."
            : "Sum up and give a clear answer, then invite a comment."
          : p.product
            ? angles.get(p.product) ?? (fmt.id === "countdown" ? `What ${p.product} does well, who should buy it, and its trade-offs.` : `What matters most about ${p.product}, and its trade-off.`)
            : "Compare them on the same points, one at a time.",
    factIds: facts.filter((f) => p.factItems.includes(f.product)).map((f) => f.id),
    what: fmt.id === "countdown" ? undefined : p.what,
    lead: p.lead,
    factItems: p.factItems,
    names: products,
  }));
  log(`[script] outline (${fmt.id}): ${sections.length} sections, ${targetWords} words (${budgets.join("/")})`);
  return { topic, format: fmt.id, targetWords, sections };
}
