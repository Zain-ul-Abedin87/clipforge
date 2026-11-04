import fs from "node:fs";
import path from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";
import { withStage } from "../models/loader.js";
import { paths } from "../paths.js";
import { loadFeatures } from "../settings/features.js";
import { gatherSources, Source } from "../research/wiki.js";
import { applyCheck, bestPassages, checkClaims, FactCheck, Judge, passages } from "../factcheck/factcheck.js";
import { requireAi } from "./tool.js";

/**
 * Documentary videos (history, science, "how X works", geography ...): long-form narration over
 * footage, through ClipForge's own pipeline with the niches/documentary.json rules (no product
 * countdown). Only the writing is different:
 *   1. research: the creator's links + notes + Wikipedia (features.json factcheck) -> research.json;
 *   2. the AI plans chapters, then writes each chapter from the passages about it (facts only from
 *      the sources; the creator's own script skips this);
 *   3. the fact checker (src/lib/factcheck) checks every claim against the sources; contradicted
 *      claims are removed, unconfirmed ones too when factcheck.removeUnverified is on;
 *   4. script.txt (what the voice reads), factcheck.json, script_report.json.
 * Voice, footage, edit, render and QA are the normal pipeline.
 */

export interface DocumentaryInput {
  topic: string;
  title?: string;
  /** The creator's own facts (a source like any other, shown as "Your notes"). */
  notes?: string;
  links?: string[];
  minutes?: number;
  /** The creator's own script: not written by the AI, only fact-checked. */
  script?: string;
}

const dirOf = (project: string) => path.join(paths.workspace, project);
const inputFile = (project: string) => path.join(dirOf(project), "documentary.json");

export function saveDocumentaryInput(project: string, i: DocumentaryInput): DocumentaryInput {
  const topic = String(i.topic ?? "").trim();
  if (!topic) throw new Error("Please enter what the documentary is about.");
  const script = String(i.script ?? "").trim();
  if (script && script.split(/\s+/).length < 50) throw new Error("Your script is very short: paste the whole script (at least a few paragraphs).");
  const clean: DocumentaryInput = {
    topic: topic.slice(0, 200),
    title: (i.title ?? "").trim().slice(0, 100) || topic.slice(0, 100),
    notes: String(i.notes ?? "").trim().slice(0, 20_000),
    links: (i.links ?? []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 8),
    minutes: Math.max(3, Math.min(30, Math.round(Number(i.minutes) || 10))),
    ...(script ? { script } : {}),
  };
  fs.mkdirSync(dirOf(project), { recursive: true });
  fs.writeFileSync(inputFile(project), JSON.stringify(clean, null, 2));
  return clean;
}

export const readDocumentaryInput = (project: string): DocumentaryInput | null =>
  fs.existsSync(inputFile(project)) ? (JSON.parse(fs.readFileSync(inputFile(project), "utf8")) as DocumentaryInput) : null;

export type Ask = (system: string, user: string, schema: "outline" | "chapter" | "judge") => Promise<unknown>;

const Outline = z.object({ title: z.string(), chapters: z.array(z.object({ title: z.string(), focus: z.string() })) });
const Chapter = z.object({ text: z.string() });
const JudgeOut = z.object({ verdict: z.enum(["supported", "contradicted", "not_found"]), sourceId: z.string().optional(), quote: z.string().optional() });
const SCHEMAS = { outline: Outline, chapter: Chapter, judge: JudgeOut };

const modelAsk: Ask = async (system, user, schema) => {
  const res = await withStage("script", () =>
    llm().messages.parse({ model: env("LLM_MODEL", "claude-haiku-4-5"), max_tokens: schema === "chapter" ? 3500 : 1200, output_config: { format: zodOutputFormat(SCHEMAS[schema]) }, system, messages: [{ role: "user", content: user }] }),
  );
  return res.parsed_output;
};

export const NARRATION_RULES = [
  "You write the narration of a long-form YouTube documentary, read aloud by a voice.",
  "Tell it as a story: people, places, stakes, cause and effect. Short spoken sentences, everyday words.",
  "Write every number, year and measure in digits (1958, 450 metres, 25%).",
  "State ONLY facts that appear in the source passages given. Never invent numbers, dates, names, quotes or events. If the sources do not say it, leave it out.",
  "No headings, no stage directions, no lists: plain narration in paragraphs.",
  "No filler ('let's dive in', 'in this video', 'stay tuned'), no em dashes.",
].join("\n");

/** The passages that cover a chapter, cut to fit the model's context. */
export function chapterPassages(sources: Source[], query: string, maxChars = 9000): string {
  const top = bestPassages(query, passages(sources), 1, 40);
  const titles = new Map(sources.map((s) => [s.id, s.title]));
  let out = "";
  for (const p of top) {
    const line = `[${p.sourceId} ${titles.get(p.sourceId)}] ${p.text}\n`;
    if (out.length + line.length > maxChars) break;
    out += line;
  }
  return out;
}

export const makeJudge = (ask: Ask): Judge => async (claim, ps) =>
  JudgeOut.parse(
    await ask(
      "You check one claim of a documentary script against source passages. Answer supported only if a passage says the same thing, contradicted only if a passage says something different about the same thing, else not_found. Copy the exact words of the passage that decides it into quote (word for word, at least 6 words).",
      `Claim: "${claim}"\n\nPassages:\n${ps.map((p) => `[${p.id}] ${p.text}`).join("\n\n")}`,
      "judge",
    ),
  );

export interface DocumentaryReport {
  writer: "model" | "own";
  title: string;
  chapters: { title: string; words: number }[];
  targetWords: number;
  words: number;
  sources: { id: string; kind: string; title: string; url: string }[];
  factcheck: FactCheck;
}

export async function writeDocumentary(project: string, o: { ask?: Ask; fetch?: typeof fetch; log?: (m: string) => void } = {}): Promise<DocumentaryReport> {
  const log = o.log ?? console.log;
  const input = readDocumentaryInput(project);
  if (!input) throw new Error("No documentary inputs (documentary.json): create the video first.");
  const fc = loadFeatures().factcheck;
  const ask = o.ask ?? (llmAvailable() ? modelAsk : null);
  if (!input.script && !ask) throw new Error("No AI model is set up (start Ollama or add an API key): the documentary is written by the AI.");
  if (!o.ask && !input.script) await requireAi();
  const dir = dirOf(project);

  // 1. research
  const sources = await gatherSources({ topic: input.topic, links: input.links ?? [], notes: input.notes ?? "", wikipedia: fc.wikipedia, lang: fc.wikiLang, pages: fc.wikiPages, fetch: o.fetch, log });
  fs.writeFileSync(path.join(dir, "research.json"), JSON.stringify({ at: new Date().toISOString(), sources }, null, 1));
  if (!sources.length && !input.script) throw new Error("No sources: add links or notes, or allow Wikipedia (Tools > Fact checker). A documentary is only written from sources.");

  // 2. the script
  const targetWords = Math.round((input.minutes ?? 10) * 150);
  let title = input.title ?? input.topic;
  let text: string;
  const chapters: { title: string; words: number }[] = [];
  if (input.script) {
    text = input.script.replace(/\r\n/g, "\n").trim();
    log(`[documentary] your script: ${text.split(/\s+/).length} words (not rewritten, only fact-checked)`);
  } else {
    const overview = sources.map((s) => `[${s.id}] ${s.title}: ${s.text.slice(0, 1200).replace(/\s+/g, " ")}`).join("\n").slice(0, 7000);
    const outline = Outline.parse(await ask!(NARRATION_RULES, `Topic: ${input.topic}\nLength: about ${targetWords} words.\nSources (start of each):\n${overview}\n\nPlan the documentary: a title and 4 to 8 chapters in story order (the first one is the hook that makes people stay). For each chapter, what it covers (focus), using only what the sources cover.`, "outline"));
    title = outline.title.trim() || title;
    const per = Math.round(targetWords / Math.max(1, outline.chapters.length));
    const parts: string[] = [];
    for (const [i, ch] of outline.chapters.entries()) {
      const ps = chapterPassages(sources, `${input.topic} ${ch.title} ${ch.focus}`);
      const out = Chapter.parse(await ask!(NARRATION_RULES, `Documentary: ${title}\nChapter ${i + 1} of ${outline.chapters.length}: ${ch.title} (${ch.focus})\n${i === 0 ? "This is the hook: open with the most surprising fact from the passages, then say what the viewer will find out.\n" : ""}Write about ${per} words.\n${parts.length ? `The previous chapter ended: "${parts[parts.length - 1].slice(-300)}"\n` : ""}Source passages (the only facts you may use):\n${ps}`, "chapter"));
      const t = out.text.replace(/\n{3,}/g, "\n\n").trim();
      parts.push(t);
      chapters.push({ title: ch.title, words: t.split(/\s+/).length });
      log(`[documentary] chapter ${i + 1}/${outline.chapters.length} "${ch.title}": ${chapters[i].words} words`);
    }
    text = parts.join("\n\n");
  }

  // 3. fact check
  const check = await checkClaims(text, sources, { judge: ask ? makeJudge(ask) : null, minOverlap: fc.minOverlap });
  const applied = applyCheck(text, check, fc.removeUnverified);
  check.removed = applied.removed;
  log(`[factcheck] ${check.claims.length} claim(s): ${check.counts.supported} supported, ${check.counts.contradicted} contradicted, ${check.counts.not_found} not found, ${check.counts.unchecked} not checked; ${applied.removed.length} sentence(s) removed`);

  // 4. files
  fs.writeFileSync(path.join(dir, "script.txt"), applied.text.trim() + "\n", "utf8");
  const report: DocumentaryReport = {
    writer: input.script ? "own" : "model",
    title,
    chapters,
    targetWords,
    words: applied.text.split(/\s+/).filter(Boolean).length,
    sources: sources.map(({ id, kind, title, url }) => ({ id, kind, title, url })),
    factcheck: check,
  };
  fs.writeFileSync(path.join(dir, "factcheck.json"), JSON.stringify(report, null, 1));
  // The wizard's script view reads the target and the writer from script_report.json.
  fs.writeFileSync(path.join(dir, "script_report.json"), JSON.stringify({ topic: input.topic, targetWords, totalWords: report.words, writer: "model" }, null, 1));
  const pj = path.join(dir, "project.json");
  if (fs.existsSync(pj)) fs.writeFileSync(pj, JSON.stringify({ ...JSON.parse(fs.readFileSync(pj, "utf8")), title }, null, 2));
  return report;
}

/** The creator edited the script: re-check it against the saved research (numbers only, quick). */
export async function recheckDocumentary(project: string, text: string): Promise<FactCheck> {
  const dir = dirOf(project);
  const rf = path.join(dir, "research.json");
  const sources = fs.existsSync(rf) ? (JSON.parse(fs.readFileSync(rf, "utf8")) as { sources: Source[] }).sources : [];
  const check = await checkClaims(text, sources, { judge: null, minOverlap: loadFeatures().factcheck.minOverlap });
  const ff = path.join(dir, "factcheck.json");
  const prev = fs.existsSync(ff) ? JSON.parse(fs.readFileSync(ff, "utf8")) : {};
  fs.writeFileSync(ff, JSON.stringify({ ...prev, words: text.split(/\s+/).filter(Boolean).length, factcheck: check, editedAt: new Date().toISOString() }, null, 1));
  return check;
}
