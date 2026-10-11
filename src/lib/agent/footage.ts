import crypto from "node:crypto";
import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env, hasKey } from "../env.js";
import type { Niche } from "../niche.js";
import type { Scene } from "../scenes.js";

/**
 * AI Footage Agent: Claude reads each scene and writes stock-footage searches the way a human
 * editor would (exact product first, then the kind of thing, then a broad mood shot), plus one
 * sentence describing the ideal shot, which CLIP uses to judge thumbnails. When every result for
 * a scene is a weak match, the agent is shown what came back and asked for different searches.
 */

export interface ScenePlan {
  /** 3-5 searches, most specific first. */
  queries: string[];
  /** What the ideal shot shows, in plain visual words (CLIP text). */
  visual: string;
}

const PlanSchema = z.object({
  scenes: z.array(
    z.object({
      id: z.number().int(),
      visual: z.string(),
      queries: z.array(z.string()).min(1).max(6),
    }),
  ),
});

const SYSTEM = `You are the footage researcher for a faceless YouTube video. For each scene of narration you choose what the viewer should SEE, and write the searches an editor would type into stock-footage sites (Pixabay, Pexels, Wikimedia Commons) to find it.

For every scene return:
- visual: one sentence (max 20 words) describing the ideal shot in concrete visual terms: objects, action, setting, framing. No brand claims, no abstract ideas.
- queries: 4 searches of 2-5 words each, ordered from most specific to broadest:
  1. the exact subject (for a product scene: brand + model, e.g. "Ruger Security-9 pistol");
  2. the kind of thing doing something visible (e.g. "compact 9mm pistol shooting range");
  3. a related close-up or detail shot (e.g. "handgun magazine loading close up");
  4. a broad, safe mood shot for the topic that stock sites surely have (e.g. "shooting range target practice").

Rules:
- Search for things a camera can film. "Reliability" or "great value" are not searchable; show the object being used instead.
- Stock sites match literal words: use common nouns, no punctuation, no prices, no years, no "best".
- Stay on topic for the whole video: a scene about price in a gun review shows the gun or a gun store, never generic money or food.
- Never write searches containing these blocked words: {BLOCKED}.
- Return every scene id you were given, in the same order.`;

const BROADEN = `Some scenes got only poor footage. For each scene you get the narration, the searches already tried, and the titles of what those searches returned. Write 4 NEW searches (2-5 words, common nouns) that stock sites are more likely to have and that still fit the scene and the video's topic. Go broader or pick a different visible subject; do not repeat a tried search. Also return an updated "visual" sentence. Never use these blocked words: {BLOCKED}.`;

const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

export const agentEnabled = () => hasKey("ANTHROPIC_API_KEY") && env("FOOTAGE_AGENT", "on").toLowerCase() !== "off";
export const agentModel = () => env("LLM_MODEL", "claude-haiku-4-5");

function client(): Anthropic {
  return new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
}

async function ask(
  system: string,
  payload: unknown,
  log: (m: string) => void,
  usage: { in: number; out: number },
): Promise<z.infer<typeof PlanSchema> | null> {
  const model = agentModel();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await client().messages.parse({
        model,
        max_tokens: 16000,
        // Haiku 4.5 rejects the effort setting; newer models use it to keep thinking (and cost) low.
        output_config: model.startsWith("claude-haiku")
          ? { format: zodOutputFormat(PlanSchema) }
          : { effort: "low", format: zodOutputFormat(PlanSchema) },
        system,
        messages: [{ role: "user", content: JSON.stringify(payload) }],
      });
      usage.in += res.usage.input_tokens;
      usage.out += res.usage.output_tokens;
      if (res.stop_reason === "refusal") return null;
      if (res.parsed_output) return res.parsed_output;
      log(`[agent] unreadable answer; retrying`);
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        log(`[agent] ANTHROPIC_API_KEY rejected; footage agent off for this run`);
        return null;
      }
      if (err instanceof Anthropic.APIError) log(`[agent] API error ${err.status}: ${err.message}`);
      else throw err;
    }
  }
  return null;
}

const clean = (q: string) => q.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim().toLowerCase();

function sanitize(niche: Niche, queries: string[]): string[] {
  const blocked = niche.stock.blockedTerms.map((b) => b.toLowerCase());
  const out = queries.map(clean).filter((q) => q && q.split(" ").length <= 7 && !blocked.some((b) => q.includes(b)));
  return [...new Set(out)];
}

/** Per-scene plans for every non-graphic scene; cached in the project so re-runs cost nothing. */
export async function planFootage(
  scenes: Scene[],
  sectionLabel: (s: Scene) => string,
  niche: Niche,
  cacheFile: string,
  log: (m: string) => void,
): Promise<Map<number, ScenePlan> | null> {
  if (!agentEnabled()) return null;
  const model = agentModel();
  const cache: Record<string, ScenePlan> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  const keyOf = (s: Scene) => hash(`${model}|${niche.name}|${s.type}|${s.product_name ?? ""}|${sectionLabel(s)}|${s.text}`);
  const todo = scenes.filter((s) => s.type !== "graphic" && !cache[keyOf(s)]);
  const usage = { in: 0, out: 0 };
  const blocked = niche.stock.blockedTerms.join(", ");
  const system = `${SYSTEM.replace("{BLOCKED}", blocked)}\n\nVideo type (${niche.label}): ${niche.llmGuidance}`;

  for (let i = 0; i < todo.length; i += 40) {
    const batch = todo.slice(i, i + 40);
    log(`[agent] planning footage for scenes ${i + 1}-${i + batch.length} of ${todo.length} (${model})`);
    const payload = batch.map((s) => ({
      id: s.id,
      section: sectionLabel(s),
      ...(s.type === "product" && s.product_name ? { product: s.product_name } : {}),
      text: s.text,
    }));
    const res = await ask(system, payload, log, usage);
    if (!res) {
      if (!hasKey("ANTHROPIC_API_KEY")) return null;
      continue; // the rule-based queries stay for this batch
    }
    for (const r of res.scenes) {
      const s = batch.find((b) => b.id === r.id);
      const queries = s ? sanitize(niche, r.queries) : [];
      if (s && queries.length) cache[keyOf(s)] = { queries: queries.slice(0, 5), visual: r.visual.trim() };
    }
  }
  if (todo.length) {
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
    log(`[agent] ${usage.in} input / ${usage.out} output tokens`);
  }
  const out = new Map<number, ScenePlan>();
  for (const s of scenes) if (cache[keyOf(s)]) out.set(s.id, cache[keyOf(s)]);
  log(`[agent] footage plan ready for ${out.size}/${scenes.filter((s) => s.type !== "graphic").length} scenes`);
  return out;
}

export interface WeakScene {
  id: number;
  text: string;
  product?: string;
  tried: string[];
  /** Titles/tags of what the tried searches returned (so the agent sees e.g. "burger, food"). */
  found: string[];
}

/** Second round for scenes whose best clip is a poor match: new, broader searches. */
export async function broadenFootage(weak: WeakScene[], niche: Niche, log: (m: string) => void): Promise<Map<number, ScenePlan>> {
  const out = new Map<number, ScenePlan>();
  if (!agentEnabled() || !weak.length) return out;
  const usage = { in: 0, out: 0 };
  const system = `${BROADEN.replace("{BLOCKED}", niche.stock.blockedTerms.join(", "))}\n\nVideo type (${niche.label}): ${niche.llmGuidance}`;
  for (let i = 0; i < weak.length; i += 30) {
    const batch = weak.slice(i, i + 30);
    log(`[agent] re-searching ${batch.length} weak scene(s) with broader queries`);
    const res = await ask(system, batch.map((w) => ({ ...w, found: w.found.slice(0, 6).map((f) => f.slice(0, 80)) })), log, usage);
    for (const r of res?.scenes ?? []) {
      const w = batch.find((b) => b.id === r.id);
      if (!w) continue;
      const tried = new Set(w.tried.map(clean));
      const queries = sanitize(niche, r.queries).filter((q) => !tried.has(q));
      if (queries.length) out.set(r.id, { queries: queries.slice(0, 4), visual: r.visual.trim() });
    }
  }
  if (weak.length) log(`[agent] broaden round: ${usage.in} input / ${usage.out} output tokens`);
  return out;
}
