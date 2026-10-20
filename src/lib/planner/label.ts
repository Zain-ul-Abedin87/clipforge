import Anthropic from "@anthropic-ai/sdk";
import { cleanProductName } from "../productNames.js";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env, hasKey } from "../env.js";
import { GRAPHIC_KINDS, Graphic, Scene, SCENE_TYPES, Section, SceneType } from "../scenes.js";
import type { Span } from "./structure.js";
import { Niche, nicheHints } from "../niche.js";
import { activeProvider, batchSize, isTooBig, llm, llmAvailable } from "../agents/llm/llm.js";
import { LlmCache } from "../llmCache.js";

const STOP = new Set(
  "the a an and or but if then this that these those it its is are was were be been being of to in on for with as at by from up out over into about than very really just also can will would could should has have had do does did not no so too our your their they them we you he she his her my me i one some any all more most such only own same other which who whom what when where why how there here".split(" "),
);

function keywords(text: string, n = 3): string[] {
  const counts = new Map<string, number>();
  for (const w of text.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    if (!STOP.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([w]) => w);
}

const FEATURE_RE =
  /\b(?:with|has|have|offers?|features?|comes with|because of|strength is|appreciate|noticed during testing was)\s+((?:a|an|the|its)\s+)?([a-z][\w-]*(?:\s+(?!and\b|but\b|which\b|that\b)[a-z][\w-]*){0,3})/gi;
const CON_RE = /\b(downside|complaint|wish(?:es)? it had|hard to find|drawback|not perfect|issue)\b/i;

/** Short feature phrases the narration actually says ("low recoil", "a crisp trigger"). */
function featuresIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(FEATURE_RE)) {
    let phrase = m[2].replace(/\b(out of the box|right now|every time)\b.*$/i, "").trim();
    // Cut at a preposition/article tail: "serious value for the" -> "serious value".
    phrase = phrase.replace(/\s+\b(for|the|a|an|of|to|with|and|in|on|at|that|which|it|is)\b.*$/i, "").trim();
    if (phrase.split(/\s+/).length >= 2 && !out.includes(phrase)) out.push(phrase);
  }
  return out.slice(0, 4).map((p) => p.charAt(0).toUpperCase() + p.slice(1));
}

function priceIn(text: string): string | undefined {
  const m = text.match(/\$\s?(\d[\d,]*)/) ?? text.match(/\b(\d{2,5})\s+dollars\b/i);
  return m ? `$${m[1]}` : undefined;
}

/**
 * Deterministic labels: always available, also the fallback when the LLM is off or fails.
 * The niche rule set supplies the stock hint table and the per-item graphic limits.
 */
export function heuristicLabels(spans: Span[], sections: Section[], niche: Niche): Scene[] {
  const hints = nicheHints(niche);
  // Only category hints (pistol/shotgun/rifle) may come from the section's context, never e.g. "money".
  const sectionHints = hints.slice(0, niche.stock.sectionHintCount ?? 0);
  const rules = niche.structure;
  const priceCount = new Map<number, number>();
  const consCount = new Map<number, number>();
  // k = position inside a product section (k=0 is the title card): product right after the title,
  // then B-roll video, product again every third scene, a card now and then.
  const rotation: SceneType[] = ["stock", "product", "stock", "stock", "product", "graphic"];
  const seenInSection = new Map<number, number>();
  const sectionText = (secId: number) => spans.filter((s) => s.section === secId).map((s) => s.text).join(" ");
  return spans.map((sp, id) => {
    const sec = sections[sp.section];
    const k = seenInSection.get(sec.id) ?? 0;
    seenInSection.set(sec.id, k + 1);
    const product = sec.product_name;
    // A niche hint ("hunter in autumn forest") reads best; otherwise search the scene's own words.
    const own = keywords(sp.text, 2).join(" ");
    const hintFor = (text: string) => hints.find(([re]) => re.test(text))?.[1];
    // Niches with a hint table never fall back to raw narration words ("users wish" finds junk):
    // try the whole section's context, then the niche's default B-roll.
    const stockQ = hints.length
      ? hintFor(sp.text) ??
        // Category context only inside a product section; a whole-video "body" section would let one
        // stray word ("a trap") decide every scene.
        (sec.kind === "item" ? sectionHints.find(([re]) => re.test(sectionText(sec.id)))?.[1] : undefined) ??
        niche.stock.fallbackQuery
      : own || niche.stock.fallbackQuery;
    const base = { id, start: sp.start, end: sp.end, text: sp.text, section: sec.id, labeledBy: "heuristic" as const };

    if (sec.kind === "item" && k === 0 && rules.titleCardPerItem) {
      const graphic: Graphic = { kind: "title_card", title: product ?? `Number ${sec.rank}`, lines: [], rank: sec.rank };
      return { ...base, type: "graphic", queries: product ? [product] : [], product_name: product, graphic };
    }
    // The intro opens on footage, never a full-scene "Top Picks" card (sections[0].hookEnd marks the hook).
    // The outro shows what its lines talk about (pacing.ts), never a full-scene "See you next time" card.
    if (sec.kind === "item" && product) {
      const price = priceIn(sp.text);
      // One price badge per product is enough; repeated prices read as spam.
      if (price && (priceCount.get(sec.id) ?? 0) < rules.maxPriceBadgesPerItem) {
        priceCount.set(sec.id, (priceCount.get(sec.id) ?? 0) + 1);
        return { ...base, type: "graphic", queries: [product], product_name: product, graphic: { kind: "price_badge", title: product, lines: [], price } };
      }
      if (CON_RE.test(sp.text) && (consCount.get(sec.id) ?? 0) < rules.maxProsConsPerItem) {
        consCount.set(sec.id, (consCount.get(sec.id) ?? 0) + 1);
        const pros = featuresIn(sectionText(sec.id)).slice(0, 2).map((f) => `+ ${f}`);
        const con = sp.text.split(/(?<=[.!?])\s+/).find((s) => CON_RE.test(s)) ?? "";
        const wish = con.match(/wish(?:es)? it had\s+(?:a |an )?([^,.;]+)/i);
        const conText = wish
          ? `No ${wish[1]}`
          : con.replace(/^.*?\b(?:downside|complaint|drawback|issue)\s+is(?:\s+that)?\s+(?:it\s+)?/i, "").split(/,\s*but\b|[.;]/)[0];
        const short = conText.trim().split(/\s+/).slice(0, 8).join(" ");
        const conLine = `- ${short.charAt(0).toUpperCase()}${short.slice(1)}`;
        return { ...base, type: "graphic", queries: [product], product_name: product, graphic: { kind: "pros_cons", title: product, lines: [...pros, conLine] } };
      }
      const t = rotation[k % rotation.length];
      const feats = featuresIn(sp.text);
      // Only show a spec card when the narration names real features; otherwise show the product.
      if (t === "graphic" && feats.length) {
        return { ...base, type: "graphic", queries: [product], product_name: product, graphic: { kind: "spec_card", title: product, lines: feats } };
      }
      if (t === "graphic") return { ...base, type: "product", queries: [product], product_name: product };
      if (t === "product") return { ...base, type: "product", queries: [product, `${product} ${keywords(sp.text, 1)[0] ?? ""}`.trim()], product_name: product };
    }
    const extra = hints.length ? [niche.stock.fallbackQuery] : [own, ...keywords(sp.text, 1)];
    return { ...base, type: "stock", queries: [...new Set([stockQ, ...extra].filter(Boolean))] };
  });
}

// ---------- LLM labelling ----------

const LabelSchema = z.object({
  scenes: z.array(
    z.object({
      id: z.number().int(),
      type: z.enum(SCENE_TYPES),
      product_name: z.string().nullable(),
      queries: z.array(z.string()),
      graphic_kind: z.enum([...GRAPHIC_KINDS, "none"]),
      graphic_title: z.string(),
      graphic_lines: z.array(z.string()),
      price: z.string().nullable(),
    }),
  ),
});
type Labels = z.infer<typeof LabelSchema>;
type Label = Labels["scenes"][number];

/**
 * What a small local model is held to: right shape, any strings. Its answers are then normalized
 * (unknown type / graphic kind -> closest valid one) and merged by id, so one bad scene no longer
 * throws away the whole batch.
 */
const LooseLabelSchema = z.object({
  scenes: z.array(
    z.object({
      id: z.coerce.number().int(),
      type: z.string().nullish(),
      product_name: z.string().nullish(),
      queries: z.array(z.string()).nullish(),
      graphic_kind: z.string().nullish(),
      graphic_title: z.string().nullish(),
      graphic_lines: z.array(z.string()).nullish(),
      price: z.union([z.string(), z.number()]).nullish(),
    }),
  ),
});
type LooseLabel = z.infer<typeof LooseLabelSchema>["scenes"][number];

export function normalizeLabel(l: LooseLabel): Label {
  const kinds = [...GRAPHIC_KINDS, "none"] as readonly string[];
  let graphic_kind = (kinds.includes(String(l.graphic_kind)) ? l.graphic_kind : "none") as Label["graphic_kind"];
  let type = (SCENE_TYPES as readonly string[]).includes(String(l.type)) ? (l.type as SceneType) : null;
  // "intro_card" written as the type, etc.
  if (!type && kinds.includes(String(l.type)) && l.type !== "none") (type = "graphic"), (graphic_kind = l.type as Label["graphic_kind"]);
  if (!type) type = graphic_kind !== "none" ? "graphic" : l.product_name ? "product" : "stock";
  if (type !== "graphic") graphic_kind = "none";
  if (type === "graphic" && graphic_kind === "none") type = l.product_name ? "product" : "stock";
  return {
    id: l.id,
    type,
    product_name: cleanProductName(l.product_name),
    queries: (l.queries ?? []).filter((q) => typeof q === "string" && q.trim()).slice(0, 3),
    graphic_kind,
    graphic_title: type === "graphic" ? (l.graphic_title ?? "") : "",
    graphic_lines: type === "graphic" ? (l.graphic_lines ?? []) : [],
    price: l.price === null || l.price === undefined || l.price === "" ? null : String(l.price),
  };
}

const SYSTEM = `You label scenes for a faceless YouTube video (often "Top 5 / Top 10" listicles). The scene boundaries are fixed; you only choose how each scene is visualized. The channel's niche rules follow at the end.

For every scene return:
- type: "product" (official product photo/video of the named product), "stock" (generic landscape stock footage), "graphic" (a code-generated card), or "image" (a still illustration).
- product_name: the product the scene is about, exactly as written in the input, or null.
- queries: 1-3 short search phrases. For "stock" scenes these are generic visual phrases that a stock site like Pexels can match (e.g. "hunter walking in autumn forest"), never brand or model names. For "product" scenes, the first query is the product name.
- graphic_kind / graphic_title / graphic_lines / price: only for "graphic" scenes, otherwise "none", "", [] and null.
  - title_card: the first scene of each ranked item (title = product name).
  - price_badge: when the narration states a price.
  - spec_card: key specs or features as 2-4 short lines (max 5 words each).
  - pros_cons: lines prefixed "+ " or "- ".
  - Never use intro_card or end_card: the intro and the outro must show footage that matches their lines.

Rules: keep graphics to roughly a quarter of the scenes; never use the same type more than 3 times in a row; prefer "product" while an item is being described; only describe what the narration says, never invent specs or prices. Return exactly one entry per input scene id, in order.`;

function toScene(sp: Span, id: number, l: Labels["scenes"][number]): Scene {
  const scene: Scene = {
    id,
    start: sp.start,
    end: sp.end,
    text: sp.text,
    section: sp.section,
    type: l.type,
    queries: l.queries.map((q) => q.trim()).filter(Boolean).slice(0, 3),
    labeledBy: "llm",
  };
  if (l.product_name) scene.product_name = l.product_name;
  if (l.type === "graphic" && l.graphic_kind !== "none") {
    scene.graphic = { kind: l.graphic_kind, title: l.graphic_title, lines: l.graphic_lines.slice(0, 5) };
    if (l.price) scene.graphic.price = l.price;
  }
  return scene;
}

/** One section's LLM labels, in span order (cached by the section's text; ids are positions). */
export type SectionLabels = Labels["scenes"];

/**
 * Labels scenes with Claude in section-sized batches. Returns null when no key is configured.
 * With a cache, a section whose kind, product and scene texts are unchanged reuses its earlier
 * labels and is not sent again; only edited sections cost tokens (and only they can change).
 */
export async function llmLabels(
  spans: Span[],
  sections: Section[],
  log: (msg: string) => void,
  niche: Niche,
  cache?: LlmCache<SectionLabels>,
): Promise<{ scenes: Scene[]; inputTokens: number; outputTokens: number; cachedSections: number } | null> {
  if (!llmAvailable()) return null;
  const client = llm();
  const model = env("LLM_MODEL", "claude-opus-5-5");
  const system = `${SYSTEM}

Niche rules (${niche.label}): ${niche.llmGuidance}`;
  const sectionOf = (i: number) => {
    const sec = sections[spans[i].section];
    return sec.kind === "item" ? `item #${sec.rank}${sec.product_name ? ` (${sec.product_name})` : ""}` : sec.kind;
  };
  const seconds = (i: number) => Math.round(spans[i].end - spans[i].start);

  // Span indices per section, and each section's cache key (model, prompt, what the LLM is shown).
  const members = new Map<number, number[]>();
  spans.forEach((sp, i) => members.set(sp.section, [...(members.get(sp.section) ?? []), i]));
  // The provider is part of the key: Claude and a local Qwen label the same text differently.
  const keyOf = (ids: number[]) => LlmCache.key({ v: 1, provider: activeProvider(), model, system, section: sectionOf(ids[0]), spans: ids.map((i) => [spans[i].text, seconds(i)]) });
  const done = new Map<number, Scene>();
  let cachedSections = 0;
  for (const ids of members.values()) {
    const hit = cache?.get(keyOf(ids));
    if (!hit || hit.length !== ids.length) continue;
    ids.forEach((i, k) => done.set(i, toScene(spans[i], i, { ...hit[k], id: i })));
    cachedSections++;
  }
  const todo = spans.map((_, i) => i).filter((i) => !done.has(i));
  if (cache) log(`[plan] labels: ${cachedSections}/${members.size} section(s) unchanged (cached), ${todo.length} scene(s) to label`);

  // Batch whole sections together, ~60 scenes per request (fewer for a local model).
  const size = batchSize(60);
  const local = activeProvider() === "qwen";
  const batches: number[][] = [];
  let cur: number[] = [];
  for (const [n, i] of todo.entries()) {
    const newSection = n > 0 && spans[i].section !== spans[todo[n - 1]].section;
    if (cur.length >= size || (newSection && cur.length >= Math.round(size * 0.67))) {
      batches.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length) batches.push(cur);

  /** LLM answers by span index (only these are cached; heuristic fallbacks are not). */
  const fromLlm = new Map<number, Label>();
  let inputTokens = 0;
  let outputTokens = 0;
  for (const [b, ids] of batches.entries()) {
    const payload = ids.map((i) => ({ id: i, section: sectionOf(i), seconds: seconds(i), text: spans[i].text }));

    let labels: Map<number, Label> | null = null;
    let split = false;
    for (let attempt = 1; attempt <= 2 && !labels && !split; attempt++) {
      log(`[plan] LLM batch ${b + 1}/${batches.length} (${ids.length} scenes), attempt ${attempt}`);
      try {
        const res = await client.messages.parse({
          model,
          max_tokens: 16000,
          // Haiku 4.5 rejects the effort setting; newer models use it to keep thinking (and cost) low.
          output_config: local
            ? { format: zodOutputFormat(LooseLabelSchema) }
            : model.startsWith("claude-haiku")
              ? { format: zodOutputFormat(LabelSchema) }
              : { effort: "low", format: zodOutputFormat(LabelSchema) },
          system,
          messages: [{ role: "user", content: JSON.stringify(payload) }],
        });
        inputTokens += res.usage.input_tokens;
        outputTokens += res.usage.output_tokens;
        if (res.stop_reason === "refusal") {
          log(`[plan] LLM declined this batch; using heuristic labels for it`);
          break;
        }
        const parsed = res.parsed_output as { scenes: LooseLabel[] } | null;
        const got = parsed?.scenes.map((s) => s.id).join(",");
        if (parsed && got === ids.join(",")) labels = new Map(parsed.scenes.map((l) => [l.id, local ? normalizeLabel(l) : (l as Label)]));
        else if (parsed && local) {
          // A local model skips or repeats scenes: keep the ones it got right, rules fill the rest.
          const byId = new Map(parsed.scenes.filter((l) => ids.includes(l.id)).map((l) => [l.id, normalizeLabel(l)]));
          if (byId.size >= Math.ceil(ids.length / 2)) {
            labels = byId;
            if (byId.size < ids.length) log(`[plan] LLM labelled ${byId.size}/${ids.length} scenes; rules fill the other ${ids.length - byId.size}`);
          } else log(`[plan] LLM returned wrong scene ids; retrying`);
        } else log(`[plan] LLM returned wrong scene ids; retrying`);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) {
          log(`[plan] ANTHROPIC_API_KEY rejected; falling back to heuristic labels`);
          return null;
        }
        if (isTooBig(err) && ids.length > 1) {
          // Too big for the local model's context (or garbage back): two smaller batches, later in this loop.
          const mid = Math.ceil(ids.length / 2);
          batches.push(ids.slice(0, mid), ids.slice(mid));
          log(`[plan] batch of ${ids.length} scenes too big for the model (${err instanceof Error ? err.message.slice(0, 100) : ""}); retrying as ${mid} + ${ids.length - mid}`);
          split = true;
        } else if (err instanceof Anthropic.APIError) log(`[plan] API error ${err.status}: ${err.message}`);
        else throw err;
      }
    }
    if (split) continue;

    if (labels) {
      const fill = labels.size < ids.length ? heuristicLabels(spans, sections, niche) : [];
      for (const i of ids) {
        const l = labels.get(i);
        if (l) fromLlm.set(i, l);
        done.set(i, l ? toScene(spans[i], i, l) : fill.find((s) => s.id === i)!);
      }
    } else for (const s of heuristicLabels(spans, sections, niche).filter((s) => ids.includes(s.id))) done.set(s.id, s);
  }
  // Cache every section the LLM labelled completely (a section split over two batches counts too).
  if (cache) for (const ids of members.values()) if (ids.every((i) => fromLlm.has(i))) cache.set(keyOf(ids), ids.map((i) => fromLlm.get(i)!));
  return { scenes: spans.map((_, i) => done.get(i)!), inputTokens, outputTokens, cachedSections };
}
