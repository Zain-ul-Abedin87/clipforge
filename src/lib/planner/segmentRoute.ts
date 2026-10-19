import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env, hasKey } from "../env.js";
import type { Niche } from "../niche.js";
import type { Scene } from "../scenes.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";
import { LlmCache } from "../llmCache.js";

/**
 * Media routing (plan step, any niche). Every footage scene is classified:
 *  - generic_hook: stats, abstract ideas, intro/outro, buying advice - no specific product on screen.
 *    The assets step skips yt-dlp / web crawl for these and searches Pexels/Pixabay with broad
 *    cinematic queries derived from the niche (e.g. "cinematic lawn mowing", "suburban yard").
 *  - specific_product: the line is about one named product -> strict exact-model pool logic.
 * Stored on each scene (scene.segment, scene.segmentReason, scene.cinematicQueries) in scenes.json.
 */
const Schema = z.object({
  cinematic: z.array(z.string()),
  scenes: z.array(z.object({ id: z.number().int(), segment: z.enum(["generic_hook", "specific_product"]), reason: z.string() })),
});

const heuristicCinematic = (niche: Niche, topic: string): string[] => {
  const base = (niche.stock.fallbackQuery || topic || niche.label).toLowerCase();
  return [`cinematic ${base}`, `${base} slow motion`, `${base} aerial`, `${base} lifestyle`];
};

/** Cached routing answers: one per line, plus the video's cinematic query list. */
export type RouteCache = LlmCache<{ segment: NonNullable<Scene["segment"]>; reason: string } | { cinematic: string[] }>;

export async function routeSegments(scenes: Scene[], niche: Niche, topic: string, useLlm: boolean, log: (m: string) => void, cache?: RouteCache): Promise<Scene[]> {
  const body = scenes.filter((s) => s.type !== "graphic");
  const heur = (s: Scene): Scene["segment"] => (s.type === "product" || s.product_name ? "specific_product" : "generic_hook");
  let cinematic = heuristicCinematic(niche, topic);
  const cls = new Map<number, { segment: NonNullable<Scene["segment"]>; reason: string }>();
  const model = env("ROUTE_MODEL", env("LLM_MODEL", "claude-haiku-4-5"));
  // A line's route depends on its own text and product only; the cinematic list on niche and topic.
  const lineKey = (s: Scene) => LlmCache.key({ v: 1, model, text: s.text, product: s.product_name ?? null, type: s.type });
  const cineKey = LlmCache.key({ v: 1, model, niche: niche.name, topic });
  const cachedCine = cache?.get(cineKey);
  if (cachedCine && "cinematic" in cachedCine) cinematic = cachedCine.cinematic;
  for (const s of body) {
    const hit = cache?.get(lineKey(s));
    if (hit && "segment" in hit) cls.set(s.id, hit);
  }
  const todo = body.filter((s) => !cls.has(s.id));
  if (cache) log(`[plan] segment routing: ${body.length - todo.length}/${body.length} line(s) unchanged (cached)`);
  if (useLlm && llmAvailable() && (todo.length || !cachedCine)) {
    try {
      const client = llm();
      const lines = todo.map((s) => `${s.id}${s.product_name ? ` [product: ${s.product_name}]` : ""}: ${s.text}`).join("\n");
      const res = await client.messages.parse({
        model,
        max_tokens: 4000,
        output_config: { format: zodOutputFormat(Schema) },
        system:
          "You route narration lines of a faceless YouTube video to footage sources. For every scene id answer segment=specific_product when the line is about one specific named product/model (its features, price, specs, use) so footage must show that exact model; answer generic_hook for intros, hooks, statistics, abstract ideas, buying advice, comparisons in general, transitions and outros where no single product must be on screen. reason: max 10 words. Also return 'cinematic': 8-10 varied broad (different settings, angles, times of day, seasons), visual, cinematic stock-footage search queries (2-4 words each) for the video's niche/topic, the kind Pexels/Pixabay have (no brand or model names, no people talking).",
        messages: [{ role: "user", content: `Niche: ${niche.label}. Topic: ${topic}.\nScenes:\n${lines || "(none changed)"}` }],
      });
      const out = res.parsed_output;
      if (out) {
        for (const r of out.scenes) {
          const s = todo.find((x) => x.id === r.id);
          if (!s) continue;
          cls.set(s.id, { segment: r.segment, reason: r.reason });
          cache?.set(lineKey(s), { segment: r.segment, reason: r.reason });
        }
        const c = out.cinematic.map((q) => q.trim()).filter(Boolean);
        // Keep the cached list when there is one, so unchanged generic scenes keep their searches.
        if (c.length && !cachedCine) {
          cinematic = c.slice(0, 10);
          cache?.set(cineKey, { cinematic });
        }
        log(`[plan] segment routing by ${(res as { model?: string }).model ?? model} (${res.usage.input_tokens} in / ${res.usage.output_tokens} out tokens)`);
      }
    } catch (err) {
      log(`[plan] segment routing LLM failed (${String((err as Error).message ?? err).slice(0, 120)}); heuristic used`);
    }
  }
  const outScenes = scenes.map((s) => {
    if (s.type === "graphic") return s;
    const c = cls.get(s.id);
    // A scene the planner tied to a product stays strict even if the LLM says generic.
    let segment = c?.segment ?? heur(s);
    if (s.type === "product") segment = "specific_product";
    return { ...s, segment, segmentReason: c?.reason ?? "heuristic", cinematicQueries: segment === "generic_hook" ? cinematic : undefined };
  });
  const n = outScenes.filter((s) => s.segment === "generic_hook").length;
  log(`[plan] segment routing: ${n} generic_hook (stock only: ${cinematic.join(" | ")}), ${outScenes.filter((s) => s.segment === "specific_product").length} specific_product`);
  return outScenes;
}
