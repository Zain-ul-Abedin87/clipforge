import fs from "node:fs";
import path from "node:path";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { run } from "../exec.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";
import { withStage } from "../models/loader.js";
import { paths } from "../paths.js";
import { loadFeatures } from "../settings/features.js";
import { ffmpegPath, ffprobePath } from "../tools.js";
import { Exec, requireAi, runTool } from "./tool.js";

/**
 * Tutorial / screen-demo videos from the creator's own screen recording, finished by argo
 * (github.com/shreyaskarnik/argo, MIT, npm @argo-video/cli) through its import route:
 *   1. ClipForge finds where the picture changes (FFmpeg scene detection) -> scenes;
 *   2. the AI writes a voice-over per scene from the creator's notes, short enough to fit the scene
 *      (features.json formats.wordsPerSec); the creator edits it;
 *   3. `argo import <recording> --demo tutorial --force`, ClipForge writes demos/tutorial.scenes.json
 *      (scene + text) and .argo/tutorial/.timing.json (scene -> ms), then `argo tts generate` and
 *      `argo export tutorial` -> videos/tutorial.mp4 -> output/<project>.mp4.
 * Formats and commands are taken from argo's source (src/import.ts, src/cli.ts).
 */

export interface TutorialInput {
  topic: string;
  /** What the recording shows / what the voice should explain (the only facts it may state). */
  notes: string;
  /** File name in workspace/<project>/tutorial/. */
  recording?: string;
}

export interface TutorialScene {
  id: string;
  start: number;
  end: number;
  text: string;
}

export const tutorialDir = (project: string) => path.join(paths.workspace, project, "tutorial");
const inputFile = (project: string) => path.join(paths.workspace, project, "tutorial.json");
const scenesFile = (project: string) => path.join(tutorialDir(project), "scenes.clipforge.json");
export const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv"]);

export function saveTutorialInput(project: string, i: TutorialInput): TutorialInput {
  const topic = String(i.topic ?? "").trim();
  if (!topic) throw new Error("Please enter what the tutorial is about.");
  const notes = String(i.notes ?? "").trim();
  if (notes.split(/\s+/).length < 5) throw new Error("Write a few sentences about what the recording shows (the voice-over is written from them).");
  const prev = readTutorialInput(project);
  const clean: TutorialInput = { topic: topic.slice(0, 160), notes: notes.slice(0, 4000), ...(prev?.recording ? { recording: prev.recording } : {}) };
  fs.mkdirSync(tutorialDir(project), { recursive: true });
  fs.writeFileSync(inputFile(project), JSON.stringify(clean, null, 2));
  return clean;
}

export const readTutorialInput = (project: string): TutorialInput | null =>
  fs.existsSync(inputFile(project)) ? (JSON.parse(fs.readFileSync(inputFile(project), "utf8")) as TutorialInput) : null;

export function setRecording(project: string, fileName: string): void {
  const i = readTutorialInput(project);
  if (!i) throw new Error("Create the tutorial first.");
  fs.writeFileSync(inputFile(project), JSON.stringify({ ...i, recording: fileName }, null, 2));
  fs.rmSync(scenesFile(project), { force: true });
}

export const recordingPath = (project: string): string | null => {
  const r = readTutorialInput(project)?.recording;
  const f = r ? path.join(tutorialDir(project), path.basename(r)) : null;
  return f && fs.existsSync(f) ? f : null;
};

/**
 * Picture-change times -> scenes: always one at 0, each at least minSec long (also the last one),
 * at most `max` scenes (the strongest changes win).
 */
export function scenesFromChanges(changes: { t: number; score: number }[], duration: number, minSec: number, max = 20): { start: number; end: number }[] {
  const picked: number[] = [];
  for (const c of [...changes].sort((a, b) => b.score - a.score)) {
    if (picked.length >= max - 1) break;
    if (c.t < minSec || duration - c.t < minSec) continue;
    if (picked.some((p) => Math.abs(p - c.t) < minSec)) continue;
    picked.push(c.t);
  }
  const starts = [0, ...picked.sort((a, b) => a - b)];
  return starts.map((s, i) => ({ start: Math.round(s * 100) / 100, end: Math.round((starts[i + 1] ?? duration) * 100) / 100 }));
}

/** FFmpeg scene scores of the recording (select + showinfo); duration from ffprobe. */
export async function pictureChanges(file: string, threshold: number): Promise<{ changes: { t: number; score: number }[]; duration: number }> {
  const ff = ffmpegPath();
  const fp = ffprobePath();
  if (!ff || !fp) throw new Error("FFmpeg not found");
  const d = await run(fp, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  const duration = Number(d.stdout.trim());
  if (!(duration > 0)) throw new Error("the recording has no readable length");
  const r = await run(ff, ["-hide_banner", "-nostats", "-i", file, "-an", "-vf", `scale=320:-2,select='gt(scene,${threshold})',metadata=print`, "-f", "null", "-"], { timeoutMs: 30 * 60_000 });
  const changes: { t: number; score: number }[] = [];
  let t: number | null = null;
  for (const line of r.stderr.split(/\r?\n/)) {
    const pt = line.match(/pts_time:([\d.]+)/);
    if (pt) t = Number(pt[1]);
    const sc = line.match(/lavfi\.scene_score=([\d.]+)/);
    if (sc && t !== null) changes.push({ t, score: Number(sc[1]) });
  }
  return { changes, duration };
}

/** Keeps whole sentences up to `max` words (a scene's voice must end before the next scene). */
export function fitWords(text: string, max: number): { text: string; cut: boolean } {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return { text: words.join(" "), cut: false };
  const sentences = text.trim().split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of sentences) {
    const next = `${out} ${s}`.trim();
    if (next.split(/\s+/).length > max) break;
    out = next;
  }
  if (!out) out = `${words.slice(0, max).join(" ").replace(/[,;:]$/, "")}.`;
  return { text: out, cut: true };
}

export type Ask = (system: string, user: string) => Promise<{ scenes: { id: string; text: string }[] }>;
const Out = z.object({ scenes: z.array(z.object({ id: z.string(), text: z.string() })) });
const modelAsk: Ask = async (system, user) => {
  const res = await withStage("script", () =>
    llm().messages.parse({ model: env("LLM_MODEL", "claude-haiku-4-5"), max_tokens: 4000, output_config: { format: zodOutputFormat(Out) }, system, messages: [{ role: "user", content: user }] }),
  );
  return res.parsed_output ?? { scenes: [] };
};

export function readTutorialScenes(project: string): TutorialScene[] {
  return fs.existsSync(scenesFile(project)) ? (JSON.parse(fs.readFileSync(scenesFile(project), "utf8")) as { scenes: TutorialScene[] }).scenes : [];
}

/** The creator's edited voice-over (only the text changes; times stay ClipForge's). */
export function saveTutorialScenes(project: string, texts: Record<string, string>): TutorialScene[] {
  const wps = loadFeatures().formats.wordsPerSec;
  const scenes = readTutorialScenes(project).map((s) => (typeof texts[s.id] === "string" ? { ...s, text: texts[s.id].replace(/\s+/g, " ").trim() } : s));
  fs.writeFileSync(scenesFile(project), JSON.stringify({ scenes, wordsPerSec: wps, editedAt: new Date().toISOString() }, null, 2));
  return scenes;
}

export const tooLong = (s: TutorialScene, wps = loadFeatures().formats.wordsPerSec) => s.text.split(/\s+/).filter(Boolean).length > Math.floor((s.end - s.start) * wps);

/** Scenes from the recording + a voice-over per scene written by the AI from the creator's notes. */
export async function writeTutorial(project: string, o: { ask?: Ask; log?: (m: string) => void; changes?: { changes: { t: number; score: number }[]; duration: number } } = {}): Promise<TutorialScene[]> {
  const log = o.log ?? console.log;
  const input = readTutorialInput(project);
  const rec = recordingPath(project);
  if (!input || !rec) throw new Error("Upload the screen recording first.");
  const f = loadFeatures().formats;
  const ask = o.ask ?? (llmAvailable() ? modelAsk : null);
  if (!ask) throw new Error("No AI model is set up (start Ollama or add an API key): the voice-over is written by the AI.");
  if (!o.ask) await requireAi();
  const pc = o.changes ?? (await pictureChanges(rec, f.sceneThreshold));
  const spans = scenesFromChanges(pc.changes, pc.duration, f.minSceneSec);
  log(`[tutorial] ${spans.length} scene(s) in ${pc.duration.toFixed(1)} s of recording (${pc.changes.length} picture change(s) found)`);
  const ids = spans.map((_, i) => `s${i + 1}`);
  const res = await ask(
    [
      "You write the voice-over of a screen-recording tutorial, scene by scene.",
      "Plain spoken English, short sentences, second person ('click', 'you will see'). No filler, no 'let's dive in'.",
      "Use only what the creator's notes say. Never invent buttons, menu names, numbers or results.",
      "Each scene has a word limit: stay under it, because the voice must end before the picture changes.",
    ].join("\n"),
    `Tutorial: ${input.topic}\nCreator's notes:\n${input.notes}\n\nScenes (in order):\n${spans.map((s, i) => `${ids[i]}: ${s.start.toFixed(1)}-${s.end.toFixed(1)} s, at most ${Math.max(3, Math.floor((s.end - s.start) * f.wordsPerSec))} words`).join("\n")}\n\nAnswer with one text per scene id.`,
  );
  const scenes = spans.map((s, i) => {
    const raw = res.scenes.find((x) => x.id === ids[i])?.text ?? "";
    const fit = fitWords(raw, Math.max(3, Math.floor((s.end - s.start) * f.wordsPerSec)));
    if (fit.cut) log(`[tutorial] ${ids[i]}: voice-over shortened to fit ${(s.end - s.start).toFixed(1)} s`);
    return { id: ids[i], ...s, text: fit.text };
  });
  fs.writeFileSync(scenesFile(project), JSON.stringify({ scenes, wordsPerSec: f.wordsPerSec, at: new Date().toISOString() }, null, 2));
  return scenes;
}

/** argo import -> manifests -> tts -> export; the MP4 lands in output/<project>.mp4. */
export async function renderTutorial(project: string, o: { exec?: Exec; log?: (m: string) => void } = {}): Promise<{ file: string }> {
  const log = o.log ?? console.log;
  const f = loadFeatures().formats;
  const dir = tutorialDir(project);
  const rec = recordingPath(project);
  const scenes = readTutorialScenes(project).filter((s) => s.text.trim());
  if (!rec || !scenes.length) throw new Error("Write the voice-over first.");
  const step = async (args: string[], what: string, minutes: number) => {
    const r = await runTool(f.argo, args, { exec: o.exec, cwd: dir, timeoutMs: minutes * 60_000 });
    if (r.code !== 0) throw new Error(`argo ${what} failed (is argo installed? Tools > Tutorial): ${(r.stderr || r.stdout).trim().slice(-300)}`);
    return r;
  };
  await step(["import", path.basename(rec), "--demo", "tutorial", "--force"], "import", 10);
  fs.mkdirSync(path.join(dir, "demos"), { recursive: true });
  fs.writeFileSync(path.join(dir, "demos", "tutorial.scenes.json"), JSON.stringify(scenes.map((s) => ({ scene: s.id, text: s.text })), null, 2) + "\n");
  fs.mkdirSync(path.join(dir, ".argo", "tutorial"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".argo", "tutorial", ".timing.json"), JSON.stringify(Object.fromEntries(scenes.map((s) => [s.id, Math.round(s.start * 1000)])), null, 2) + "\n");
  log(`[tutorial] ${scenes.length} scene(s) handed to argo`);
  await step(["tts", "generate", "demos/tutorial.scenes.json"], "tts", 60);
  await step(["export", "tutorial"], "export", 120);
  const made = path.join(dir, "videos", "tutorial.mp4");
  if (!fs.existsSync(made)) throw new Error(`argo export wrote no ${made}`);
  fs.mkdirSync(paths.output, { recursive: true });
  const out = path.join(paths.output, `${project}.mp4`);
  fs.copyFileSync(made, out);
  for (const ext of [".srt", ".vtt"]) {
    const sub = path.join(dir, "videos", `tutorial${ext}`);
    if (fs.existsSync(sub)) fs.copyFileSync(sub, path.join(paths.output, `${project}${ext}`));
  }
  log(`[tutorial] ${out}`);
  return { file: out };
}
