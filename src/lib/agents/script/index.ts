import fs from "node:fs";
import path from "node:path";
import { loadFeatures } from "../../settings/features.js";
import { bannedIn, ChannelBrief, targetWords } from "../../channelBrief.js";
import { writeJson } from "../../project.js";
import { factsFromUrls, loadFactsFile, numbersIn, SourcedFact, unsourcedClaims } from "./facts.js";
import { buildOutline, Outline } from "./outline.js";
import { BeatSheet, beatInstructions, planBeats, retentionReport, RetentionReport, sectionBeatProblems } from "./beats.js";
import type { Sop } from "../sop/extract.js";
import type { FormatId } from "./formats.js";
import { selfRepetition, SelfRepeatReport } from "./selfRepeat.js";
import { recordHistory } from "../../channelHistory.js";
import { originalityReport, OriginalityReport } from "./originality.js";
import { Ask, balanceTotal, countWords, llmWriter, sectionFacts, SectionText, writeSection, writeSections } from "./sections.js";

/**
 * Script writer (Phase 5): topic + products -> outline -> one call per section -> word count
 * balanced to +-3% -> originality check against competitor transcripts (rewrite flagged sections)
 * -> claim check (every number in the script is a sourced fact). Writes <dir>/script.txt and
 * <dir>/script_report.json.
 */

export interface ScriptReport {
  topic: string;
  targetWords: number;
  totalWords: number;
  deviation: number;
  withinTolerance: boolean;
  /** Who wrote it: the local model, or rules only (no model running: a skeleton, not a finished script). */
  writer: "model" | "rules";
  sections: { kind: string; product?: string; target: number; words: number; attempts: number; unsourcedRemoved: number }[];
  originality: OriginalityReport | null;
  claims: { unsourced: { section: string; sentence: string; numbers: string[] }[]; factsUsed: SourcedFact[]; factsAvailable: number; facts: SourcedFact[] };
  /** The channel brief used, and any banned phrase still in the final text (should be none). */
  channel: { id: string; name: string; bannedFound: string[] } | null;
  outline: Outline;
  beats: BeatSheet;
  /** The retention_beats check (also in the QA report). */
  retention: RetentionReport;
  /** Against the channel's own last 20 scripts and titles (null = no channel brief). */
  selfRepetition: SelfRepeatReport | null;
}

export interface ScriptInput {
  topic: string;
  products: string[];
  targetWords?: number;
  /** Product -> page URLs to read facts from (sources.json). */
  sources?: Record<string, string[]>;
  /** Extra facts file (facts_sources.json). */
  factsFile?: string;
  /** Competitor transcripts (plain text) to stay away from. */
  competitors?: string[];
  ask?: Ask | null;
  fetchPage?: typeof fetch;
  useEmbeddings?: boolean;
  log?: (m: string) => void;
  /** The channel's brief (voice, audience, banned phrases, length). */
  brief?: ChannelBrief | null;
  /** A competitor SOP whose structure (hook formula, rules) the script follows. */
  sop?: Sop | null;
  /** Script format (formats.ts); default countdown. */
  format?: FormatId;
  /** The video's title (for the channel history; default: project.json title, else the topic). */
  title?: string;
}

export async function writeScript(dir: string, i: ScriptInput): Promise<{ text: string; report: ScriptReport }> {
  const cfg = loadFeatures().script;
  const log = i.log ?? ((m: string) => console.log(m));
  const target = i.targetWords ?? (i.brief ? targetWords(i.brief) : cfg.targetWords);
  if (i.brief) log(`[script] channel brief: ${i.brief.name} (${i.brief.tone})`);
  const ask = i.ask === undefined ? llmWriter() : i.ask;
  if (!ask) log(`[script] no model available: rule-based sections (facts only)`);
  // 1. Sourced facts.
  const facts: SourcedFact[] = [...(i.factsFile ? loadFactsFile(i.factsFile) : [])];
  for (const [product, urls] of Object.entries(i.sources ?? {})) facts.push(...(await factsFromUrls(product, urls, log, i.fetchPage)));
  log(`[script] ${facts.length} sourced fact(s) for ${new Set(facts.map((f) => f.product)).size}/${i.products.length} product(s)`);
  // 2. Outline + sections.
  const outline = await buildOutline(i.topic, i.products, target, facts, log, i.brief, i.format);
  // 2b. Retention beats: hook, promise, re-hooks, open loops, turns (written into each section's prompt).
  const sheet = await planBeats(outline, { brief: i.brief, sop: i.sop, log });
  outline.sections.forEach((s, k) => {
    s.beats = beatInstructions(sheet, k);
    s.rules = sheet.rulesFromSop;
  });
  const check = (k: number, t: string) => sectionBeatProblems(sheet, k, t);
  // Without a model the intro skeleton still opens on the hook and says the promise.
  if (!ask && outline.sections[0]) outline.sections[0].angle = `${sheet.hook.idea} ${sheet.promise}`;
  let sections = await writeSections(outline, facts, ask, log, i.brief, ask ? check : undefined);
  // 3. Originality: rewrite sections too close to a competitor (one round), then re-check.
  let originality: OriginalityReport | null = null;
  if (i.competitors?.length) {
    const opts = { n: cfg.ngram, maxNgram: cfg.maxNgramOverlap, maxEmbedding: cfg.maxSimilarity, useEmbeddings: i.useEmbeddings, log };
    originality = await originalityReport(sections.map((s) => s.text), i.competitors, opts);
    if (!originality.clean && ask) {
      for (const p of originality.paragraphs.filter((x) => x.flagged)) {
        const s = sections[p.index];
        log(`[script] ${s.section.product ?? s.section.kind}: too close to a competitor (5-gram ${p.ngram}, embedding ${p.embedding ?? "-"}); rewriting`);
        const own = sectionFacts(s.section, facts);
        const re = await writeSection({ ...s.section, angle: `${s.section.angle} Use a completely different structure and wording than a typical review.` }, i.topic, own, "", ask, log, i.brief, (t) => check(p.index, t));
        sections[p.index] = re;
      }
      originality = await originalityReport(sections.map((s) => s.text), i.competitors, opts);
    }
    log(`[script] originality: ${originality.clean ? "clean" : `${originality.flagged} section(s) still flagged`} (max 5-gram overlap ${originality.maxNgram}, max embedding ${originality.maxEmbedding ?? "-"}) vs ${originality.competitorWords} competitor words`);
  }
  // 3b. Not repeating ourselves: the channel's own last 20 scripts (n-gram > 20% or cosine > 0.85: rewrite once).
  const project = path.basename(dir);
  const pj = path.join(dir, "project.json");
  const title = i.title ?? ((fs.existsSync(pj) ? String((JSON.parse(fs.readFileSync(pj, "utf8")) as { title?: string }).title ?? "") : "") || i.topic);
  let self: SelfRepeatReport | null = null;
  if (i.brief) {
    const so = { exclude: project, useEmbeddings: i.useEmbeddings, log };
    self = await selfRepetition(i.brief.id, sections.map((s) => s.text), title, so);
    if (!self.clean && ask) {
      for (const p of self.sections.filter((x) => x.flagged)) {
        const s = sections[p.index];
        log(`[script] ${s.section.product ?? s.section.kind}: too close to our own earlier video "${p.against}" (5-gram ${p.ngram}, cosine ${p.cosine ?? "-"}); rewriting`);
        sections[p.index] = await writeSection({ ...s.section, angle: `${s.section.angle} Take a different angle and structure than the channel's earlier video "${p.against}".` }, i.topic, sectionFacts(s.section, facts), "", ask, log, i.brief, (t) => check(p.index, t));
      }
      self = await selfRepetition(i.brief.id, sections.map((s) => s.text), title, so);
    }
    if (self.checkedAgainst) log(`[script] own videos: ${self.clean ? "no repetition" : `${self.flagged} section(s) still close${self.title?.flagged ? ", title close too" : ""}`} (vs ${self.checkedAgainst} earlier script(s))`);
  }
  // 4. Total length.
  sections = balanceTotal(sections, target, cfg.tolerance);
  const text = sections.map((s) => s.text).join("\n\n");
  const total = countWords(text);
  // 5. Claim check over the final text.
  const unsourced = sections.flatMap((s) => unsourcedClaims(s.text, sectionFacts(s.section, facts), i.products).map((c) => ({ section: s.section.product ?? s.section.kind, ...c })));
  const used = facts.filter((f) => {
    const sec = sections.find((s) => s.section.product === f.product);
    const nums = numbersIn(f.value);
    return !!sec && nums.length > 0 && nums.every((x) => numbersIn(sec.text).includes(x));
  });
  // 6. Retention beats over the final text.
  const retention = retentionReport(sheet, sections.map((s) => ({ label: s.section.product ?? s.section.kind, text: s.text, budget: s.section.words })));
  log(`[script] retention beats: ${retention.status}${retention.problems.length ? ` (${retention.problems.join("; ")})` : ""}`);
  const report: ScriptReport = {
    topic: i.topic,
    targetWords: target,
    totalWords: total,
    deviation: Math.round(((total - target) / target) * 1000) / 1000,
    withinTolerance: Math.abs(total - target) <= target * cfg.tolerance,
    writer: ask ? "model" : "rules",
    sections: sections.map((s) => ({ kind: s.section.kind, product: s.section.product, target: s.section.words, words: s.words, attempts: s.attempts, unsourcedRemoved: s.unsourcedRemoved })),
    originality,
    claims: { unsourced, factsUsed: used, factsAvailable: facts.length, facts },
    channel: i.brief ? { id: i.brief.id, name: i.brief.name, bannedFound: bannedIn(text, i.brief) } : null,
    outline,
    beats: sheet,
    retention,
    selfRepetition: self,
  };
  // The channel's history (for the next videos' repetition check, ideas and titles).
  if (i.brief) recordHistory(i.brief.id, { project, title, topic: i.topic, text });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "script.txt"), text + "\n", "utf8");
  writeJson(path.join(dir, "script_report.json"), report);
  log(`[script] ${total} words (target ${target}, ${(report.deviation * 100).toFixed(1)}%, ${report.withinTolerance ? "within" : "OUTSIDE"} +-${cfg.tolerance * 100}%), ${unsourced.length} unsourced claim(s), ${used.length} sourced fact(s) used`);
  return { text, report };
}
