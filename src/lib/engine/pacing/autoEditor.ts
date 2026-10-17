import { spawn } from "node:child_process";
import { boundariesToFrames, FrameRate, fromDecimal, FPS_30, frameToSeconds, toNumber, toRationalString } from "../../../domain/rational.math.js";

/**
 * Audio-driven pacing, after auto-editor's "audio" edit method (https://github.com/WyattBlue/auto-editor,
 * re-implemented here, no code copied): the voiceover is cut into per-frame loudness values (the
 * loudest sample in each video frame, 0..1), frames under a threshold are silent, a margin keeps a
 * little audio around speech, and very short silences / loud blips are ignored. The silences are
 * the natural cut points; words fill in where a sentence runs on. Every scene is then sliced into
 * 2.5-4 s micro-scenes on the frame grid (rational math, no drift).
 */

export interface AutoEditorOpts {
  fps?: FrameRate;
  /** Loudness threshold, fraction of full scale (auto-editor default 0.04). */
  threshold?: number;
  /** Seconds of audio kept around speech (auto-editor default 0.2). */
  margin?: number;
  /** Silences shorter than this are ignored. */
  minSilence?: number;
}

/** Loudest sample per video frame of a mono PCM signal (Int16), normalised to 0..1. */
export function frameLevels(samples: Int16Array, sampleRate: number, fps = 30): Float32Array {
  const per = sampleRate / fps;
  const n = Math.ceil(samples.length / per);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let peak = 0;
    const a = Math.floor(f * per);
    const b = Math.min(samples.length, Math.floor((f + 1) * per));
    for (let i = a; i < b; i++) {
      const v = Math.abs(samples[i]);
      if (v > peak) peak = v;
    }
    out[f] = peak / 32768;
  }
  return out;
}

/** Decodes any audio file to 8 kHz mono Int16 with FFmpeg and returns per-frame levels. */
export function audioLevels(ffmpeg: string, file: string, fps = 30, sampleRate = 8000): Promise<Float32Array> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-"], { windowsHide: true });
    const chunks: Buffer[] = [];
    let err = "";
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode ${file}: ${err.trim().slice(-200)}`));
      const buf = Buffer.concat(chunks);
      const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
      resolve(frameLevels(samples, sampleRate, fps));
    });
  });
}

/** Silent stretches (frame ranges [start, end)) after threshold, margin and minimum-length rules. */
export function silentRanges(levels: Float32Array, opts: AutoEditorOpts = {}): { start: number; end: number }[] {
  const fps = toNumber(opts.fps ?? FPS_30);
  const threshold = opts.threshold ?? 0.04;
  const margin = Math.round((opts.margin ?? 0.2) * fps);
  const minSilence = Math.max(1, Math.round((opts.minSilence ?? 0.15) * fps));
  // Loud frames, widened by the margin on both sides (speech onsets / tails stay audible).
  const loud = new Uint8Array(levels.length);
  levels.forEach((v, i) => {
    if (v < threshold) return;
    for (let k = Math.max(0, i - margin); k <= Math.min(levels.length - 1, i + margin); k++) loud[k] = 1;
  });
  const out: { start: number; end: number }[] = [];
  let i = 0;
  while (i < loud.length) {
    if (loud[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < loud.length && !loud[j]) j++;
    if (j - i >= minSilence) out.push({ start: i, end: j });
    i = j;
  }
  return out;
}

export interface TimedWord {
  word: string;
  start: number;
  end: number;
}

/** A 2.5-4 s piece of a scene, on the frame grid. */
export interface MicroCut {
  startFrame: number;
  endFrame: number;
  /** Exact times as "n/d" seconds (rational.math). */
  start: string;
  end: string;
  text: string;
}

export interface MicroOpts {
  fps?: FrameRate;
  minSec?: number;
  maxSec?: number;
  targetSec?: number;
}

/**
 * Slices [start, end) (seconds) into pieces of minSec..maxSec. Cut candidates, best first: the
 * middle of a silence (score 3), the start of a word after a sentence end (2), any word start (1).
 * Each step picks the candidate in [cur + min, cur + max] that best balances score and closeness
 * to the target; with no candidate it cuts at the target. A short tail is merged into the previous
 * piece (split in two again if that would exceed the maximum).
 */
export function microCuts(start: number, end: number, words: TimedWord[], silences: { start: number; end: number }[], opts: MicroOpts = {}): number[] {
  const min = opts.minSec ?? 2.5;
  const max = opts.maxSec ?? 4;
  const target = opts.targetSec ?? 3.2;
  const len = end - start;
  if (len <= max) return [];
  const cands: { t: number; score: number }[] = [];
  const fpsN = toNumber(opts.fps ?? FPS_30);
  for (const s of silences) {
    const t = (s.start + s.end) / 2 / fpsN;
    if (t > start && t < end) cands.push({ t, score: 3 });
  }
  words.forEach((w, k) => {
    if (w.start <= start || w.start >= end) return;
    const afterSentence = k > 0 && /[.!?]["')\]]*$/.test(words[k - 1].word);
    cands.push({ t: w.start, score: afterSentence ? 2 : 1 });
  });
  // Piece count first: as close to the target as possible while every piece can be min..max
  // (a greedy cut at the target can leave a 4.5 s tail that only splits into two 2.25 s pieces).
  const nMin = Math.ceil(len / max);
  const nMax = Math.floor(len / min);
  // Infeasible lengths (e.g. 4.0-5.0 s: one piece is > 4 s, two are < 2.5 s): take the count whose
  // pieces miss the range by less (4.1 s stays whole, 4.9 s becomes 2 x 2.45 s).
  const miss = (k: number) => Math.max(0, len / k - max, min - len / k);
  const n = nMin > nMax ? (Math.max(1, nMax) !== nMin && miss(Math.max(1, nMax)) <= miss(nMin) ? Math.max(1, nMax) : nMin) : Math.min(nMax, Math.max(nMin, Math.round(len / target)));
  if (n <= 1) return [];
  const cuts: number[] = [];
  let cur = start;
  for (let left = n; left > 1; left--) {
    // Window that keeps the remaining (left - 1) pieces feasible.
    const lo = Math.max(cur + min, end - (left - 1) * max);
    const hi = Math.min(cur + max, end - (left - 1) * min);
    const ideal = cur + (end - cur) / left;
    let t = ideal;
    if (lo <= hi) {
      const best = cands
        .filter((c) => c.t >= lo && c.t <= hi)
        .map((c) => ({ t: c.t, v: c.score - Math.abs(c.t - ideal) * 2 }))
        .sort((a, b) => b.v - a.v)[0];
      t = best ? best.t : Math.min(hi, Math.max(lo, ideal));
    }
    cuts.push(Math.round(t * 1000) / 1000);
    cur = t;
  }
  return cuts;
}

/** Micro-scenes of one scene, frame-exact (boundaries snapped with cumulative rounding). */
export function sliceScene(start: number, end: number, words: TimedWord[], silences: { start: number; end: number }[], opts: MicroOpts = {}): MicroCut[] {
  const fps = opts.fps ?? FPS_30;
  const times = [start, ...microCuts(start, end, words, silences, opts), end].map((t) => fromDecimal(Number(t.toFixed(3))));
  const frames = boundariesToFrames(times, fps);
  const out: MicroCut[] = [];
  for (let k = 0; k + 1 < frames.length; k++) {
    const a = frameToSeconds(frames[k], fps);
    const b = frameToSeconds(frames[k + 1], fps);
    const [as, bs] = [toNumber(a), toNumber(b)];
    out.push({
      startFrame: Number(frames[k]),
      endFrame: Number(frames[k + 1]),
      start: toRationalString(a),
      end: toRationalString(b),
      text: words.filter((w) => w.start >= as - 0.05 && w.start < bs - 0.05).map((w) => w.word).join(" "),
    });
  }
  return out;
}
