import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { bannedIn, briefPrompt, ChannelBrief } from "../channelBrief.js";
import { closest } from "../originality/similarity.js";
import { askJson } from "./llm/json.js";
import { titleSubject } from "./ideas.js";

/**
 * Thumbnail concepts (no image generation): the chosen title + how the competitors' outlier
 * thumbnails are built (each one described by the vision model, one picture per call) -> 3
 * concepts: main subject, on-image text (4 words max), emotion, a contrast / colour idea.
 * The competitors' on-image text is never reused. Saved to <project>/thumbnail_concepts.json.
 */

const Described = z.object({
  subject: z.string().min(2).max(160),
  text: z.string().max(80),
  emotion: z.string().min(2).max(60),
  colors: z.array(z.string().max(40)).max(6),
  composition: z.string().min(3).max(200),
});
export type ThumbDescription = z.infer<typeof Described> & { videoId: string; title: string };

const Concept = z.object({
  mainSubject: z.string().min(3).max(160),
  text: z.string().min(1).max(40),
  emotion: z.string().min(2).max(60),
  contrast: z.string().min(5).max(200),
  why: z.string().min(5).max(240),
});
export type ThumbConcept = z.infer<typeof Concept>;
const Concepts = z.object({ concepts: z.array(Concept).length(3) });

export interface ThumbRef {
  videoId: string;
  title: string;
  thumbnail?: string;
}

export interface ThumbResult {
  title: string;
  references: ThumbDescription[];
  concepts: ThumbConcept[];
  writer: "model" | "rules";
  notes: string[];
  createdAt: string;
}

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

/** Downloads a reference thumbnail (hqdefault when the scan has no URL). */
async function download(ref: ThumbRef, dir: string, fetchImpl: typeof fetch): Promise<string | null> {
  const url = ref.thumbnail || `https://i.ytimg.com/vi/${ref.videoId}/hqdefault.jpg`;
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return null;
    const f = path.join(dir, `ref_${ref.videoId.replace(/[^\w-]/g, "_")}.jpg`);
    fs.writeFileSync(f, buf);
    return f;
  } catch {
    return null;
  }
}

/** Rule concepts from the title alone (no model). */
export function ruleConcepts(title: string, format?: string): ThumbConcept[] {
  const vs = /\bvs\.?\b|\bversus\b/i.test(title) || format === "versus";
  // "Mora vs Buck: which knife?" -> "Mora and Buck" (each side up to the first ":" / "?").
  const sides = title.split(/\bvs\.?\b|\bversus\b/i).map((x) => x.split(/[:?!|]/)[0].trim()).filter(Boolean);
  const subject = vs && sides.length === 2 ? `${sides[0]} and ${sides[1]}` : titleSubject(title);
  const num = /\b(\d+)\b/.exec(title)?.[1];
  const texts = vs ? ["WHICH ONE?", "CLEAR WINNER", "DON'T PICK WRONG"] : num ? [`TOP ${num}`, "WORTH IT?", "SKIP THIS ONE"] : ["WORTH IT?", "THE TRUTH", "BEFORE YOU BUY"];
  return [
    { mainSubject: vs ? `${subject} side by side, split down the middle` : `one ${subject}, large and sharp, filling half the frame`, text: texts[0], emotion: "curious", contrast: "bright subject on a dark, plain background; text in yellow with a black outline", why: "one clear subject and a question the video answers" },
    { mainSubject: `a close-up detail of the ${subject} that the video explains`, text: texts[1], emotion: "confident", contrast: "warm subject against a cool blue background", why: "a detail invites a click to see the whole thing" },
    { mainSubject: `the ${subject} with a red mark on the part that matters`, text: texts[2], emotion: "concerned", contrast: "high contrast: white subject, black background, one red accent", why: "a warning sets stakes without a false claim" },
  ];
}

export async function thumbnailConcepts(o: {
  dir: string;
  title: string;
  refs: ThumbRef[];
  brief?: ChannelBrief | null;
  format?: string;
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
  maxRefs?: number;
}): Promise<ThumbResult> {
  const log = o.log ?? (() => {});
  const notes: string[] = [];
  const tdir = path.join(o.dir, "thumbs");
  fs.mkdirSync(tdir, { recursive: true });
  // 1. Describe the competitors' outlier thumbnails, one at a time (small vision model, 8K).
  const references: ThumbDescription[] = [];
  for (const ref of o.refs.slice(0, o.maxRefs ?? 4)) {
    const file = await download(ref, tdir, o.fetchImpl ?? ((...a) => fetch(...a)));
    if (!file) {
      notes.push(`thumbnail of ${ref.videoId} could not be downloaded`);
      continue;
    }
    const r = await askJson({
      stage: "vision",
      schema: Described,
      label: `thumb ${ref.videoId}`,
      log,
      maxTokens: 600,
      images: [{ data: fs.readFileSync(file).toString("base64"), mediaType: "image/jpeg" }],
      system: "You describe a YouTube thumbnail for a designer. Return JSON: subject (what is shown), text (the words written on it, exactly, or empty), emotion (of a face or the mood), colors (main colours), composition (layout in one sentence).",
      user: `Describe this thumbnail. (Its video title: "${ref.title.slice(0, 100)}")`,
      fallback: () => ({ subject: "", text: "", emotion: "", colors: [], composition: "" }),
    });
    if (r.source === "fallback") {
      notes.push(`thumbnail of ${ref.videoId} was not described (no vision model)`);
      continue;
    }
    references.push({ ...r.value, videoId: ref.videoId, title: ref.title });
  }
  const theirText = references.map((r) => r.text.trim()).filter(Boolean);
  // 2. Three concepts of our own.
  const r = await askJson({
    stage: "titles",
    schema: Concepts,
    label: "thumbnail concepts",
    log,
    maxTokens: 1200,
    system: `You design YouTube thumbnail concepts (no image is made). Return exactly 3 concepts, each: mainSubject (what fills the frame), text (the on-image words: 4 words or fewer, or a number), emotion, contrast (the colour / contrast idea), why (why it earns the click for this title). The three must be clearly different. Never reuse the competitors' on-image text; learn what works from their layouts. No false claims.${o.brief ? `\n${briefPrompt(o.brief)}` : ""}`,
    user: `Our title: "${o.title}"${o.format ? ` (format: ${o.format})` : ""}\n${references.length ? `Competitor outlier thumbnails:\n${references.map((d, i) => `${i + 1}. subject: ${d.subject}; text: "${d.text}"; emotion: ${d.emotion}; colours: ${d.colors.join(", ")}; layout: ${d.composition}`).join("\n")}` : "No competitor thumbnails were described: work from the title."}`,
    validate: (v) => {
      const long = v.concepts.find((c) => words(c.text) > 4);
      if (long) return `"${long.text}" has ${words(long.text)} words; on-image text is 4 words or fewer`;
      const copied = v.concepts.find((c) => theirText.some((t) => closest(c.text, [t], { n: 1 }).score > 0.8));
      if (copied) return `"${copied.text}" repeats a competitor's on-image text`;
      const banned = v.concepts.find((c) => bannedIn(c.text, o.brief).length);
      if (banned) return `"${banned.text}" uses a phrase this channel never uses`;
      if (new Set(v.concepts.map((c) => c.text.toLowerCase())).size < 3) return "the three concepts need different text";
      return null;
    },
    fallback: () => ({ concepts: ruleConcepts(o.title, o.format) }),
  });
  const res: ThumbResult = { title: o.title, references, concepts: r.value.concepts, writer: r.source === "model" ? "model" : "rules", notes, createdAt: new Date().toISOString() };
  fs.writeFileSync(path.join(o.dir, "thumbnail_concepts.json"), JSON.stringify(res, null, 2) + "\n");
  log(`[thumbnails] 3 concept(s) for "${o.title.slice(0, 60)}" (${res.writer}), ${references.length} competitor thumbnail(s) described${notes.length ? `; ${notes.join("; ")}` : ""}`);
  return res;
}

/** The outliers whose titles are closest to ours (the references), else the strongest outliers. */
export function pickRefs(title: string, outliers: { video: { id: string; title: string; thumbnail?: string }; score: number }[], n = 4): ThumbRef[] {
  const scored = outliers.map((o) => ({ o, sim: closest(title, [o.video.title], { n: 2 }).score }));
  return scored
    .sort((a, b) => b.sim - a.sim || b.o.score - a.o.score)
    .slice(0, n)
    .map(({ o }) => ({ videoId: o.video.id, title: o.video.title, thumbnail: o.video.thumbnail }));
}
