import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { agentEnabled, agentModel } from "./footage.js";
import { batchSize, llm, llmAvailable, splitWhenTooBig } from "../agents/llm/llm.js";
import { LlmCache } from "../llmCache.js";

/**
 * The editor's two judgement calls that keyword search and CLIP cannot make:
 * 1. planSubjects: reading the whole script, which product each scene is about (also when the
 *    sentence does not name it: "It weighs ten ounces" after "Ruger's LCP MAX ...") and what kind
 *    of shot it needs. Product / detail shots then use only that product's own media.
 * 2. vetCandidates: looking at the best stock thumbnails for a scene and rejecting the ones a
 *    viewer would call wrong (another gun type, an oil drum for "barrel", a zodiac sign for
 *    "Taurus"), before anything is downloaded.
 */

export type Shot = "product" | "detail" | "comparison" | "generic";
export interface SceneSubject {
  subject: string | null;
  shot: Shot;
}

const client = () => llm();
function outputConfig<T extends z.ZodType>(schema: T) {
  return agentModel().startsWith("claude-haiku") ? { format: zodOutputFormat(schema) } : { effort: "low" as const, format: zodOutputFormat(schema) };
}

const SubjectsSchema = z.object({
  scenes: z.array(z.object({ id: z.number().int(), subject: z.string(), shot: z.enum(["product", "detail", "comparison", "generic"]) })),
});

const SUBJECTS = `You are the editor of a product video. You get the scenes of the narration in order and the list of products in the video.
For every scene decide:
- subject: the product the narrator is talking about at that moment (exactly as written in the product list), also when the sentence only says "it"/"this one"/"the gun". Use "none" for the intro, outro or general talk not about one product.
- shot:
  - product: the viewer should see that product (its specs, size, looks, price, capacity, verdict about it).
  - detail: a specific part of that product is described (sights, trigger, barrel, magazine, slide).
  - comparison: the sentence compares it with another product.
  - generic: the sentence is about something else (ammunition choice, practice, holsters, the market, the company's reputation) and a fitting generic shot is better than the product.
Return every scene id in order.`;

/**
 * Who each scene is about. Cached per section (its scene texts, the product list and topic), so
 * an edited sentence re-asks only for its own section; the others keep their subjects and shots.
 */
export async function planSubjects(
  scenes: { id: number; text: string; section?: number }[],
  products: string[],
  topic: string,
  cacheFile: string,
  log: (m: string) => void,
): Promise<Map<number, SceneSubject>> {
  const out = new Map<number, SceneSubject>();
  if (!agentEnabled() || !products.length || !scenes.length) return out;
  const cache = new LlmCache<{ subject: string | null; shot: Shot }[]>(cacheFile);
  const groups = new Map<number, typeof scenes>();
  for (const s of scenes) groups.set(s.section ?? -1, [...(groups.get(s.section ?? -1) ?? []), s]);
  const keyOf = (g: typeof scenes) => LlmCache.key({ v: 2, m: agentModel(), products, topic, t: g.map((s) => s.text) });
  const todo: typeof scenes = [];
  for (const g of groups.values()) {
    const hit = cache.get(keyOf(g));
    if (hit && hit.length === g.length) g.forEach((s, k) => out.set(s.id, hit[k]));
    else todo.push(...g);
  }
  if (todo.length) {
    try {
      // Chunks a local model's context holds; one it cannot take is halved (splitWhenTooBig).
      const ask = async (part: typeof todo) => {
        const res = await client().messages.parse({
          model: agentModel(),
          max_tokens: 16000,
          output_config: outputConfig(SubjectsSchema),
          system: SUBJECTS,
          messages: [{ role: "user", content: JSON.stringify({ topic, products, scenes: part.map((s) => ({ id: s.id, text: s.text })) }) }],
        });
        return [res];
      };
      const size = batchSize(400);
      const answers = [];
      for (let i = 0; i < todo.length; i += size) answers.push(...(await splitWhenTooBig(todo.slice(i, i + size), ask, log)));
      const res = { usage: { input_tokens: answers.reduce((a, r) => a + r.usage.input_tokens, 0), output_tokens: answers.reduce((a, r) => a + r.usage.output_tokens, 0) } };
      const rows = new Map(answers.flatMap((r) => r.parsed_output?.scenes ?? []).map((r) => [r.id, { subject: products.find((p) => p.toLowerCase() === r.subject.toLowerCase()) ?? null, shot: r.shot }]));
      for (const g of groups.values()) {
        if (!g.every((s) => rows.has(s.id) || out.has(s.id))) continue;
        for (const s of g) if (rows.has(s.id)) out.set(s.id, rows.get(s.id)!);
        if (g.some((s) => rows.has(s.id))) cache.set(keyOf(g), g.map((s) => out.get(s.id)!));
      }
      log(`[editor] subjects for ${rows.size} scene(s), ${scenes.length - todo.length} unchanged (cached) (${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens)`);
    } catch (err) {
      log(`[editor] subject tracking failed: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  } else log(`[editor] subjects: all ${scenes.length} scene(s) unchanged (cached)`);
  cache.save();
  return out;
}

const VetSchema = z.object({
  scenes: z.array(z.object({ id: z.number().int(), ok: z.array(z.number().int()) })),
});

const VET = `You check stock footage thumbnails for a product video, like a strict editor. For each scene you get the narration (and the product being discussed) and numbered thumbnails.
Return, per scene, the numbers of the thumbnails that are acceptable: they suit the sentence and the video topic, and a viewer would not call them wrong.
Reject:
- a clearly different product or kind of product than the one discussed (a rifle or revolver while a compact pistol is discussed; another brand's logo);
- a different meaning of a word (an oil drum for a gun "barrel", a zodiac sign or bull for the brand "Taurus", a balance scale for "comparison");
- cartoons, animations or illustrations in a live-action video, and shots unrelated to the topic.
Keep generic shots that fit (ammunition, hands at a range, holsters, a gun store) when they show no wrong identifiable product. An empty list is allowed.`;

export interface VetItem {
  id: number;
  text: string;
  subject: string | null;
  thumbs: { candId: string; data: Buffer }[];
}

/** Accepted candidate ids per scene; scenes missing from the map were not judged (keep CLIP's pick). */
export async function vetCandidates(items: VetItem[], topic: string, log: (m: string) => void): Promise<Map<number, Set<string>>> {
  const out = new Map<number, Set<string>>();
  // Thumbnails are images: only a vision-capable model can judge them.
  if (!agentEnabled() || !llmAvailable({ vision: true })) return out;
  const usage = { in: 0, out: 0 };
  const per = batchSize(5, 1); // a local vision model: one scene's thumbnails per request
  for (let i = 0; i < items.length; i += per) {
    const batch = items.slice(i, i + per).filter((b) => b.thumbs.length);
    if (!batch.length) continue;
    const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: `Video topic: ${topic}` }];
    for (const it of batch) {
      content.push({ type: "text", text: `Scene ${it.id}. Product discussed: ${it.subject ?? "none"}. Narration: "${it.text}"` });
      it.thumbs.forEach((t, k) => {
        content.push({ type: "text", text: `Scene ${it.id} thumbnail ${k}:` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: t.data.toString("base64") } });
      });
    }
    try {
      const res = await client().messages.parse({ model: agentModel(), max_tokens: 3000, output_config: outputConfig(VetSchema), system: VET, messages: [{ role: "user", content }] });
      usage.in += res.usage.input_tokens;
      usage.out += res.usage.output_tokens;
      for (const r of res.parsed_output?.scenes ?? []) {
        const it = batch.find((b) => b.id === r.id);
        if (it) out.set(r.id, new Set(r.ok.filter((k) => k >= 0 && k < it.thumbs.length).map((k) => it.thumbs[k].candId)));
      }
    } catch (err) {
      log(`[editor] thumbnail check failed: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  if (items.length) log(`[editor] checked thumbnails for ${out.size}/${items.length} scenes (${usage.in} in / ${usage.out} out tokens)`);
  return out;
}
