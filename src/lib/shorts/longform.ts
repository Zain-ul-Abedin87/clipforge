import fs from "node:fs";
import path from "node:path";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { readJson, writeJson } from "../project.js";
import { loadFeatures } from "../settings/features.js";
import { isCaptionPreset } from "../render/captionPresets.js";
import { ffprobePath, venvPythonPath } from "../tools.js";
import { pickShorts, TimedSentence } from "./pick.js";
import { cropKeyframes, FaceSample, Reframe, ShortFormat } from "./reframe.js";
import { renderShort, Word } from "./render.js";

/**
 * Long video -> Shorts (a podcast, a vlog, a stream: 10 minutes to 3 hours). The creator uploads the
 * video (and confirms it is theirs or they have permission); Whisper times every word
 * (transcribe + align, the normal steps); this module then
 *   find:   the count follows the length (features.json clips.perHour, at most clips.maxClips); the
 *           Shorts picker scores every opening sentence as a hook + whether it stands alone, and the
 *           best non-overlapping windows win, ranked by that score;
 *   render: each pick in the chosen shape (9:16 / 1:1 / 16:9), reframed (smart = the crop follows
 *           the speaker's face, python/face_track.py; fit = whole frame over a blur), with captions
 *           -> output/<project>_clip_<rank>.mp4.
 * The score is a hook / stands-alone score from the model and simple rules, not a promise of views.
 */

export interface ClipsInput {
  topic: string;
  /** File name in workspace/<project>/clips/. */
  source?: string;
  /** The creator confirmed the video is theirs or that they have permission. */
  rights: boolean;
  language: string;
  format: ShortFormat;
  reframe: Reframe;
  captionPreset: string;
  captions: boolean;
}

export interface Clip {
  rank: number;
  start: number;
  end: number;
  score: number;
  hook: string;
  title?: string;
  text: string;
  file?: string;
  reframed?: string;
  error?: string;
}

export const clipsDir = (project: string) => path.join(paths.workspace, project, "clips");
const inputFile = (project: string) => path.join(paths.workspace, project, "clips.json");
const resultFile = (project: string) => path.join(paths.workspace, project, "clips_result.json");
export const LONG_VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const FORMATS: ShortFormat[] = ["9:16", "1:1", "16:9"];
const REFRAMES: Reframe[] = ["smart", "center", "fit"];

export function saveClipsInput(project: string, i: Partial<ClipsInput>): ClipsInput {
  if (i.rights !== true) throw new Error("Confirm that the video is yours or that you have permission to cut it (someone else's video can get a copyright claim).");
  const f = loadFeatures().clips;
  const prev = readClipsInput(project);
  const clean: ClipsInput = {
    topic: String(i.topic ?? "").trim().slice(0, 160) || "Shorts",
    ...(prev?.source ? { source: prev.source } : {}),
    rights: true,
    language: /^[a-z]{2}$/.test(String(i.language)) ? String(i.language) : "en",
    format: FORMATS.includes(i.format as ShortFormat) ? (i.format as ShortFormat) : (f.format as ShortFormat),
    reframe: REFRAMES.includes(i.reframe as Reframe) ? (i.reframe as Reframe) : (f.reframe as Reframe),
    captionPreset: isCaptionPreset(i.captionPreset) ? i.captionPreset : isCaptionPreset(f.captionPreset) ? f.captionPreset : "bold-pop",
    captions: i.captions !== false,
  };
  fs.mkdirSync(clipsDir(project), { recursive: true });
  writeJson(inputFile(project), clean);
  return clean;
}

export const readClipsInput = (project: string): ClipsInput | null => (fs.existsSync(inputFile(project)) ? readJson<ClipsInput>(inputFile(project)) : null);

export function setClipsSource(project: string, fileName: string): void {
  const i = readClipsInput(project);
  if (!i) throw new Error("Create the Shorts project first.");
  writeJson(inputFile(project), { ...i, source: fileName });
  fs.rmSync(resultFile(project), { force: true });
  // A new video: the old word timings belong to the old one.
  for (const f of ["words.json", "aligned.json"]) fs.rmSync(path.join(paths.workspace, project, f), { force: true });
}

export const clipsSource = (project: string): string | null => {
  const s = readClipsInput(project)?.source;
  const f = s ? path.join(clipsDir(project), path.basename(s)) : null;
  return f && fs.existsSync(f) ? f : null;
};

export const readClips = (project: string): { duration: number; clips: Clip[] } | null => (fs.existsSync(resultFile(project)) ? readJson(resultFile(project)) : null);

/** How many Shorts a video of `seconds` gets. */
export const clipCount = (seconds: number, perHour: number, max: number) => Math.max(1, Math.min(max, Math.ceil((seconds / 3600) * perHour)));

/** aligned.json -> sentences with their times (the source video's own time). */
export function sentencesOf(dir: string): { sentences: TimedSentence[]; words: Word[] } {
  const a = readJson<{ words: Word[]; sentences?: { text: string; start: number; end: number }[] }>(path.join(dir, "aligned.json"));
  const sentences = (a.sentences ?? []).filter((s) => s.text.trim() && s.end > s.start).map((s) => ({ text: s.text, start: s.start, end: s.end }));
  return { sentences, words: a.words };
}

export async function findClips(project: string, o: { log?: (m: string) => void; duration?: number } = {}): Promise<Clip[]> {
  const log = o.log ?? console.log;
  const dir = path.join(paths.workspace, project);
  const src = clipsSource(project);
  if (!src) throw new Error("Upload the long video first.");
  if (!fs.existsSync(path.join(dir, "aligned.json"))) throw new Error("The word timings are missing: run the transcription first.");
  const f = loadFeatures().clips;
  const duration = o.duration ?? (await probe(src)).duration;
  const { sentences } = sentencesOf(dir);
  const count = clipCount(duration, f.perHour, f.maxClips);
  log(`[clips] ${(duration / 60).toFixed(1)} min of video, ${sentences.length} sentence(s): looking for ${count} Short(s) of ${f.minSec}-${f.maxSec} s`);
  const picks = await pickShorts(sentences, { count, minSec: f.minSec, maxSec: Math.min(f.maxSec, 180), spread: true, log });
  const clips: Clip[] = [...picks].sort((a, b) => b.score - a.score || a.start - b.start).map((p, i) => ({ rank: i + 1, start: p.start, end: p.end, score: p.score, hook: p.hook, title: p.title, text: p.text }));
  writeJson(resultFile(project), { duration, clips });
  log(`[clips] ${clips.length} Short(s) found; best: ${clips.slice(0, 3).map((c) => `#${c.rank} ${c.start.toFixed(0)}s score ${c.score}`).join(", ")}`);
  return clips;
}

async function probe(file: string): Promise<{ duration: number; width: number; height: number }> {
  const fp = ffprobePath();
  if (!fp) throw new Error("ffprobe not found");
  const r = await run(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]);
  const j = JSON.parse(r.stdout || "{}") as { streams?: { width: number; height: number }[]; format?: { duration?: string } };
  return { duration: Number(j.format?.duration ?? 0), width: j.streams?.[0]?.width ?? 0, height: j.streams?.[0]?.height ?? 0 };
}

export type FaceTracker = (video: string, start: number, dur: number) => Promise<FaceSample[] | null>;

/** python/face_track.py through the project's Python (null when it cannot run: the Short falls back to fit). */
export const pythonFaces: FaceTracker = async (video, start, dur) => {
  const py = venvPythonPath() ?? "python";
  const r = await run(py, [path.join(paths.python, "face_track.py"), video, start.toFixed(3), dur.toFixed(3), "0.5"], { timeoutMs: 5 * 60_000 });
  try {
    const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}") as { ok?: boolean; samples?: FaceSample[] };
    return j.ok ? j.samples ?? [] : null;
  } catch {
    return null;
  }
};

export type ShortRenderer = typeof renderShort;

/** Renders the found Shorts (all, or the given ranks) in the project's shape / reframe / captions. */
export async function renderClips(project: string, o: { ranks?: number[]; faces?: FaceTracker; render?: ShortRenderer; size?: { width: number; height: number }; log?: (m: string) => void } = {}): Promise<Clip[]> {
  const log = o.log ?? console.log;
  const input = readClipsInput(project);
  const src = clipsSource(project);
  const res = readClips(project);
  if (!input || !src || !res) throw new Error("Find the Shorts first.");
  const dir = path.join(paths.workspace, project);
  const { words } = sentencesOf(dir);
  const size = o.size ?? (await probe(src));
  const maxSec = Math.min(loadFeatures().clips.maxSec, 180);
  fs.mkdirSync(paths.output, { recursive: true });
  for (const c of res.clips) {
    if (o.ranks && !o.ranks.includes(c.rank)) continue;
    const dur = Math.min(c.end - c.start, maxSec);
    let keys: { t: number; x: number }[] | null = null;
    let used: string = input.reframe;
    if (input.reframe === "smart") {
      const samples = await (o.faces ?? pythonFaces)(src, c.start, dur);
      keys = samples ? cropKeyframes(samples, size.width, size.height, input.format) : null;
      if (!keys) used = samples ? "fit (too few faces seen)" : "fit (face tracker not available)";
    }
    const out = path.join(paths.output, `${project}_clip_${c.rank}.mp4`);
    try {
      const t0 = Date.now();
      await (o.render ?? renderShort)(src, { start: c.start, end: c.end }, words, out, { captions: input.captions, preset: input.captionPreset, maxSec, frame: { format: input.format, reframe: keys ? "smart" : input.reframe === "smart" ? "fit" : input.reframe, srcW: size.width, srcH: size.height, keys } });
      Object.assign(c, { file: path.basename(out), reframed: used, error: undefined });
      log(`[clips] #${c.rank} ${input.format} ${used} ${dur.toFixed(1)} s in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path.basename(out)}`);
    } catch (err) {
      c.error = String((err as Error).message).slice(0, 300);
      log(`[clips] #${c.rank} failed: ${c.error}`);
    }
  }
  writeJson(resultFile(project), res);
  return res.clips;
}
