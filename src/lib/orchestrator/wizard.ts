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

export interface WizardInput {
  topic: string;
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

export function setApproval(project: string, what: keyof Approvals, on: boolean): Approvals {
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
  const target = report.targetWords ?? cfg?.words ?? null;
  const words = countWords(text);
  return {
    text,
    words,
    target,
    onTarget: target ? Math.abs(words - target) <= target * 0.03 : true,
    unsourced: text ? unsourcedClaims(text, facts, cfg?.products ?? []).map((c) => ({ sentence: c.sentence, numbers: c.numbers })) : [],
    facts,
    originality: report.originality ? { clean: report.originality.clean, flagged: report.originality.flagged } : null,
    approved: readApprovals(project).script ?? null,
    writer: report.writer ?? null,
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
  if (!a.script) return 3;
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
