import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Aligned, AlignedWord, Sentence } from "../commands/align.js";
import { canonicalJson } from "./compiler/incrementalCache.js";
import { env } from "./env.js";
import { run } from "./exec.js";
import { applyPronunciations, loadPronunciations } from "./glossary.js";
import { endsSentence, norm, tokenize } from "./text.js";
import { ffmpegPath } from "./tools.js";
import { CHUNK_CHARS, speakChunk, type TtsConfig } from "./tts.js";

/**
 * Mode B narration, one TTS request per sentence, each cached by what decides its sound:
 * sha256(provider + voice settings + spoken text). Editing one sentence re-synthesises that
 * sentence only; every other one comes from cache/tts. The pieces are trimmed of the engine's own
 * lead-in / tail silence, then laid end to end in Node with explicit pauses, so every sentence's
 * start and end on the voice track is known to the sample. Those times ARE the alignment
 * (aligned.json): Whisper does not run for Mode B.
 *
 * Each sentence + its pause is padded to a whole number of video frames (1/30 s), so an edit that
 * changes one sentence's length shifts everything after it by whole frames. Later scenes keep their
 * frame counts and their render-cache entries (incrementalCache hashes content, not position).
 */

export const FPS = 30;
const RATE = 44100;
const FORMAT_VERSION = 1;

export interface TtsUnit {
  index: number;
  paragraph: number;
  /** Script words of the sentence, as aligned.json shows them. */
  text: string;
  /** What the engine reads (glossary pronunciations applied). */
  payload: string;
}

export interface ChunkEntry extends TtsUnit {
  key: string;
  file: string;
  /** Seconds on the voice track. */
  start: number;
  end: number;
  /** Pause after the sentence (frame-aligned). */
  gapAfter: number;
  cached: boolean;
}

export interface TtsChunkManifest {
  version: typeof FORMAT_VERSION;
  audio: string;
  provider: string;
  duration: number;
  units: ChunkEntry[];
}

/** Sentences of the script in reading order (paragraphs = blank-line blocks, like align.ts). */
export function scriptUnits(script: string, overrides: Record<string, string>, maxChars = 2400): TtsUnit[] {
  const units: TtsUnit[] = [];
  script
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .forEach((para, p) => {
      let cur: string[] = [];
      const flush = () => {
        if (!cur.length) return;
        // A sentence longer than one request is split at words (rare: run-on lists).
        let part: string[] = [];
        for (const w of cur) {
          if (part.length && applyPronunciations([...part, w].join(" "), overrides).length > maxChars) {
            units.push(unit(units.length, p, part, overrides));
            part = [];
          }
          part.push(w);
        }
        if (part.length) units.push(unit(units.length, p, part, overrides));
        cur = [];
      };
      for (const t of tokenize(para)) {
        cur.push(t);
        if (endsSentence(t)) flush();
      }
      flush();
    });
  return units;
}

const unit = (index: number, paragraph: number, words: string[], overrides: Record<string, string>): TtsUnit => {
  const text = words.join(" ");
  return { index, paragraph, text, payload: applyPronunciations(text, overrides) };
};

/** Cache key of one sentence: provider, the voice settings that change the sound, the spoken text. */
export function ttsCacheKey(c: TtsConfig, payload: string): string {
  const voice =
    c.provider === "elevenlabs"
      ? { voiceId: c.voiceId, model: c.model }
      : c.provider === "openai"
        ? { voice: c.voice, model: c.model, instructions: c.instructions ?? null }
        : c.provider === "piper"
          ? { model: path.basename(c.model), size: fileSize(c.model) }
          : { rate: c.rate };
  return crypto.createHash("sha256").update(canonicalJson({ v: FORMAT_VERSION, provider: c.provider, voice, payload })).digest("hex");
}

const fileSize = (f: string) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return -1;
  }
};

/** Pause after a sentence, padded so sentence + pause is a whole number of frames. */
export function frameAlignedGap(duration: number, pause: number): number {
  const frames = Math.ceil((duration + pause) * FPS - 1e-9);
  return Math.round((frames / FPS - duration) * RATE) / RATE;
}

export interface SynthesizeUnitsOpts {
  script: string;
  outFile: string;
  config: TtsConfig;
  glossaryFile?: string | null;
  /** Shared sentence cache (<root>/cache/tts). */
  cacheDir: string;
  /** Re-synthesise every sentence and replace its cache entry. */
  force?: boolean;
  fetchImpl?: typeof fetch;
  /** Injected for tests: returns raw engine audio (any format FFmpeg reads). */
  speak?: (text: string) => Promise<Buffer>;
  log?: (m: string) => void;
}

export async function synthesizeUnits(o: SynthesizeUnitsOpts): Promise<TtsChunkManifest & { synthesized: number; reused: number }> {
  const log = o.log ?? (() => {});
  const ff = ffmpegPath();
  if (!ff) throw new Error("ffmpeg not found (needed to prepare TTS sentences)");
  const units = scriptUnits(o.script, loadPronunciations(o.glossaryFile), CHUNK_CHARS[o.config.provider]);
  if (!units.length) throw new Error("script is empty - nothing to read");
  const dir = path.join(o.cacheDir, o.config.provider);
  fs.mkdirSync(dir, { recursive: true });
  const speak = o.speak ?? ((t: string) => speakChunk(o.config, t, o.fetchImpl));
  const pause = Number(env("TTS_PAUSE_MS", "250")) / 1000;
  const paraPause = Number(env("TTS_PARAGRAPH_PAUSE_MS", "600")) / 1000;

  let synthesized = 0;
  const pcm: Buffer[] = [];
  const entries: ChunkEntry[] = [];
  let t = 0;
  for (const u of units) {
    const key = ttsCacheKey(o.config, u.payload);
    const file = path.join(dir, `${key.slice(0, 32)}.wav`);
    const cached = !o.force && fs.existsSync(file) && fs.statSync(file).size > 44;
    if (!cached) {
      log(`[tts] ${o.config.provider}: sentence ${u.index + 1}/${units.length} (${u.payload.length} chars)`);
      await normalise(ff, await speak(u.payload), file);
      synthesized++;
    }
    const data = wavData(fs.readFileSync(file));
    const dur = data.length / 2 / RATE;
    const next = units[u.index + 1];
    const gap = next ? frameAlignedGap(dur, next.paragraph === u.paragraph ? pause : paraPause) : frameAlignedGap(dur, 0);
    entries.push({ ...u, key, file, start: round6(t), end: round6(t + dur), gapAfter: gap, cached });
    pcm.push(data, Buffer.alloc(Math.round(gap * RATE) * 2));
    t += dur + gap;
  }
  writeWav(o.outFile, Buffer.concat(pcm));
  const reused = units.length - synthesized;
  log(`[tts] ${units.length} sentence(s): ${reused} from cache, ${synthesized} synthesized`);
  return { version: FORMAT_VERSION, audio: path.resolve(o.outFile), provider: o.config.provider, duration: round6(t), units: entries, synthesized, reused };
}

/** Engine output -> mono 44.1 kHz 16-bit WAV with the lead-in / tail silence trimmed. */
async function normalise(ff: string, raw: Buffer, out: string): Promise<void> {
  const tmp = `${out}.${process.pid}.raw`;
  const part = `${out}.${process.pid}.part.wav`;
  fs.writeFileSync(tmp, raw);
  const trim = "silenceremove=start_periods=1:start_threshold=-50dB,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse";
  const args = (af: string[]) => ["-hide_banner", "-loglevel", "error", "-y", "-i", tmp, ...af, "-ac", "1", "-ar", String(RATE), "-c:a", "pcm_s16le", "-f", "wav", part];
  try {
    let r = await run(ff, args(["-af", trim]));
    // A very quiet engine can lose everything to the trim: keep the untrimmed audio then.
    if (r.code !== 0 || !fs.existsSync(part) || wavData(fs.readFileSync(part)).length < RATE * 0.05 * 2) r = await run(ff, args([]));
    if (r.code !== 0) throw new Error(`could not decode TTS audio: ${r.stderr.slice(-300)}`);
    fs.renameSync(part, out);
  } finally {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(part, { force: true });
  }
}

/** PCM bytes of a WAV file (walks the RIFF chunks; FFmpeg may add a LIST chunk before "data"). */
export function wavData(buf: Buffer): Buffer {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === "data") return buf.subarray(p + 8, Math.min(buf.length, p + 8 + size));
    p += 8 + size + (size % 2);
  }
  throw new Error("WAV file has no data chunk");
}

function writeWav(file: string, data: Buffer): void {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0, "ascii");
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8, "ascii");
  h.write("fmt ", 12, "ascii");
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36, "ascii");
  h.writeUInt32LE(data.length, 40);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const part = `${file}.part`;
  fs.writeFileSync(part, Buffer.concat([h, data]));
  fs.renameSync(part, file);
}

/**
 * aligned.json from the sentence times. Inside a sentence (trimmed, so speech fills it) word times
 * are spread by letter count, with a little extra after commas; sentence edges are exact.
 */
export function alignedFromChunks(m: Pick<TtsChunkManifest, "units">): Aligned {
  const words: AlignedWord[] = [];
  const sentences: Sentence[] = [];
  for (const u of m.units) {
    const toks = tokenize(u.text);
    if (!toks.length) continue;
    const weight = toks.map((w) => Math.max(1, norm(w).length) + 1 + (/[,;:]$/.test(w) ? 2 : 0));
    const total = weight.reduce((a, b) => a + b, 0);
    const first = words.length;
    let at = u.start;
    toks.forEach((w, i) => {
      const len = ((u.end - u.start) * weight[i]) / total;
      words.push({ word: w, start: round3(at), end: round3(at + len), source: "script" });
      at += len;
    });
    sentences.push({ id: sentences.length, text: toks.join(" "), start: words[first].start, end: words[words.length - 1].end, firstWord: first, lastWord: words.length - 1, paragraph: u.paragraph });
  }
  return {
    mode: "script",
    words,
    sentences,
    corrections: [],
    stats: { scriptWords: words.length, sentences: sentences.length, ttsSentences: m.units.length, ttsFromCache: m.units.filter((u) => u.cached).length },
  };
}

/** Mode B timings for this audio file, when the TTS step produced it (else null: Whisper path). */
export function ttsTimingsFor(dir: string, audio: string | undefined | null): TtsChunkManifest | null {
  const f = path.join(dir, "tts_chunks.json");
  if (!audio || !fs.existsSync(f)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(f, "utf8")) as TtsChunkManifest;
    return m.version === FORMAT_VERSION && path.resolve(m.audio) === path.resolve(audio) && fs.existsSync(audio) ? m : null;
  } catch {
    return null;
  }
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;
const round6 = (x: number) => Math.round(x * 1e6) / 1e6;
