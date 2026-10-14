import crypto from "node:crypto";
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { agentEnabled, agentModel } from "./footage.js";

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

const client = () => new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
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

export async function planSubjects(
  scenes: { id: number; text: string }[],
  products: string[],
  topic: string,
  cacheFile: string,
  log: (m: string) => void,
): Promise<Map<number, SceneSubject>> {
  const out = new Map<number, SceneSubject>();
  if (!agentEnabled() || !products.length || !scenes.length) return out;
  const key = crypto.createHash("sha1").update(JSON.stringify({ m: agentModel(), products, topic, t: scenes.map((s) => s.text), v: 1 })).digest("hex");
  const cache = fs.existsSync(cacheFile) ? (JSON.parse(fs.readFileSync(cacheFile, "utf8")) as { key: string; scenes: { id: number; subject: string | null; shot: Shot }[] }) : null;
  let rows = cache?.key === key ? cache.scenes : null;
  if (!rows) {
    try {
      const res = await client().messages.parse({
        model: agentModel(),
        max_tokens: 16000,
        output_config: outputConfig(SubjectsSchema),
        system: SUBJECTS,
        messages: [{ role: "user", content: JSON.stringify({ topic, products, scenes }) }],
      });
      rows = (res.parsed_output?.scenes ?? []).map((r) => ({
        id: r.id,
        subject: products.find((p) => p.toLowerCase() === r.subject.toLowerCase()) ?? null,
        shot: r.shot,
      }));
      fs.writeFileSync(cacheFile, JSON.stringify({ key, scenes: rows }, null, 1));
      log(`[editor] subjects for ${rows.length} scenes (${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens)`);
    } catch (err) {
      log(`[editor] subject tracking failed: ${String((err as Error).message ?? err).slice(0, 160)}`);
      return out;
    }
  }
  for (const r of rows) out.set(r.id, { subject: r.subject, shot: r.shot });
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
  if (!agentEnabled()) return out;
  const usage = { in: 0, out: 0 };
  for (let i = 0; i < items.length; i += 5) {
    const batch = items.slice(i, i + 5).filter((b) => b.thumbs.length);
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
