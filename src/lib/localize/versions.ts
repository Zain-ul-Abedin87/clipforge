import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";
import { projectDir, readJson, writeJson } from "../project.js";
import { loadGlossary } from "../glossary.js";
import { llmAvailable } from "../agents/llm/llm.js";
import { readConfig, saveConfig } from "../orchestrator/pipeline.js";
import { isLanguage, languageSpec } from "./languages.js";
import { Ask, translateParagraph, translateScript, TranslationResult } from "./translate.js";

/**
 * Language versions (inspired by OpenMontage's "Localization & Dub" pipeline): a video's script is
 * translated into a NEW project "<video>-<lang>" next to the original, which is never changed. The
 * version keeps the topic, products, channel and product links; its script is translated (step
 * "translate", run as the version's Writing stage), reviewed and approved in the same editor, voiced
 * in its language (tts per-language voice) and gets its own visuals, edit and render.
 *
 *   <source>/project.json   languageVersions: {de: "<source>-de"}
 *   <version>/project.json  language, sourceProject, sourceLanguage, sourceTitle
 *   <version>/script_source.txt   the original script the translation was made from
 *   <version>/translation_report.json   per paragraph: original, translation, things to check
 */

interface ProjectJson {
  title?: string;
  language?: string;
  sourceProject?: string;
  sourceLanguage?: string;
  sourceTitle?: string;
  languageVersions?: Record<string, string>;
  [k: string]: unknown;
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const exists = (name: string) => fs.existsSync(path.join(paths.workspace, name));
const pjFile = (name: string) => path.join(paths.workspace, name, "project.json");
const readPj = (name: string): ProjectJson => (fs.existsSync(pjFile(name)) ? readJson<ProjectJson>(pjFile(name)) : {});
const hash = (s: string) => crypto.createHash("sha256").update(s.trim()).digest("hex").slice(0, 16);

/** The language a project's script and voice are in (old projects: English). */
export const languageOf = (project: string): string => readPj(project).language ?? "en";

export interface VersionInfo {
  language: string;
  /** This project is a language version of another one. */
  sourceProject: string | null;
  sourceLanguage: string | null;
  /** Language versions made from this project: code -> project. */
  versions: Record<string, string>;
}

export function versionInfo(project: string): VersionInfo {
  const p = readPj(project);
  const versions = Object.fromEntries(Object.entries(p.languageVersions ?? {}).filter(([, v]) => exists(v)));
  return { language: p.language ?? "en", sourceProject: p.sourceProject ?? null, sourceLanguage: p.sourceProject ? p.sourceLanguage ?? "en" : null, versions };
}

/** "<source>-<lang>", cut to the project-name limit; a clash with an unrelated project gets -2, -3 ... */
export function versionName(source: string, lang: string, taken: (n: string) => boolean = exists, owner: (n: string) => string | undefined = (n) => readPj(n).sourceProject): string {
  const base = `${source.slice(0, 58 - lang.length)}-${lang}`.replace(/-+/g, "-");
  for (let i = 1; i < 100; i++) {
    const n = i === 1 ? base : `${base.slice(0, 58)}-${i}`;
    if (!taken(n) || owner(n) === source) return n;
  }
  return `${base.slice(0, 48)}-${Date.now()}`;
}

/**
 * Creates (or refreshes) the language version of `source`. The original's files are only read; its
 * project.json only gets the link to the version. Returns whether the script must be (re)translated.
 */
export function createLanguageVersion(source: string, lang: string): { project: string; needsTranslation: boolean } {
  if (!NAME_RE.test(source) || !exists(source)) throw new Error("No such video.");
  const to = String(lang ?? "").toLowerCase();
  if (!isLanguage(to)) throw new Error(`Unknown language "${lang}".`);
  const src = readPj(source);
  const from = src.language ?? "en";
  if (from === to) throw new Error(`This video is already in ${languageSpec(to).name}.`);
  const scriptFile = path.join(paths.workspace, source, "script.txt");
  const script = fs.existsSync(scriptFile) ? fs.readFileSync(scriptFile, "utf8").trim() : "";
  if (script.split(/\s+/).filter(Boolean).length < 20) throw new Error("Write or paste the script first: a language version is translated from the script.");
  const cfg = readConfig(source);
  if (!cfg) throw new Error("This video has no topic and products yet.");

  const project = versionName(source, to);
  const dir = projectDir(project);
  saveConfig(project, cfg);
  const old = readPj(project);
  writeJson(pjFile(project), { ...old, title: old.sourceProject === source && old.title ? old.title : src.title ?? cfg.topic, language: to, sourceProject: source, sourceLanguage: from, sourceTitle: src.title ?? cfg.topic });
  for (const f of ["sources.json", "facts_sources.json"]) {
    const a = path.join(paths.workspace, source, f);
    if (fs.existsSync(a)) fs.copyFileSync(a, path.join(dir, f));
  }
  // The translation is the version's script: the editor treats it like the creator's own (no AI rewrite).
  const wizardFile = path.join(dir, "wizard.json");
  const approvals = fs.existsSync(wizardFile) ? readJson<Record<string, unknown>>(wizardFile) : {};
  const sourceFile = path.join(dir, "script_source.txt");
  const same = fs.existsSync(sourceFile) && hash(fs.readFileSync(sourceFile, "utf8")) === hash(script) && fs.existsSync(path.join(dir, "script.txt"));
  if (!same) {
    fs.writeFileSync(sourceFile, script + "\n", "utf8");
    fs.rmSync(path.join(dir, "script.txt"), { force: true });
    delete approvals.script;
    delete approvals.voice;
  }
  writeJson(wizardFile, { ...approvals, scriptMode: "own", voiceMode: "ai" });
  writeJson(pjFile(source), { ...readPj(source), languageVersions: { ...(src.languageVersions ?? {}), [to]: project } });
  console.log(`[translate] ${source} (${from}) -> ${project} (${to})${same ? ": script unchanged, translation kept" : ": translation needed"}`);
  return { project, needsTranslation: !same };
}

/**
 * The `translate` step: script_source.txt -> script.txt in the version's language, plus the title.
 * Exit 0 = done, 2 = done with things to check (translation_report.json), 1 = could not translate.
 */
export async function translateProject(project: string, o: { ask?: Ask; log?: (m: string) => void } = {}): Promise<number> {
  const log = o.log ?? console.log;
  const p = readPj(project);
  if (!p.sourceProject || !p.language) {
    log(`[translate] ${project} is not a language version (make one from the original video).`);
    return 1;
  }
  const dir = projectDir(project);
  const srcFile = path.join(dir, "script_source.txt");
  // "Translate again" brings over the original's latest script.
  const orig = path.join(paths.workspace, p.sourceProject, "script.txt");
  if (fs.existsSync(orig) && fs.readFileSync(orig, "utf8").trim()) fs.writeFileSync(srcFile, fs.readFileSync(orig, "utf8").trim() + "\n", "utf8");
  if (!fs.existsSync(srcFile)) {
    log(`[translate] ${srcFile} missing: make the language version again from the original video.`);
    return 1;
  }
  if (!o.ask && !llmAvailable()) {
    log("[translate] CONFIGURATION ERROR: no AI model is set up (start Ollama). A translation is never faked.");
    return 1;
  }
  const from = languageSpec(p.sourceLanguage ?? "en");
  const to = languageSpec(p.language);
  const cfg = readConfig(project);
  const names = [...(cfg?.products ?? []), ...loadGlossary(path.join(paths.inputs, "glossary.txt"))];
  const t0 = Date.now();
  const source = fs.readFileSync(srcFile, "utf8");
  let r: TranslationResult;
  try {
    r = await translateScript(source, { from, to, names, ask: o.ask, log });
  } catch (err) {
    log(`[translate] failed: ${(err as Error).message}`);
    return 1;
  }
  fs.writeFileSync(path.join(dir, "script.txt"), r.text + "\n", "utf8");
  let title = p.sourceTitle ?? p.title ?? "";
  if (title) {
    const t = await translateParagraph(title, { from, to, names, ask: o.ask, log }).catch(() => null);
    if (t?.translated) title = t.text;
  }
  writeJson(pjFile(project), { ...readPj(project), title });
  writeJson(path.join(dir, "translation_report.json"), {
    from: from.code,
    to: to.code,
    sourceProject: p.sourceProject,
    sourceHash: hash(source),
    sourceWords: r.sourceWords,
    words: r.words,
    flagged: r.flagged,
    notTranslated: r.paragraphs.filter((x) => !x.translated).length,
    paragraphs: r.paragraphs,
    createdAt: new Date().toISOString(),
  });
  // A new translation needs the creator's approval (and a new voice).
  const wf = path.join(dir, "wizard.json");
  const a = fs.existsSync(wf) ? readJson<Record<string, unknown>>(wf) : {};
  delete a.script;
  delete a.voice;
  writeJson(wf, a);
  log(`[translate] ${from.code} -> ${to.code}: ${r.paragraphs.length} paragraph(s), ${r.flagged} to check, ${r.sourceWords} -> ${r.words} words in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return r.flagged ? 2 : 0;
}

export interface TranslationView {
  from: string;
  to: string;
  sourceProject: string;
  flagged: number;
  notTranslated: number;
  /** Paragraphs with something to check (original + translation + notes). */
  checks: { source: string; text: string; issues: string[] }[];
  /** The original script changed after this translation was made. */
  stale: boolean;
}

export function translationView(project: string): TranslationView | null {
  const f = path.join(paths.workspace, project, "translation_report.json");
  if (!fs.existsSync(f)) return null;
  const r = readJson<{ from: string; to: string; sourceProject: string; sourceHash: string; flagged: number; notTranslated: number; paragraphs: { source: string; text: string; issues: string[] }[] }>(f);
  const orig = path.join(paths.workspace, r.sourceProject, "script.txt");
  const stale = fs.existsSync(orig) && hash(fs.readFileSync(orig, "utf8")) !== r.sourceHash;
  return { from: r.from, to: r.to, sourceProject: r.sourceProject, flagged: r.flagged, notTranslated: r.notTranslated, checks: r.paragraphs.filter((p) => p.issues.length).map(({ source, text, issues }) => ({ source, text, issues })), stale };
}
