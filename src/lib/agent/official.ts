import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { agentEnabled, agentModel } from "./footage.js";

/** Small Claude helpers for the official photo importer (only used when the agent is on). */

const Choice = z.object({ index: z.number().int(), reason: z.string() });
const Picks = z.object({ indexes: z.array(z.number().int()) });

function outputConfig<T extends z.ZodType>(schema: T) {
  const model = agentModel();
  // Haiku 4.5 rejects the effort setting.
  return model.startsWith("claude-haiku") ? { format: zodOutputFormat(schema) } : { effort: "low" as const, format: zodOutputFormat(schema) };
}

const client = () => new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

/** Picks the manufacturer page that is the product page of `product` (or -1 when none is). */
export async function choosePage(product: string, pages: { url: string; label?: string }[]): Promise<number> {
  if (!agentEnabled() || !pages.length) return pages.length ? 0 : -1;
  try {
    const res = await client().messages.parse({
      model: agentModel(),
      max_tokens: 2000,
      output_config: outputConfig(Choice),
      system:
        "You match a product name to the manufacturer's product page. Pick the page that is the product page for exactly this model (the same model family and type; variants such as finish or caliber are fine). Return -1 if none is that product.",
      messages: [{ role: "user", content: JSON.stringify({ product, pages: pages.map((p, i) => ({ index: i, url: p.url, link_text: p.label ?? "" })) }) }],
    });
    return res.parsed_output?.index ?? -1;
  } catch {
    return 0;
  }
}

export interface ImageIn {
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  data: Buffer;
}

/** Looks at the images and returns the indexes that are product photos of `product`. */
export async function pickProductPhotos(product: string, images: ImageIn[]): Promise<number[]> {
  if (!agentEnabled() || !images.length) return [];
  const content: Anthropic.ContentBlockParam[] = [];
  images.forEach((img, i) => {
    content.push({ type: "text", text: `Image ${i}:` });
    content.push({ type: "image", source: { type: "base64", media_type: img.mime, data: img.data.toString("base64") } });
  });
  content.push({
    type: "text",
    text: `Which images clearly show the product "${product}" itself (a product photo or a clear shot of this firearm/item)? Leave out logos, icons, banners, other models, people without the product, and tiny thumbnails. Return their indexes, best first.`,
  });
  try {
    const res = await client().messages.parse({ model: agentModel(), max_tokens: 1000, output_config: outputConfig(Picks), messages: [{ role: "user", content }] });
    return (res.parsed_output?.indexes ?? []).filter((i) => i >= 0 && i < images.length);
  } catch {
    return [];
  }
}
