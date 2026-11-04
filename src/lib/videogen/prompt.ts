import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";
import { withStage } from "../models/loader.js";
import { buildFlowPrompt, FlowAngle } from "../flowPrompt.js";

/**
 * The creator's own words ("show it on a workbench at night, slow push in") become a video prompt.
 * The AI (local or API, whichever the AI engine switch picks) only rewrites the scene description;
 * the product lock is added by code afterwards, so a model can never talk the product away.
 * Without an AI model the rule-based prompt is used and the wish is added as written.
 */

export interface ScenePromptInput {
  wish: string;
  product: string | null;
  category?: string | null;
  spec?: string | null;
  sceneText: string;
  angle: FlowAngle;
  seconds: number;
  /** The reference is a real product photo (not a frame of the current clip). */
  realPhoto: boolean;
}

export type Ask = (system: string, user: string) => Promise<string>;

/** Added by code to every prompt with a product: the generated clip must show the real one. */
export function productLock(product: string | null): string {
  if (!product) return "";
  return `The ${product} must stay exactly as in the reference image: same shape, colours, parts, text and logos. Do not redesign, replace or add a different product.`;
}

const Out = z.object({ prompt: z.string() });
const modelAsk: Ask = async (system, user) => {
  const res = await withStage("assets", () =>
    llm().messages.parse({ model: env("LLM_MODEL", "claude-haiku-4-5"), max_tokens: 600, output_config: { format: zodOutputFormat(Out) }, system, messages: [{ role: "user", content: user }] }),
  );
  return (res.parsed_output?.prompt ?? "").replace(/\s+/g, " ").trim();
};

/** `ask: null` = no AI this time (e.g. the local AI is not running): the rule-based prompt at once. */
export async function writeScenePrompt(i: ScenePromptInput, o: { ask?: Ask | null; log?: (m: string) => void } = {}): Promise<{ prompt: string; writer: "model" | "rules" }> {
  const base = buildFlowPrompt({ product: i.product, spec: i.spec ?? null, category: i.category ?? null, sceneText: i.sceneText, angle: i.angle, seconds: i.seconds });
  const wish = i.wish.replace(/\s+/g, " ").trim().slice(0, 500);
  const lock = productLock(i.product);
  const join = (p: string) => [p, lock].filter(Boolean).join(" ");
  if (!wish) return { prompt: base, writer: "rules" };
  const ask = o.ask === null ? null : o.ask ?? (llmAvailable() ? modelAsk : null);
  if (ask) {
    try {
      const system = [
        "You write prompts for an image-to-video model (Veo, Runway, Seedance). The reference image is the first frame.",
        "Write ONE paragraph in English, under 120 words: what happens in the shot, camera movement, setting, lighting.",
        "Follow the creator's wish. Keep the product exactly as in the reference image; never describe a different design.",
        "No on-screen text, captions, watermarks or faces. Do not invent product features or specs.",
      ].join("\n");
      const user = `Product: ${i.product ?? "none (general B-roll)"}\nCamera idea: ${base}\nNarration of this scene (context only): "${i.sceneText.slice(0, 300)}"\nCreator's wish: "${wish}"`;
      const p = (await ask(system, user)).trim();
      if (p.length >= 20) return { prompt: join(p), writer: "model" };
      o.log?.("[videogen] the AI returned an empty prompt; using the rule-based prompt");
    } catch (err) {
      o.log?.(`[videogen] prompt writer failed (${(err as Error).message.slice(0, 120)}); using the rule-based prompt`);
    }
  }
  return { prompt: join(`${base} Creator's direction: ${wish}.`), writer: "rules" };
}
