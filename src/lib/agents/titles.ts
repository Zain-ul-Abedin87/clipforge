import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { bannedIn, briefPrompt, ChannelBrief } from "../channelBrief.js";
import { env } from "../env.js";
import { llm, llmAvailable } from "./llm/llm.js";
import { withStage } from "../models/loader.js";
import { embed } from "../models/embed.js";
import { closest, SimilarityHit } from "../originality/similarity.js";
import { analyzeTitles, templatesFor, TitleStyle } from "../research/title-patterns.js";
import type { NewsItem } from "../research/news.js";
import { loadFeatures } from "../settings/features.js";

/**
 * Title agent: N (default 10) original title options for a topic.
 *  1. Competitor titles (outliers of the last research scan + a topic search when a YouTube key is
 *     set) give the winning STRUCTURES (title-patterns.ts), never the wording.
 *  2. The local model (stage "titles", qwen3:8b) writes candidates; Google News headlines are
 *     offered as fresh angles.
 *  3. Originality guard: each title's closest competitor title (word 2-gram Jaccard, word cosine,
 *     embedding cosine with nomic-embed-text). Above maxSimilarity (0.8) it is rewritten (2 rounds),
 *     then dropped. Rule-based titles from the templates fill any gap, so there are always N.
 */

export interface TitleOption {
  title: string;
  pattern: string;
  hook?: string;
  similarity: SimilarityHit;
  source: "llm" | "rewrite" | "template";
}

export interface TitleResult {
  topic: string;
  titles: TitleOption[];
  style: TitleStyle;
  competitors: number;
  rejected: { title: string; similarity: number; against: string }[];
  news: NewsItem[];
}

const Schema = z.object({ titles: z.array(z.object({ title: z.string(), pattern: z.string(), hook: z.string().optional() })) });

const SYSTEM = `You write YouTube titles for a faceless channel. Rules:
- Write NEW titles. Never copy or lightly edit a competitor title; their titles are shown only so you can avoid them.
- Use the given structures (templates) for the shape, but your own words, angle and specifics.
- Max {MAX} characters. Plain English, no clickbait lies, no emojis, at most one ALL-CAPS word.
- Vary the structures: no more than 2 titles with the same structure.
- "pattern": the template you used. "hook": the news angle you used, if any.`;

/** Rule-based fallback titles from the templates (no model needed). */
export function templateTitles(topic: string, templates: string[], n: number, year = new Date().getFullYear()): { title: string; pattern: string }[] {
  // "best budget 9mm pistols" -> "Budget 9mm Pistols" (the templates add their own "Best" / "Top").
  const X = topic.replace(/^\s*(the\s+)?(best|top(\s+\d+)?)\s+/i, "").replace(/\b\w/g, (c) => c.toUpperCase());
  const fill = (t: string, k: number) =>
    t
      .replace("{N}", String([7, 10, 5, 9, 8, 6][k % 6]))
      .replace("{YEAR}", String(year))
      .replace("{X}", X)
      .replace("{Y}", "the Competition")
      .replace("{RESULT}", "One Clear Winner")
      .replace("{PRICE}", "500");
  const out: { title: string; pattern: string }[] = [];
  for (let k = 0; out.length < n && k < n * 3; k++) {
    const t = templates[k % templates.length];
    const title = fill(t, Math.floor(k / templates.length) + k);
    if (!out.some((o) => o.title === title)) out.push({ title, pattern: t });
  }
  return out;
}

export async function generateTitles(
  topic: string,
  competitors: { title: string; views?: number }[],
  o: { news?: NewsItem[]; log?: (m: string) => void; count?: number; maxSimilarity?: number; useEmbeddings?: boolean; brief?: ChannelBrief | null } = {},
): Promise<TitleResult> {
  const cfg = loadFeatures().titles;
  const log = o.log ?? (() => {});
  const n = o.count ?? cfg.count;
  const maxSim = o.maxSimilarity ?? cfg.maxSimilarity;
  const style = analyzeTitles(competitors);
  const templates = templatesFor(style, 8);
  const compTitles = competitors.map((c) => c.title);
  const compVecs = o.useEmbeddings !== false && compTitles.length ? await embed(compTitles, log) : null;
  const rejected: TitleResult["rejected"] = [];

  const check = async (titles: string[]): Promise<SimilarityHit[]> => {
    const vecs = compVecs ? await embed(titles, log) : null;
    return titles.map((t, i) => closest(t, compTitles, { n: 2, vec: vecs?.[i] ?? null, vecs: compVecs ?? undefined }));
  };

  const ask = async (prompt: string): Promise<z.infer<typeof Schema>["titles"]> => {
    if (!llmAvailable()) return [];
    try {
      const res = await withStage("titles", () =>
        llm().messages.parse({
          model: env("LLM_MODEL", "claude-haiku-4-5"),
          max_tokens: 2000,
          output_config: { format: zodOutputFormat(Schema) },
          system: SYSTEM.replace("{MAX}", String(cfg.maxLength)),
          messages: [{ role: "user", content: prompt }],
        }),
      );
      return res.parsed_output?.titles ?? [];
    } catch (err) {
      log(`[titles] model failed (${String((err as Error).message).slice(0, 140)}); template titles fill in`);
      return [];
    }
  };

  const avoid = compTitles.slice(0, 25).map((t) => `- ${t}`).join("\n");
  const hooks = (o.news ?? []).slice(0, 6).map((h) => `- ${h.title}`).join("\n");
  const voice = briefPrompt(o.brief);
  const base = `${voice ? `${voice}\n\n` : ""}Topic: ${topic}\nWrite ${n + 4} title options.\nStructures that work in this niche (best first):\n${templates.map((t) => `- ${t}`).join("\n")}\nTypical length: ~${style.avgLength || 55} characters; ${Math.round(style.numberShare * 100)}% use a number, ${Math.round(style.yearShare * 100)}% a year.${hooks ? `\nRecent news you MAY use as an angle (do not copy headlines):\n${hooks}` : ""}${avoid ? `\nCompetitor titles (do NOT reuse their wording):\n${avoid}` : ""}`;

  const accepted: TitleOption[] = [];
  const seen = new Set<string>();
  const take = async (cands: { title: string; pattern: string; hook?: string }[], source: TitleOption["source"]) => {
    const clean = cands.map((c) => ({ ...c, title: c.title.trim().replace(/^["']|["']$/g, "").slice(0, cfg.maxLength + 20) })).filter((c) => c.title && !seen.has(c.title.toLowerCase()) && !bannedIn(c.title, o.brief).length);
    const sims = await check(clean.map((c) => c.title));
    const tooClose: typeof clean = [];
    clean.forEach((c, i) => {
      seen.add(c.title.toLowerCase());
      if (sims[i].score > maxSim) {
        rejected.push({ title: c.title, similarity: sims[i].score, against: sims[i].against });
        tooClose.push(c);
      } else if (c.title.length <= cfg.maxLength + 10 && accepted.length < n) accepted.push({ ...c, similarity: sims[i], source });
    });
    return tooClose;
  };

  let close = await take(await ask(base), "llm");
  for (let round = 1; round <= 2 && close.length && accepted.length < n; round++) {
    log(`[titles] ${close.length} title(s) too close to a competitor (> ${Math.round(maxSim * 100)}%); rewrite round ${round}`);
    const prompt = `${base}\n\nThese drafts are too close to competitor titles. Rewrite each with a different angle and different words:\n${close.map((c) => `- ${c.title}`).join("\n")}`;
    close = await take(await ask(prompt), "rewrite");
  }
  if (accepted.length < n) {
    const fill = templateTitles(topic, templates, n * 2);
    await take(fill, "template");
    log(`[titles] ${accepted.length}/${n} after template fill`);
  }
  const titles = accepted.slice(0, n);
  log(`[titles] ${titles.length} title(s) for "${topic}", max similarity ${Math.max(0, ...titles.map((t) => t.similarity.score)).toFixed(2)} vs ${compTitles.length} competitor title(s), ${rejected.length} rejected`);
  return { topic, titles, style, competitors: compTitles.length, rejected, news: o.news ?? [] };
}
