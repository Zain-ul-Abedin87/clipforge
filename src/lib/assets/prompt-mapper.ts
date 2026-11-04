import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { batchSize, isTooBig, llm, llmAvailable, splitWhenTooBig } from "../agents/llm/llm.js";
import { withStage } from "../models/loader.js";

/**
 * Prompt mapper: for every narration segment, a stock search query (2-5 filmable words) and an
 * image-generation prompt (for ComfyUI, only used when nothing real fits). Product segments never
 * get a generated picture (exact-model policy: a generated product would be a fake), so their
 * `allowGenerated` is false.
 */

export interface SegmentIn {
  id: number;
  text: string;
  product?: string | null;
}

export interface VisualPrompt {
  id: number;
  query: string;
  imagePrompt: string;
  subject: string;
  allowGenerated: boolean;
  source: "llm" | "rules";
}

const Schema = z.object({
  segments: z.array(z.object({ id: z.number().int(), query: z.string(), imagePrompt: z.string(), subject: z.string() })),
});

const SYSTEM = `You plan B-roll for a faceless YouTube video. For each narration segment return:
- query: 2-5 plain words a stock site has footage for (a thing a camera can film: objects, places, actions). No brand names unless the segment is about that product, no prices, no years, no punctuation.
- imagePrompt: one sentence for an image generator: a realistic cinematic photo of that subject, natural light, 16:9, no text, no logos, no people's faces.
- subject: 1-3 words, the main visible thing.
Every segment gets a DIFFERENT query and subject (no two segments the same picture). Return every id you were given.`;

const STOP = new Set("a an the and or but of to in on for with is are was were be been it its this that these those you your i we our they their he she his her my me at by from as so if then than there here just very really also can will would should could not no yes do does did have has had what which who when where why how all any some more most other into over under about up down out off only own same too again".split(" "));

/** Rule-based mapping (no model): the segment's longest content words. */
export function ruleMap(s: SegmentIn): VisualPrompt {
  const words = s.text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w));
  const ranked = [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, 3);
  const subject = s.product ? s.product : ranked.slice(0, 2).join(" ") || "landscape";
  const query = (s.product ? `${s.product}` : ranked.join(" ")) || "cinematic landscape";
  return {
    id: s.id,
    query,
    imagePrompt: `Realistic cinematic photo of ${subject}, natural light, shallow depth of field, 16:9, no text, no logos`,
    subject,
    allowGenerated: !s.product,
    source: "rules",
  };
}

/** Makes queries unique across segments (a repeated query would find the same clip). */
export function dedupeQueries(list: VisualPrompt[], segs: SegmentIn[]): VisualPrompt[] {
  const seen = new Map<string, number>();
  return list.map((v) => {
    const q = v.query.trim().toLowerCase();
    const n = seen.get(q) ?? 0;
    seen.set(q, n + 1);
    if (!n) return v;
    // Second use: add a distinct content word from the segment's own text.
    const own = ruleMap(segs.find((s) => s.id === v.id) ?? { id: v.id, text: "" }).query.split(" ").find((w) => !q.includes(w));
    return { ...v, query: own ? `${q} ${own}` : `${q} close up` };
  });
}

export async function mapPrompts(segs: SegmentIn[], log: (m: string) => void = () => {}): Promise<VisualPrompt[]> {
  const rules = new Map(segs.map((s) => [s.id, ruleMap(s)]));
  if (!segs.length) return [];
  if (!llmAvailable()) {
    log(`[visuals] prompt mapper: no model available; rule-based queries for ${segs.length} segment(s)`);
    return dedupeQueries(segs.map((s) => rules.get(s.id)!), segs);
  }
  const got = new Map<number, Omit<VisualPrompt, "allowGenerated" | "source">>();
  const ask = async (part: SegmentIn[]) => {
    const res = await withStage("assets", () =>
      llm().messages.parse({
        model: env("LLM_MODEL", "claude-haiku-4-5"),
        max_tokens: 4000,
        output_config: { format: zodOutputFormat(Schema) },
        system: SYSTEM,
        messages: [{ role: "user", content: JSON.stringify(part.map((s) => ({ id: s.id, text: s.text.slice(0, 400), ...(s.product ? { product: s.product } : {}) }))) }],
      }),
    );
    return [res.parsed_output];
  };
  const size = batchSize(40, 12);
  for (let i = 0; i < segs.length; i += size) {
    try {
      for (const r of await splitWhenTooBig(segs.slice(i, i + size), ask, log)) for (const x of r?.segments ?? []) if (x.query.trim()) got.set(x.id, x);
    } catch (err) {
      log(`[visuals] prompt mapper batch failed (${isTooBig(err) ? "too big" : String((err as Error).message).slice(0, 100)}); rules fill in`);
    }
  }
  const out = segs.map((s): VisualPrompt => {
    const m = got.get(s.id);
    if (!m) return rules.get(s.id)!;
    const query = m.query.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 6).join(" ");
    return { id: s.id, query, imagePrompt: m.imagePrompt.trim(), subject: m.subject.trim(), allowGenerated: !s.product, source: "llm" };
  });
  log(`[visuals] prompt mapper: ${got.size}/${segs.length} from the model, ${segs.length - got.size} from rules`);
  return dedupeQueries(out, segs);
}
