import fs from "node:fs";
import path from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";
import { withStage } from "../models/loader.js";
import { paths } from "../paths.js";
import { loadFeatures } from "../settings/features.js";
import { Exec, requireAi, runTool } from "./tool.js";

/**
 * Explainer videos through explainroo (github.com/vincentsch/explainroo, MIT): an animated diagram
 * with a voice-over, made from script.md (the words) and scenes.js (the drawing code).
 * ClipForge runs explainroo's own loop automatically:
 *   1. the AI writes the narration as structured scenes; ClipForge writes script.md (so the syntax is
 *      always right) - facts only from the creator's points, never invented;
 *   2. the AI writes each scene's drawing code against explainroo's Scene API; every body is checked
 *      (no network, files or browser globals, must compile) before explainroo runs it;
 *   3. `explainroo check --json`: its errors go back to the AI for up to features.json
 *      formats.fixRounds rounds; what is left is shown to the creator;
 *   4. voice, render, verify; the MP4 goes to output/<project>.mp4 for ClipForge's QA.
 * Project: workspace/<project>/explainer/ (explainroo's own folder) + explainer.json (the inputs).
 */

export interface ExplainerInput {
  topic: string;
  title?: string;
  /** Points / facts to cover, one per line (the only facts the script may state). */
  points: string[];
  sources?: string[];
  /** Target seconds (45-180). */
  seconds?: number;
  theme?: string;
}

export interface ExplainerScene {
  id: string;
  text: string;
  chapter?: string;
}

export type Ask = (system: string, user: string, schema: "script" | "code") => Promise<unknown>;

export const explainerDir = (project: string) => path.join(paths.workspace, project, "explainer");
const inputFile = (project: string) => path.join(paths.workspace, project, "explainer.json");
export const THEMES = ["paper", "clean", "chalk", "blueprint", "midnight", "editorial"];

export function saveExplainerInput(project: string, i: ExplainerInput): ExplainerInput {
  const topic = String(i.topic ?? "").trim();
  if (!topic) throw new Error("Please enter what the video explains.");
  const points = (i.points ?? []).map((p) => String(p).trim()).filter(Boolean).slice(0, 30);
  if (!points.length) throw new Error("Add at least one point the video must explain (one per line).");
  const clean: ExplainerInput = {
    topic: topic.slice(0, 160),
    title: (i.title ?? "").trim().slice(0, 100) || topic.slice(0, 100),
    points,
    sources: (i.sources ?? []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)).slice(0, 20),
    seconds: Math.max(45, Math.min(180, Math.round(Number(i.seconds) || 90))),
    theme: THEMES.includes(String(i.theme)) ? String(i.theme) : loadFeatures().formats.explainerTheme,
  };
  fs.mkdirSync(path.dirname(inputFile(project)), { recursive: true });
  fs.writeFileSync(inputFile(project), JSON.stringify(clean, null, 2));
  return clean;
}

export const readExplainerInput = (project: string): ExplainerInput | null =>
  fs.existsSync(inputFile(project)) ? (JSON.parse(fs.readFileSync(inputFile(project), "utf8")) as ExplainerInput) : null;

/** "How DNS works!" -> "how-dns-works": a valid JS method name and scene id. */
export const sceneId = (s: string, i: number) => {
  const id = s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 30);
  return /^[a-z]/.test(id) ? id : `scene_${i + 1}${id ? `_${id}` : ""}`;
};

/** script.md in explainroo's syntax (## id {chapter="..."} + narration with [#markers]). */
export function scriptMd(title: string, scenes: ExplainerScene[]): string {
  const esc = (s: string) => s.replace(/"/g, "'").slice(0, 60);
  return [`# ${title.replace(/\n/g, " ")}`, "", ...scenes.flatMap((s) => [`## ${s.id}${s.chapter ? ` {chapter="${esc(s.chapter)}"}` : ""}`, s.text.replace(/\s+/g, " ").trim(), ""])].join("\n");
}

/** Reads script.md back (the creator may edit it): scene ids and narration. */
export function parseScriptMd(md: string): { title: string; scenes: ExplainerScene[] } {
  const title = (md.match(/^#\s+(.+)$/m)?.[1] ?? "").trim();
  const scenes: ExplainerScene[] = [];
  let cur: ExplainerScene | null = null;
  for (const line of md.split(/\r?\n/)) {
    const h = line.match(/^##\s+([A-Za-z_][\w-]*)\s*(\{.*\})?\s*$/);
    if (h) {
      cur = { id: h[1], text: "", ...(h[2]?.match(/chapter="([^"]*)"/) ? { chapter: h[2].match(/chapter="([^"]*)"/)![1] } : {}) };
      scenes.push(cur);
    } else if (cur && line.trim() && !line.startsWith(">")) cur.text = `${cur.text} ${line.trim()}`.trim();
  }
  return { title, scenes };
}

const FORBIDDEN = /\b(require|import|process|fetch|XMLHttpRequest|WebSocket|eval|Function|globalThis|window|document|localStorage|sessionStorage|indexedDB|navigator|location|setTimeout|setInterval|Worker)\b|while\s*\(\s*true\s*\)|for\s*\(\s*;\s*;\s*\)/;

/** A scene body is safe to hand to explainroo: no I/O or browser globals, no endless loop, compiles. */
export function checkSceneCode(body: string): string | null {
  if (body.length > 6000) return "too long";
  // Words inside '...' / "..." are on-screen text ("Your location"), not code. Template strings stay
  // scanned: ${...} inside them is code.
  const code = body.replace(/'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"/g, '""');
  const bad = code.match(FORBIDDEN);
  if (bad) return `uses "${bad[0]}" (not allowed in a scene)`;
  try {
    // Compiles only; never called here.
    new Function("s", body);
  } catch (err) {
    return `does not compile: ${(err as Error).message}`;
  }
  return null;
}

export function scenesJs(bodies: Record<string, string>): string {
  return [
    "// Written by ClipForge's AI for explainroo (one function per scene in script.md).",
    "export default {",
    ...Object.entries(bodies).map(([id, body]) => `  ${id}(s) {\n${body.split("\n").map((l) => `    ${l}`).join("\n")}\n  },`),
    "};",
    "",
  ].join("\n");
}

/** A plain fallback scene: title + the narration's key words as a list (always valid). */
export function fallbackScene(scene: ExplainerScene, index: number): string {
  const words = scene.text.replace(/\[[^\]]*\]|\{[^|}]*\|[^}]*\}/g, " ").split(/[.!?]/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
  const items = JSON.stringify(words.map((w) => (w.length > 48 ? `${w.slice(0, 45)}...` : w)));
  return index === 0
    ? `s.title(${JSON.stringify(words[0]?.slice(0, 40) ?? "")}, { at: 0 });`
    : `s.list(${items}, { x: s.safe.x + 80, y: s.safe.y + 140, at: 0.3, stagger: 1.2 });`;
}

export const SCRIPT_RULES = [
  "Write narration for an explainer video, the way a person explains something to a friend at a table.",
  "Short sentences (8 to 18 words), one idea each, everyday words; explain a technical word the first time.",
  "Start with the question or problem, explain in small steps, give one concrete example, end with one plain sentence that sums up.",
  "One idea per scene, 1 to 3 sentences. Put a marker like [#name] (letters only) wherever a picture should change; every sentence gets at least one.",
  "Write acronyms the voice may misread as {API|A, P, I}. No em dashes, no slogans, no 'let's dive in', no filler words (just, simply, really, actually).",
  "Use ONLY the facts in the creator's points. Never add numbers, names, dates or claims that are not there.",
].join("\n");

export const API_SHEET = `explainroo Scene API (the canvas is 1920x1080; x/y are centers in px; s.safe = {x,y,w,h} free area):
- Timing: every element takes at (seconds, a spoken word, or "#marker") and optional out. Always call elements; never wrap them in if(...).
- s.title(text,{at}) big heading; s.subtitle(text,{at,y}); s.text(text,{x,y,size,at,color,bold}) (*word* = accent colour); s.note(text,{x,y,at})
- s.box(label,{id,x,y,icon,color,at}) card; s.circle({id,x,y,r,label,at}); s.arrow(fromId,toId,{label,at}) (ids drawn earlier in the same scene)
- s.icon(lucideName,{x,y,size,color,label,at}) e.g. "globe","server","database","lock","user","search","send","check","x","zap","clock","dollar-sign","shield","cpu","cloud","mail","file","heart","star","trending-up"
- s.list(items,{x,y,at,stagger,bullet}) (x = left edge, y = top); s.number(value,{prefix,suffix,y,at}); s.bars([{label,value}],{at,suffix}); s.pie([{label,value}],{at})
- s.code(source,{lang,title,at}); s.terminal(["$ cmd","output"],{at}); s.annotate(id,{type:"underline"|"circle"|"box"|"highlight",at})
- Layout helpers: s.row(n,{width}) -> n x positions; s.col(n,{height}) -> n y positions; s.cx, s.cy centre.
- Colours: accent, ink, muted, red, orange, yellow, green, teal, blue, purple, pink, gray.
Rules: a marker or word used in at must be in that scene's narration; no element may appear after the scene ends; no variables kept between frames; no random except s.rand(i).`;

const ScriptOut = z.object({ title: z.string(), scenes: z.array(z.object({ id: z.string(), chapter: z.string().optional(), text: z.string() })) });
const CodeOut = z.object({ scenes: z.array(z.object({ id: z.string(), body: z.string() })) });

const modelAsk: Ask = async (system, user, schema) => {
  const res = await withStage("script", () =>
    llm().messages.parse({
      model: env("LLM_MODEL", "claude-haiku-4-5"),
      max_tokens: 6000,
      output_config: { format: zodOutputFormat(schema === "script" ? ScriptOut : CodeOut) },
      system,
      messages: [{ role: "user", content: user }],
    }),
  );
  return res.parsed_output;
};

export interface WriteResult {
  scenes: number;
  /** Issues explainroo check still reports after the fix rounds. */
  open: { level: string; scene?: string; message: string }[];
  rounds: number;
  fallbacks: string[];
}

interface CheckIssue {
  level: string;
  scene?: string;
  t?: number | null;
  message: string;
}

/** explainroo check --json -> its issues (or one error describing why it did not run). */
export async function explainrooCheck(dir: string, o: { exec?: Exec; command?: string } = {}): Promise<CheckIssue[]> {
  const r = await runTool(o.command ?? loadFeatures().formats.explainroo, ["check", dir, "--json"], { exec: o.exec, timeoutMs: 20 * 60_000 });
  try {
    return (JSON.parse(r.stdout) as { issues?: CheckIssue[] }).issues ?? [];
  } catch {
    return [{ level: "error", message: `explainroo check did not run (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-300)}` }];
  }
}

/** Writes script.md (unless the creator already edited one and `keepScript`) and scenes.js, then the check / fix loop. */
export async function writeExplainer(project: string, o: { ask?: Ask; exec?: Exec; log?: (m: string) => void; keepScript?: boolean } = {}): Promise<WriteResult> {
  const log = o.log ?? console.log;
  const input = readExplainerInput(project);
  if (!input) throw new Error("No explainer inputs (explainer.json): create the video first.");
  const f = loadFeatures().formats;
  const ask = o.ask ?? (llmAvailable() ? modelAsk : null);
  if (!ask) throw new Error("No AI model is set up (start Ollama or add an API key): the explainer is written by the AI.");
  if (!o.ask) await requireAi();
  const dir = explainerDir(project);
  if (!fs.existsSync(path.join(dir, "video.json"))) {
    const r = await runTool(f.explainroo, ["init", dir, "--theme", input.theme ?? f.explainerTheme, "--title", input.title ?? input.topic], { exec: o.exec, timeoutMs: 120_000 });
    if (r.code !== 0) throw new Error(`explainroo init failed (is explainroo installed? Tools > Explainer): ${(r.stderr || r.stdout).trim().slice(-300)}`);
    log(`[explainer] project created in ${dir}`);
  }
  const scriptFile = path.join(dir, "script.md");

  // 1. narration
  let title = input.title ?? input.topic;
  let scenes: ExplainerScene[];
  // The creator edited script.md (PUT /api/make/:p/script leaves .script-edited): keep their words.
  const keep = o.keepScript ?? fs.existsSync(path.join(dir, ".script-edited"));
  const own = keep && fs.existsSync(scriptFile) ? parseScriptMd(fs.readFileSync(scriptFile, "utf8")) : null;
  if (own?.scenes.length) {
    ({ title, scenes } = own);
    log(`[explainer] using the edited script (${scenes.length} scenes)`);
  } else {
    const words = Math.round(((input.seconds ?? 90) / 60) * 150);
    const out = ScriptOut.parse(await ask(SCRIPT_RULES, `Topic: ${input.topic}\nTitle: ${title}\nLength: about ${words} words in total, 5 to 9 scenes.\nPoints to explain (the only facts you may use):\n${input.points.map((p) => `- ${p}`).join("\n")}\n\nAnswer with a title and the scenes (id: one or two lowercase words; chapter: a short heading for longer videos, optional).`, "script"));
    title = out.title.trim() || title;
    scenes = out.scenes.filter((s) => s.text.trim()).map((s, i) => ({ id: sceneId(s.id, i), text: s.text.trim(), ...(s.chapter ? { chapter: s.chapter.trim().slice(0, 60) } : {}) }));
    // Unique ids (explainroo maps each to a function).
    const seen = new Set<string>();
    for (const s of scenes) {
      let id = s.id;
      for (let k = 2; seen.has(id); k++) id = `${s.id}_${k}`;
      s.id = id;
      seen.add(id);
    }
    if (!scenes.length) throw new Error("The AI returned no scenes.");
    fs.writeFileSync(scriptFile, scriptMd(title, scenes), "utf8");
    fs.writeFileSync(path.join(dir, ".clipforge-script"), new Date().toISOString());
    log(`[explainer] script.md: ${scenes.length} scenes, ${scenes.reduce((n, s) => n + s.text.split(/\s+/).length, 0)} words`);
  }

  // 2. drawing code, 3. check / fix rounds
  const bodies: Record<string, string> = {};
  const fallbacks: string[] = [];
  const askCode = async (extra: string, only?: Set<string>) => {
    const want = scenes.filter((s) => !only || only.has(s.id));
    const res = CodeOut.parse(await ask(`You write the drawing code of an explainer video.\n${API_SHEET}`, `${extra}Write the body of each scene function (the code inside { }, using s). Scenes:\n${want.map((s) => `## ${s.id}\n${s.text}`).join("\n\n")}`, "code"));
    for (const sc of want) {
      const body = res.scenes.find((x) => x.id === sc.id)?.body ?? "";
      const bad = body.trim() ? checkSceneCode(body) : "empty";
      if (bad) {
        log(`[explainer] scene ${sc.id}: AI code refused (${bad}); a simple list is used instead`);
        bodies[sc.id] = fallbackScene(sc, scenes.indexOf(sc));
        if (!fallbacks.includes(sc.id)) fallbacks.push(sc.id);
      } else bodies[sc.id] = body.trim();
    }
  };
  await askCode("");
  const write = () => fs.writeFileSync(path.join(dir, "scenes.js"), scenesJs(Object.fromEntries(scenes.map((s) => [s.id, bodies[s.id]]))), "utf8");
  write();
  let issues = await explainrooCheck(dir, { exec: o.exec, command: f.explainroo });
  let rounds = 0;
  while (issues.some((i) => i.level === "error") && rounds < f.fixRounds) {
    rounds++;
    const broken = new Set(issues.filter((i) => i.level === "error" && i.scene).map((i) => i.scene!));
    if (!broken.size) break; // a project-level error the AI cannot fix (install, voice model ...)
    log(`[explainer] check round ${rounds}: ${broken.size} scene(s) with errors, asking the AI to fix them`);
    const notes = issues.filter((i) => i.scene && broken.has(i.scene)).map((i) => `- ${i.scene}${i.t != null ? ` @${i.t}s` : ""}: ${i.message}`).join("\n");
    await askCode(`explainroo check found these errors; fix them:\n${notes}\nCurrent code:\n${[...broken].map((id) => `## ${id}\n${bodies[id]}`).join("\n\n")}\n\n`, broken);
    write();
    issues = await explainrooCheck(dir, { exec: o.exec, command: f.explainroo });
  }
  // A scene still broken after the rounds gets the plain fallback, so the video can render.
  const still = new Set(issues.filter((i) => i.level === "error" && i.scene).map((i) => i.scene!));
  if (still.size) {
    for (const id of still) {
      const sc = scenes.find((s) => s.id === id);
      if (!sc) continue;
      bodies[id] = fallbackScene(sc, scenes.indexOf(sc));
      if (!fallbacks.includes(id)) fallbacks.push(id);
    }
    write();
    issues = await explainrooCheck(dir, { exec: o.exec, command: f.explainroo });
  }
  const open = issues.filter((i) => i.level !== "hint").map((i) => ({ level: i.level, scene: i.scene, message: i.message }));
  fs.writeFileSync(path.join(dir, "clipforge_check.json"), JSON.stringify({ rounds, fallbacks, open, at: new Date().toISOString() }, null, 2));
  log(`[explainer] ${scenes.length} scenes, ${rounds} fix round(s), ${fallbacks.length} plain fallback scene(s), ${open.filter((i) => i.level === "error").length} error(s) and ${open.filter((i) => i.level !== "error").length} warning(s) left`);
  return { scenes: scenes.length, open, rounds, fallbacks };
}

/** Voice + render + verify; the MP4 (and its subtitles / chapters) land in output/. */
export async function renderExplainer(project: string, o: { exec?: Exec; log?: (m: string) => void } = {}): Promise<{ file: string; verify: string }> {
  const log = o.log ?? console.log;
  const f = loadFeatures().formats;
  const dir = explainerDir(project);
  if (!fs.existsSync(path.join(dir, "scenes.js"))) throw new Error("Write the explainer first.");
  const v = await runTool(f.explainroo, ["voice", dir], { exec: o.exec, timeoutMs: 60 * 60_000 });
  if (v.code !== 0) throw new Error(`explainroo voice failed: ${(v.stderr || v.stdout).trim().slice(-300)}`);
  log(`[explainer] voice:\n${v.stdout.trim().slice(-800)}`);
  fs.mkdirSync(paths.output, { recursive: true });
  const out = path.join(paths.output, `${project}.mp4`);
  const r = await runTool(f.explainroo, ["render", dir, "--out", out], { exec: o.exec, timeoutMs: 3 * 60 * 60_000 });
  if (r.code !== 0 || !fs.existsSync(out)) throw new Error(`explainroo render failed: ${(r.stderr || r.stdout).trim().slice(-300)}`);
  const ver = await runTool(f.explainroo, ["verify", dir, "--file", out], { exec: o.exec, timeoutMs: 30 * 60_000 });
  log(`[explainer] ${out}\n[explainer] verify: ${ver.stdout.trim().slice(-600)}`);
  return { file: out, verify: ver.stdout.trim() };
}
