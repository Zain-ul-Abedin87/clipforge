import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env, hasKey } from "../env.js";
import { GRAPHIC_KINDS, Graphic, Scene, SCENE_TYPES, Section, SceneType } from "../scenes.js";
import type { Span } from "./structure.js";
import { Niche, nicheHints } from "../niche.js";

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
    if (sec.kind === "intro" && k === 0) {
      return { ...base, type: "graphic", queries: [stockQ], graphic: { kind: "intro_card", title: "Top Picks", lines: [] } };
    }
    if (sec.kind === "outro" && id === spans.length - 1) {
      return { ...base, type: "graphic", queries: [stockQ], graphic: { kind: "end_card", title: "Thanks for watching", lines: [] } };
    }
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
  - intro_card / end_card: first scene of the intro / last scene of the video.

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

/** Labels scenes with Claude in section-sized batches. Returns null when no key is configured. */
export async function llmLabels(
  spans: Span[],
  sections: Section[],
  log: (msg: string) => void,
  niche: Niche,
): Promise<{ scenes: Scene[]; inputTokens: number; outputTokens: number } | null> {
  if (!hasKey("ANTHROPIC_API_KEY")) return null;
  const client = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
  const model = env("LLM_MODEL", "claude-opus-5-5");

  // Batch whole sections together, ~60 scenes per request.
  const batches: number[][] = [];
  let cur: number[] = [];
  for (let i = 0; i < spans.length; i++) {
    const newSection = i > 0 && spans[i].section !== spans[i - 1].section;
    if (cur.length >= 60 || (newSection && cur.length >= 40)) {
      batches.push(cur);
      cur = [];
    }
    cur.push(i);
  }
  if (cur.length) batches.push(cur);

  const out: Scene[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  for (const [b, ids] of batches.entries()) {
    const payload = ids.map((i) => {
      const sec = sections[spans[i].section];
      return {
        id: i,
        section: sec.kind === "item" ? `item #${sec.rank}${sec.product_name ? ` (${sec.product_name})` : ""}` : sec.kind,
        seconds: Math.round(spans[i].end - spans[i].start),
        text: spans[i].text,
      };
    });

    let labels: Labels | null = null;
    for (let attempt = 1; attempt <= 2 && !labels; attempt++) {
      log(`[plan] LLM batch ${b + 1}/${batches.length} (${ids.length} scenes), attempt ${attempt}`);
      try {
        const res = await client.messages.parse({
          model,
          max_tokens: 16000,
          // Haiku 4.5 rejects the effort setting; newer models use it to keep thinking (and cost) low.
          output_config: model.startsWith("claude-haiku")
            ? { format: zodOutputFormat(LabelSchema) }
            : { effort: "low", format: zodOutputFormat(LabelSchema) },
          system: `${SYSTEM}

Niche rules (${niche.label}): ${niche.llmGuidance}`,
          messages: [{ role: "user", content: JSON.stringify(payload) }],
        });
        inputTokens += res.usage.input_tokens;
        outputTokens += res.usage.output_tokens;
        if (res.stop_reason === "refusal") {
          log(`[plan] LLM declined this batch; using heuristic labels for it`);
          break;
        }
        const parsed = res.parsed_output;
        const got = parsed?.scenes.map((s) => s.id).join(",");
        if (parsed && got === ids.join(",")) labels = parsed;
        else log(`[plan] LLM returned wrong scene ids; retrying`);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) {
          log(`[plan] ANTHROPIC_API_KEY rejected; falling back to heuristic labels`);
          return null;
        }
        if (err instanceof Anthropic.APIError) log(`[plan] API error ${err.status}: ${err.message}`);
        else throw err;
      }
    }

    if (labels) ids.forEach((i, k) => out.push(toScene(spans[i], i, labels!.scenes[k])));
    else out.push(...heuristicLabels(spans, sections, niche).filter((s) => ids.includes(s.id)));
  }
  return { scenes: out, inputTokens, outputTokens };
}
