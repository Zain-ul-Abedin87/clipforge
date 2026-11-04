import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { bannedIn, briefPrompt, ChannelBrief } from "../channelBrief.js";
import { pastTitles } from "../channelHistory.js";
import { embed } from "../models/embed.js";
import { closest } from "../originality/similarity.js";
import { paths } from "../paths.js";
import { askJson } from "./llm/json.js";

/**
 * Idea multiplier: one outlier video -> why it worked (its triggers) -> 15 new ideas for OUR
 * channel, in our pillars and voice. Each idea has the trigger it uses, a format, a working title,
 * why it fits the brief, and how close it is to being a copy. Ideas whose title is more than 0.8
 * similar to one of our past titles or a competitor title are dropped (and listed as dropped).
 */

export const TRIGGERS = ["curiosity", "stakes", "controversy", "versus", "ranking", "nostalgia", "money", "danger", "myth", "transformation", "authority", "novelty"] as const;
export const IDEA_FORMATS = ["countdown", "versus", "myth-vs-reality", "history-of", "every-x-explained"] as const;
export type IdeaFormat = (typeof IDEA_FORMATS)[number];

export interface IdeaSource {
  videoId: string;
  title: string;
  views?: number;
  /** Views / the channel's median (outliers.ts). */
  multiple?: number;
  channelTitle?: string;
  transcript?: string;
  /** Extra angles (viewer questions / complaints from the comments, S6). */
  angles?: string[];
}

const Idea = z.object({
  idea: z.string().min(10).max(300),
  trigger: z.enum(TRIGGERS),
  format: z.enum(IDEA_FORMATS),
  workingTitle: z.string().min(8).max(100),
  whyFits: z.string().min(5).max(240),
  copyRisk: z.enum(["low", "med", "high"]),
});
export type Idea = z.infer<typeof Idea> & { similarity?: { score: number; against: string } };
const Answer = z.object({ why: z.object({ triggers: z.array(z.enum(TRIGGERS)).min(1).max(4), explanation: z.string().min(10).max(600) }), ideas: z.array(Idea).min(12).max(20) });

export interface IdeasResult {
  channel: string;
  source: Omit<IdeaSource, "transcript"> & { transcriptWords: number };
  why: { triggers: string[]; explanation: string };
  ideas: Idea[];
  dropped: { workingTitle: string; reason: string; score: number; against: string }[];
  writer: "model" | "rules";
  createdAt: string;
}

/** Triggers visible in a title (the rule fallback, and a hint for the model). */
export function titleTriggers(title: string): (typeof TRIGGERS)[number][] {
  const t: (typeof TRIGGERS)[number][] = [];
  if (/\bvs\.?\b|\bversus\b|\bor\b.*\?/i.test(title)) t.push("versus");
  if (/\b(top|best|worst|ranked|ranking)\b|^\s*\d+\s+\p{L}/iu.test(title)) t.push("ranking");
  if (/\$\d|\bcheap|price|budget|money|cost|worth\b/i.test(title)) t.push("money");
  if (/\b(deadly|danger|never|warning|avoid|mistake|fail)/i.test(title)) t.push("danger");
  if (/\b(history|vintage|classic|old|original|ww2|wwii|\d{4}s|legend)/i.test(title)) t.push("nostalgia");
  if (/\b(myth|truth|lie|really|actually|fake)\b/i.test(title)) t.push("myth");
  if (/\?|\bwhy\b|\bhow\b|\bwhat happened\b|\bsecret\b/i.test(title)) t.push("curiosity");
  if (/\b(banned|controvers|hate|nobody|everyone is wrong)/i.test(title)) t.push("controversy");
  return t.length ? [...new Set(t)] : ["curiosity"];
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const TEMPLATES: Record<IdeaFormat, (x: string) => string> = {
  countdown: (x) => `Best ${x} ranked for this year`,
  versus: (x) => `${cap(x)}: the old favourite vs the new challenger`,
  "myth-vs-reality": (x) => `${cap(x)}: what people get wrong`,
  "history-of": (x) => `The history of ${x}`,
  "every-x-explained": (x) => `Every type of ${x} explained`,
};

/** The subject of a title: the clause after "that / which / under / for..." and the list words dropped. */
export function titleSubject(title: string): string {
  return (
    title
      .replace(/\b(that|which|who|under|for|with|you|nobody|everyone)\b.*$/i, "")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .replace(/\b(\d+|top|best|worst|the|a|an|of|in|to|why|how|what|is|are|this|vs|ever|every|i|we|my)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim() || "gear"
  );
}

/**
 * Rule ideas (no model): the outlier's subject plus the brief's pillars that are real subjects,
 * times the formats. Fewer ideas than the model gives (never padded with copies).
 */
export function ruleIdeas(src: IdeaSource, brief: ChannelBrief | null): z.infer<typeof Answer> {
  const triggers = titleTriggers(src.title);
  // Pillars that name a format ("Best X under a price, ranked", "Every type of X explained") are not subjects.
  const realPillars = (brief?.pillars ?? []).filter((p) => !/\bX\b|\bvs\b|versus|ranked|explained|myth|every type|head to head|the story behind|history/i.test(p)).map((p) => p.replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim());
  const subjects = [titleSubject(src.title), ...realPillars].filter((x, i, a) => x && a.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i).slice(0, 5);
  const ideas: z.infer<typeof Idea>[] = [];
  outer: for (const f of IDEA_FORMATS)
    for (const s of subjects) {
      // Pillars are written like titles ("Budget survival knives"): lower-case inside a sentence.
      const subject = s.split(" ").slice(0, 6).map((w) => (/^[A-Z][a-z]+$/.test(w) ? w.toLowerCase() : w)).join(" ");
      const trigger = triggers[ideas.length % triggers.length];
      ideas.push({ idea: `A ${f.replace(/-/g, " ")} video on ${subject}, using the ${trigger} pull that made "${src.title.slice(0, 60)}" work.`, trigger, format: f, workingTitle: TEMPLATES[f](subject).slice(0, 100), whyFits: s === subjects[0] ? "Same subject as the outlier, in another format" : `Fits the pillar "${s.slice(0, 80)}"`, copyRisk: s === subjects[0] && f === "countdown" ? "high" : s === subjects[0] ? "med" : "low" });
      if (ideas.length >= 15) break outer;
    }
  return { why: { triggers, explanation: `Rules only (no model): the title shows ${triggers.join(", ")}.` }, ideas };
}

/** The transcript as a few excerpts that fit the prompt: the opening (hook) plus 3 spread samples. */
export function transcriptExcerpt(t: string | undefined, maxWords = 800): string {
  if (!t) return "";
  const w = t.split(/\s+/).filter(Boolean);
  if (w.length <= maxWords) return w.join(" ");
  const open = w.slice(0, Math.round(maxWords * 0.5)).join(" ");
  const each = Math.round((maxWords * 0.5) / 3);
  const parts = [0.35, 0.6, 0.85].map((p) => w.slice(Math.round(w.length * p), Math.round(w.length * p) + each).join(" "));
  return `${open}\n[...]\n${parts.join("\n[...]\n")}`;
}

export async function multiplyIdeas(src: IdeaSource, o: { channel: string; brief?: ChannelBrief | null; competitorTitles?: string[]; log?: (m: string) => void; useEmbeddings?: boolean; maxSimilarity?: number; save?: boolean } = { channel: "default" }): Promise<IdeasResult> {
  const log = o.log ?? (() => {});
  const brief = o.brief ?? null;
  const maxSim = o.maxSimilarity ?? 0.8;
  const excerpt = transcriptExcerpt(src.transcript);
  const r = await askJson({
    stage: "titles",
    schema: Answer,
    label: "ideas",
    log,
    maxTokens: 3000,
    system: `You are a YouTube strategist. First find WHY the given video went viral: which triggers it pulls (${TRIGGERS.join(", ")}) and how. Then give 15 NEW video ideas for OUR channel that use the same triggers on our own subjects. Each idea: idea (one or two sentences), trigger, format (${IDEA_FORMATS.join(", ")}), workingTitle (max 70 characters, our own wording, never the original title's wording), whyFits (why it fits our channel), copyRisk (low / med / high: how close it is to just remaking the original video).
Ideas must be different from each other and from the original video. No invented facts or numbers in titles.${brief ? `\n${briefPrompt(brief)}` : ""}`,
    user: `The video: "${src.title}"${src.multiple ? `, ${src.multiple.toFixed(1)}x its channel's usual views` : ""}${src.views ? `, ${src.views.toLocaleString("en-US")} views` : ""}${src.channelTitle ? ` (channel: ${src.channelTitle})` : ""}.${excerpt ? `\nTranscript excerpts (the opening first):\n${excerpt}` : "\n(No transcript: judge from the title.)"}${src.angles?.length ? `\nViewers' questions and complaints in its comments (good angles):\n${src.angles.slice(0, 12).map((a) => `- ${a}`).join("\n")}` : ""}`,
    validate: (v) => {
      const banned = v.ideas.find((i) => bannedIn(i.workingTitle, brief).length);
      if (banned) return `"${banned.workingTitle}" uses a phrase this channel never uses`;
      const same = v.ideas.find((i) => i.workingTitle.trim().toLowerCase() === src.title.trim().toLowerCase());
      return same ? "an idea repeats the original title: write our own" : null;
    },
    fallback: () => ruleIdeas(src, brief),
  });
  // Dedupe: our own past titles, competitor titles (incl. the source), and each other.
  const ours = pastTitles(o.channel);
  const theirs = [src.title, ...(o.competitorTitles ?? [])];
  const all = [...ours, ...theirs];
  const titles = r.value.ideas.map((i) => i.workingTitle);
  const useEmb = o.useEmbeddings !== false && process.env.EMBEDDINGS !== "off";
  const vecs = useEmb && all.length ? await embed([...titles, ...all], log).catch(() => null) : null;
  const kept: Idea[] = [];
  const dropped: IdeasResult["dropped"] = [];
  r.value.ideas.forEach((idea, i) => {
    const hit = closest(idea.workingTitle, all, { n: 2, vec: vecs?.[i] ?? null, vecs: vecs ? vecs.slice(titles.length) : undefined });
    const twin = closest(idea.workingTitle, kept.map((k) => k.workingTitle), { n: 2 });
    if (hit.score > maxSim) dropped.push({ workingTitle: idea.workingTitle, reason: ours.includes(hit.against) ? "too close to one of our past titles" : "too close to a competitor title", score: hit.score, against: hit.against });
    else if (twin.score > maxSim) dropped.push({ workingTitle: idea.workingTitle, reason: "repeats another idea", score: twin.score, against: twin.against });
    else kept.push({ ...idea, similarity: { score: hit.score, against: hit.against } });
  });
  const res: IdeasResult = {
    channel: o.channel,
    source: { videoId: src.videoId, title: src.title, views: src.views, multiple: src.multiple, channelTitle: src.channelTitle, angles: src.angles, transcriptWords: src.transcript ? src.transcript.split(/\s+/).length : 0 },
    why: r.value.why,
    ideas: kept.slice(0, 15),
    dropped,
    writer: r.source === "model" ? "model" : "rules",
    createdAt: new Date().toISOString(),
  };
  if (o.save !== false) {
    const dir = path.join(paths.channels, o.channel, "ideas");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${src.videoId.replace(/[^\w-]/g, "_")}.json`), JSON.stringify(res, null, 2) + "\n");
  }
  log(`[ideas] ${res.ideas.length} idea(s) for ${o.channel} from "${src.title.slice(0, 60)}" (${res.writer}); triggers: ${res.why.triggers.join(", ")}; ${dropped.length} dropped as too similar`);
  return res;
}
