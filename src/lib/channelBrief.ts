import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "./paths.js";

/**
 * Channel brief (channels/<id>/brief.json, with brief.md as an editable view): who the channel is
 * for and how it sounds. It goes into the title, outline and section prompts, so every script is
 * written in the channel's own voice instead of a generic one.
 * Editing brief.md works too: when it is newer than brief.json it is read back on the next load.
 */

export const BriefSchema = z.object({
  id: z.string(),
  name: z.string(),
  niche: z.string(),
  audience: z.string(),
  /** e.g. "calm expert, no hype". */
  tone: z.string(),
  pillars: z.array(z.string()),
  bannedPhrases: z.array(z.string()),
  ctaStyle: z.string(),
  /** Target length of a long video in minutes (target words = minutes x wpm). */
  targetMinutes: z.number().min(1).max(120),
  /** Reading speed of the voice in words per minute (default 150). */
  wpm: z.number().min(80).max(260),
  /** Spoken language (ISO code, e.g. en, de). */
  language: z.string(),
  /** Content rules the channel never breaks (e.g. YouTube-safe limits). */
  rules: z.array(z.string()),
});
export type ChannelBrief = z.infer<typeof BriefSchema>;

export const briefDir = (id: string) => path.join(paths.channels, id);
const jsonFile = (id: string) => path.join(briefDir(id), "brief.json");
const mdFile = (id: string) => path.join(briefDir(id), "brief.md");
const ID = /^[a-z0-9][a-z0-9_-]{0,60}$/;

export function defaultBrief(id: string): ChannelBrief {
  return { id, name: id, niche: "", audience: "", tone: "clear and friendly, no hype", pillars: [], bannedPhrases: ["game-changer", "you won't believe", "without further ado", "smash that like button"], ctaStyle: "One short line at the end asking a real question for the comments.", targetMinutes: 10, wpm: 150, language: "en", rules: [] };
}

export const targetWords = (b: Pick<ChannelBrief, "targetMinutes" | "wpm">) => Math.round(b.targetMinutes * b.wpm);

const cleanList = (v: unknown) => (Array.isArray(v) ? v : String(v ?? "").split(/\n|;/)).map((x) => String(x).replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean).slice(0, 40);

/** Validates and cleans a (partial) brief on top of the defaults / the saved one. */
export function cleanBrief(id: string, patch: Record<string, unknown>, base: ChannelBrief = defaultBrief(id)): ChannelBrief {
  const num = (v: unknown, d: number, lo: number, hi: number) => (Number.isFinite(Number(v)) && v !== "" && v !== null ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const str = (v: unknown, d: string, max = 400) => (v === undefined ? d : String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max));
  const b: ChannelBrief = {
    id,
    name: str(patch.name, base.name, 80) || id,
    niche: str(patch.niche, base.niche),
    audience: str(patch.audience, base.audience),
    tone: str(patch.tone, base.tone, 200),
    pillars: patch.pillars === undefined ? base.pillars : cleanList(patch.pillars),
    bannedPhrases: patch.bannedPhrases === undefined ? base.bannedPhrases : cleanList(patch.bannedPhrases),
    ctaStyle: str(patch.ctaStyle, base.ctaStyle, 300),
    targetMinutes: num(patch.targetMinutes, base.targetMinutes, 1, 120),
    wpm: Math.round(num(patch.wpm, base.wpm, 80, 260)),
    language: /^[a-z]{2}$/.test(String(patch.language ?? "")) ? String(patch.language) : base.language,
    rules: patch.rules === undefined ? base.rules : cleanList(patch.rules),
  };
  return BriefSchema.parse(b);
}

// ------------------------------------------------------------------------------------ brief.md view

const SECTIONS: [keyof ChannelBrief, string][] = [
  ["niche", "Niche"],
  ["audience", "Audience"],
  ["tone", "Tone"],
  ["pillars", "Content pillars"],
  ["bannedPhrases", "Banned phrases"],
  ["ctaStyle", "Call to action style"],
  ["targetMinutes", "Target length (minutes)"],
  ["wpm", "Reading speed (words per minute)"],
  ["language", "Language"],
  ["rules", "Content rules"],
];

export function briefToMd(b: ChannelBrief): string {
  const body = SECTIONS.map(([k, label]) => {
    const v = b[k];
    return `## ${label}\n\n${Array.isArray(v) ? v.map((x) => `- ${x}`).join("\n") || "-" : String(v)}`;
  }).join("\n\n");
  return `# ${b.name}\n\n<!-- Channel brief for "${b.id}". Edit the text under each heading; ClipForge reads this file back. Target: ${targetWords(b)} words. -->\n\n${body}\n`;
}

export function mdToBrief(id: string, md: string, base?: ChannelBrief): ChannelBrief {
  const name = /^#\s+(.+)$/m.exec(md)?.[1]?.trim();
  const patch: Record<string, unknown> = name ? { name } : {};
  const parts = md.replace(/<!--[\s\S]*?-->/g, "").split(/^##\s+/m).slice(1);
  for (const part of parts) {
    const [head, ...rest] = part.split("\n");
    const key = SECTIONS.find(([, label]) => label.toLowerCase() === head.trim().toLowerCase())?.[0];
    if (!key) continue;
    const text = rest.join("\n").trim();
    patch[key] = ["pillars", "bannedPhrases", "rules"].includes(key) ? (text === "-" ? [] : text.split("\n").filter((l) => /^\s*[-*]\s+/.test(l))) : text;
  }
  return cleanBrief(id, patch, base ?? defaultBrief(id));
}

export const hasBrief = (id: string) => ID.test(id) && (fs.existsSync(jsonFile(id)) || fs.existsSync(mdFile(id)));

export function saveBrief(id: string, patch: Record<string, unknown>): ChannelBrief {
  if (!ID.test(id)) throw new Error(`bad channel id "${id}"`);
  const b = cleanBrief(id, patch, loadBrief(id) ?? defaultBrief(id));
  fs.mkdirSync(briefDir(id), { recursive: true });
  fs.writeFileSync(jsonFile(id), JSON.stringify(b, null, 2) + "\n");
  fs.writeFileSync(mdFile(id), briefToMd(b));
  return b;
}

/** The channel's brief, or null when it has none. A brief.md edited by hand wins over brief.json. */
export function loadBrief(id: string | undefined | null): ChannelBrief | null {
  if (!id || !ID.test(id)) return null;
  const j = jsonFile(id);
  const m = mdFile(id);
  const fromJson = fs.existsSync(j) ? cleanBrief(id, JSON.parse(fs.readFileSync(j, "utf8").replace(/^\uFEFF/, "")) as Record<string, unknown>) : null;
  if (fs.existsSync(m) && (!fromJson || fs.statSync(m).mtimeMs > fs.statSync(j).mtimeMs + 1000)) {
    const b = mdToBrief(id, fs.readFileSync(m, "utf8"), fromJson ?? undefined);
    fs.writeFileSync(j, JSON.stringify(b, null, 2) + "\n");
    // Same content, normalised (and its mtime no longer ahead of the json).
    fs.writeFileSync(m, briefToMd(b));
    return b;
  }
  return fromJson;
}

// ---------------------------------------------------------------------------------- prompt helpers

/** The brief as a short prompt block (about 100-200 tokens). */
export function briefPrompt(b: ChannelBrief | null | undefined): string {
  if (!b) return "";
  const lines = [
    `Channel: ${b.name}${b.niche ? ` (${b.niche})` : ""}`,
    b.audience && `Audience: ${b.audience}`,
    b.tone && `Tone: ${b.tone}`,
    b.pillars.length && `Content pillars: ${b.pillars.join("; ")}`,
    b.ctaStyle && `Call to action style: ${b.ctaStyle}`,
    b.rules.length && `Rules: ${b.rules.join("; ")}`,
    b.bannedPhrases.length && `Never use these phrases: ${b.bannedPhrases.map((p) => `"${p}"`).join(", ")}`,
  ].filter(Boolean);
  return `Write in this channel's voice:\n${lines.map((l) => `- ${l}`).join("\n")}`;
}

/** Banned phrases found in a text (case-insensitive, whole words). */
export function bannedIn(text: string, b: ChannelBrief | null | undefined): string[] {
  if (!b) return [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "['’]");
  return b.bannedPhrases.filter((p) => p.trim() && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(p.trim())}($|[^\\p{L}\\p{N}])`, "iu").test(text));
}

export const LANGUAGE_NAMES: Record<string, string> = { en: "English", de: "German", es: "Spanish", fr: "French", it: "Italian", pt: "Portuguese", hi: "Hindi", ur: "Urdu" };
