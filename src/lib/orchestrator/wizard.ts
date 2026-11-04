import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";
import { projectDir, readJson, writeJson } from "../project.js";
import { countWords } from "../agents/script/sections.js";
import { SourcedFact, unsourcedClaims } from "../agents/script/facts.js";
import { readConfig, readState, saveConfig } from "./pipeline.js";

/**
 * "New video" wizard (one guided path for a creator): topic -> title -> products (+ product page
 * links) -> script (read, edit, approve) -> voice (listen, approve) -> visuals + avatar + edit ->
 * render. This module holds the wizard's own data; the steps run through the pipeline
 * (src/lib/orchestrator/pipeline.ts) like everywhere else.
 */

/** Who writes the script: the AI, the creator (pasted), or nobody (the recording is the script). */
export type ScriptMode = "ai" | "own" | "none";
/** Who speaks: the AI voice, or the creator's uploaded recording. */
export type VoiceMode = "ai" | "own";

export interface WizardInput {
  topic: string;
  scriptMode?: ScriptMode;
  voiceMode?: VoiceMode;
  /** scriptMode "own": the creator's script. */
  script?: string;
  title?: string;
  /** Countdown order, last = #1. */
  products: string[];
  words?: number;
  channel?: string;
  /** Product -> page links for sourced facts (written to sources.json). */
  sources?: Record<string, string[]>;
  /** Keep this project name (editing an existing video). */
  project?: string;
}

export interface Approvals {
  script?: string;
  voice?: string;
  scriptMode?: ScriptMode;
  voiceMode?: VoiceMode;
}

/** Script and voice choices of a video (old videos: AI script, AI voice). */
export function modesOf(project: string): { scriptMode: ScriptMode; voiceMode: VoiceMode } {
  const a = readApprovals(project);
  const scriptMode = a.scriptMode ?? "ai";
  return { scriptMode, voiceMode: scriptMode === "none" ? "own" : a.voiceMode ?? "ai" };
}

/** "Best Budget 9mm Pistols!" -> "best-budget-9mm-pistols" (unique in the workspace). */
// Checked without projectDir(), which creates the folder.
export function projectSlug(topic: string, exists: (name: string) => boolean = (n) => fs.existsSync(path.join(paths.workspace, n))): string {
  const base =
    topic
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
      .replace(/-+$/, "") || "video";
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i++) if (!exists(`${base}-${i}`)) return `${base}-${i}`;
  return `${base}-${Date.now()}`;
}

const approvalsFile = (project: string) => path.join(projectDir(project), "wizard.json");

export function readApprovals(project: string): Approvals {
  const f = approvalsFile(project);
  return fs.existsSync(f) ? readJson<Approvals>(f) : {};
}

export function setApproval(project: string, what: "script" | "voice", on: boolean): Approvals {
  const a = readApprovals(project);
  if (on) a[what] = new Date().toISOString();
  else delete a[what];
  // A changed script needs its voice made (and approved) again.
  if (what === "script" && !on) delete a.voice;
  writeJson(approvalsFile(project), a);
  return a;
}

/** Creates (or updates) the wizard's project: config, title, product links. */
export function createVideo(i: WizardInput): { project: string } {
  const topic = i.topic.trim();
  if (!topic) throw new Error("Please enter a topic.");
  const products = i.products.map((p) => p.trim()).filter(Boolean);
  if (products.length < 2) throw new Error("Please enter at least 2 products.");
  // Checked before anything is written, so a refused request leaves no project folder behind.
  if (i.scriptMode === "own" && countWords((i.script ?? "").trim()) < 20) throw new Error("Paste your script (at least a few sentences).");
  const project = i.project && /^[a-z0-9][a-z0-9-]{1,60}$/.test(i.project) ? i.project : projectSlug(topic);
  saveConfig(project, { topic, products, words: i.words, channel: i.channel });
  const pf = path.join(projectDir(project), "project.json");
  writeJson(pf, { ...readJson<Record<string, unknown>>(pf), title: (i.title ?? "").trim() || topic });
  const links: Record<string, string[]> = {};
  for (const p of products) {
    const urls = (i.sources?.[p] ?? []).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
    if (urls.length) links[p] = urls;
  }
  const sf = path.join(projectDir(project), "sources.json");
  if (Object.keys(links).length) writeJson(sf, links);
  else fs.rmSync(sf, { force: true });
  // Script and voice choices. No script means the recording is the script, so the voice is own.
  const scriptMode: ScriptMode = i.scriptMode === "own" || i.scriptMode === "none" ? i.scriptMode : "ai";
  const voiceMode: VoiceMode = scriptMode === "none" ? "own" : i.voiceMode === "own" ? "own" : "ai";
  const a = { ...readApprovals(project), scriptMode, voiceMode };
  writeJson(approvalsFile(project), a);
  const scriptFile = path.join(projectDir(project), "script.txt");
  if (scriptMode === "own") {
    const text = (i.script ?? "").replace(/\r\n/g, "\n").trim();
    if (countWords(text) < 20) throw new Error("Paste your script (at least a few sentences).");
    const changed = !fs.existsSync(scriptFile) || fs.readFileSync(scriptFile, "utf8").trim() !== text;
    fs.writeFileSync(scriptFile, text + "\n", "utf8");
    if (changed) setApproval(project, "script", false);
    // The creator's script is not the AI writer's: no report from an earlier AI run applies.
    fs.rmSync(path.join(projectDir(project), "script_report.json"), { force: true });
  }
  if (scriptMode === "none") fs.rmSync(scriptFile, { force: true });
  return { project };
}

export interface ScriptView {
  text: string;
  words: number;
  target: number | null;
  /** Within +-3% of the target. */
  onTarget: boolean;
  unsourced: { sentence: string; numbers: string[] }[];
  facts: SourcedFact[];
  originality: { clean: boolean; flagged: number } | null;
  approved: string | null;
  /** "rules": no AI model was running, the text is only a skeleton. */
  writer: "model" | "rules" | null;
  /** The creator pasted this script (not written by the AI). */
  own: boolean;
}

interface ReportLike {
  targetWords?: number;
  claims?: { factsUsed?: SourcedFact[]; facts?: SourcedFact[] };
  originality?: { clean: boolean; flagged: number } | null;
  writer?: "model" | "rules";
}

/** The script as the editor shows it, re-checked: word count and numbers without a source. */
export function scriptView(project: string): ScriptView {
  const dir = projectDir(project);
  const file = path.join(dir, "script.txt");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  const report = fs.existsSync(path.join(dir, "script_report.json")) ? readJson<ReportLike>(path.join(dir, "script_report.json")) : {};
  const cfg = readConfig(project);
  const facts = report.claims?.facts ?? report.claims?.factsUsed ?? [];
  const own = modesOf(project).scriptMode === "own";
  const target = report.targetWords ?? cfg?.words ?? null;
  const words = countWords(text);
  return {
    text,
    words,
    target,
    onTarget: target ? Math.abs(words - target) <= target * 0.03 : true,
    // The creator's own script: its numbers are the creator's call (no AI-sourced facts to check).
    unsourced: text && !own ? unsourcedClaims(text, facts, cfg?.products ?? []).map((c) => ({ sentence: c.sentence, numbers: c.numbers })) : [],
    facts,
    originality: report.originality ? { clean: report.originality.clean, flagged: report.originality.flagged } : null,
    approved: readApprovals(project).script ?? null,
    writer: own ? null : report.writer ?? null,
    own,
  };
}

/** Saves the edited script; editing takes back the approval (and the voice's). */
export function saveScript(project: string, text: string, approve: boolean): ScriptView {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) throw new Error("The script is empty.");
  const file = path.join(projectDir(project), "script.txt");
  const changed = !fs.existsSync(file) || fs.readFileSync(file, "utf8").trim() !== clean;
  fs.writeFileSync(file, clean + "\n", "utf8");
  if (changed) setApproval(project, "script", false);
  if (approve) setApproval(project, "script", true);
  return scriptView(project);
}

/** Which wizard step the project is on (1 topic ... 6 done). */
export function wizardStep(project: string): number {
  const cfg = readConfig(project);
  if (!cfg?.topic || cfg.products.length < 2) return 1;
  const a = readApprovals(project);
  const st = readState(project).stages;
  // No script (the recording is the script): straight to the voice step.
  if (!a.script && modesOf(project).scriptMode !== "none") return 3;
  if (!a.voice) return 4;
  if (st.edit.status !== "done") return 5;
  if (st.render.status !== "done") return 6;
  return 7;
}

/** Finished Shorts of a project (output/<project>_short_<n>.mp4). */
export function shortsOf(project: string): string[] {
  if (!fs.existsSync(paths.output)) return [];
  return fs
    .readdirSync(paths.output)
    .filter((f) => f.startsWith(`${project}_short_`) && f.endsWith(".mp4"))
    .sort();
}

/** The voiceover file of a project, when it is the creator's own recording (not an AI voice). */
export function ownRecording(project: string): string | null {
  const pf = path.join(projectDir(project), "project.json");
  const p = fs.existsSync(pf) ? readJson<{ audio?: string; voiceMode?: string }>(pf) : {};
  return isOwnRecording(p) ? p.audio! : null;
}

/**
 * True when project.json points at an uploaded recording. The upload route does not set
 * voiceMode, so the file name decides too: the AI voice is always voiceover_tts.wav.
 */
export function isOwnRecording(p: { audio?: string; voiceMode?: string }): boolean {
  return !!p.audio && fs.existsSync(p.audio) && p.voiceMode !== "tts" && !/voiceover_tts\.wav$/i.test(p.audio);
}

export interface DifferenceView {
  id: string;
  type: string;
  script: string;
  heard: string;
  start: number;
  resolution: string | null;
}

/** Significant places where the recording differs from the script (Mode C), with the creator's choice. */
export function differences(project: string): DifferenceView[] {
  const dir = projectDir(project);
  const f = path.join(dir, "discrepancies.json");
  if (!fs.existsSync(f)) return [];
  const items = readJson<{ items: { id: string; type: string; severity: string; script: string; heard: string; start: number }[] }>(f).items ?? [];
  const chosen = readJson<{ discrepancyResolutions?: Record<string, string> }>(path.join(dir, "project.json")).discrepancyResolutions ?? {};
  return items.filter((d) => d.severity === "significant").map((d) => ({ id: d.id, type: d.type, script: d.script, heard: d.heard, start: d.start, resolution: chosen[d.id] ?? null }));
}
