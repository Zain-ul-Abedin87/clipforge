import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { alignedFromChunks, FPS, frameAlignedGap, scriptUnits, synthesizeUnits, ttsCacheKey, ttsTimingsFor, wavData } from "../src/lib/ttsChunks.js";
import { relativeCaptions, sceneContentHash } from "../src/lib/compiler/incrementalCache.js";
import { contentSeed, randomCuts } from "../src/lib/pacing.js";
import type { TtsConfig } from "../src/lib/tts.js";
import { ffmpegPath } from "../src/lib/tools.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-tts-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// The same lookup the app uses (FFMPEG_PATH, else PATH): skipped only where FFmpeg is missing.
const ff = ffmpegPath();
const voice: TtsConfig = { provider: "openai", apiKey: "k", voice: "alloy", model: "gpt-4o-mini-tts" };

/** Fake engine: 0.3 s of silence, then a tone 0.06 s per character, then 0.2 s of silence. */
const fakeSpeak = (calls: string[]) => async (text: string): Promise<Buffer> => {
  calls.push(text);
  const out = path.join(tmp, `fake_${calls.length}.wav`);
  const len = (text.length * 0.06).toFixed(3);
  spawnSync(ff!, ["-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=frequency=440:duration=${len}`, "-af", "adelay=300,apad=pad_dur=0.2", "-ar", "24000", out]);
  return fs.readFileSync(out);
};

describe("script -> TTS sentences", () => {
  test("sentences per paragraph; the engine reads the pronunciation, captions keep the script", () => {
    const u = scriptUnits("The P365 is small. It holds 10 rounds!\n\nNext up: the Glock.", { P365: "P three sixty-five" });
    assert.deepEqual(u.map((x) => [x.paragraph, x.text]), [[0, "The P365 is small."], [0, "It holds 10 rounds!"], [1, "Next up: the Glock."]]);
    assert.equal(u[0].payload, "The P three sixty-five is small.");
  });

  test("cache key: same text and voice -> same key; voice or text change -> new key; the API key never matters", () => {
    const k = ttsCacheKey(voice, "Hello there.");
    assert.equal(ttsCacheKey({ ...voice, apiKey: "other" }, "Hello there."), k);
    assert.notEqual(ttsCacheKey({ ...voice, voice: "nova" }, "Hello there."), k);
    assert.notEqual(ttsCacheKey(voice, "Hello there!"), k);
    assert.notEqual(ttsCacheKey({ provider: "windows", rate: 2 }, "x"), ttsCacheKey({ provider: "windows", rate: 1 }, "x"), "speed is part of the key");
  });

  test("sentence + pause always ends on a frame boundary", () => {
    for (const d of [0.5, 1.234567, 2.9999, 3.01]) {
      const g = frameAlignedGap(d, 0.25);
      assert.ok(g >= 0.25 - 1e-6);
      const frames = (d + g) * FPS;
      assert.ok(Math.abs(frames - Math.round(frames)) < 0.01, `${d} + ${g}`);
    }
  });
});

describe("per-sentence synthesis and cache", { skip: !ff && "ffmpeg not found" }, () => {
  const cacheDir = path.join(tmp, "cache");
  const script = "First line is here. Second one is a bit longer than that.\n\nThird line closes it.";

  test("first run synthesizes every sentence; trims the engine's silence; times are exact", async () => {
    const calls: string[] = [];
    const out = path.join(tmp, "p1", "voiceover_tts.wav");
    const m = await synthesizeUnits({ script, outFile: out, config: voice, cacheDir, speak: fakeSpeak(calls) });
    assert.equal(m.synthesized, 3);
    assert.equal(calls.length, 3);
    // Tone only (0.3 s lead-in and 0.2 s tail trimmed): about 0.06 s per character.
    const d0 = m.units[0].end - m.units[0].start;
    assert.ok(Math.abs(d0 - "First line is here.".length * 0.06) < 0.05, `duration ${d0}`);
    // The track holds exactly the sentences and their pauses.
    const samples = wavData(fs.readFileSync(out)).length / 2;
    assert.ok(Math.abs(samples / 44100 - m.duration) < 1 / 44100 + 1e-6);
    for (const u of m.units) assert.ok(Math.abs(u.start * FPS - Math.round(u.start * FPS)) < 0.01, "every sentence starts on a frame");
  });

  test("editing one sentence re-synthesizes only that one; later sentences move by whole frames", async () => {
    const before = await synthesizeUnits({ script, outFile: path.join(tmp, "p2", "a.wav"), config: voice, cacheDir, speak: fakeSpeak([]) });
    const calls: string[] = [];
    const edited = script.replace("First line is here.", "First line is here, and now it is a lot longer.");
    const m = await synthesizeUnits({ script: edited, outFile: path.join(tmp, "p2", "b.wav"), config: voice, cacheDir, speak: fakeSpeak(calls) });
    assert.deepEqual(calls, ["First line is here, and now it is a lot longer."]);
    assert.equal(m.reused, 2);
    for (const i of [1, 2]) {
      const a = before.units[i], b = m.units[i];
      assert.ok(Math.abs(b.end - b.start - (a.end - a.start)) < 1e-6, "same sentence, same length");
      const shift = (b.start - a.start) * FPS;
      assert.ok(shift > 0 && Math.abs(shift - Math.round(shift)) < 0.01, `shift ${shift} frames`);
    }
  });

  test("aligned.json from the sentence times: exact edges, monotonic words", async () => {
    const m = await synthesizeUnits({ script, outFile: path.join(tmp, "p3", "voiceover_tts.wav"), config: voice, cacheDir, speak: fakeSpeak([]) });
    const a = alignedFromChunks(m);
    assert.equal(a.sentences.length, 3);
    assert.equal(a.words.length, script.split(/\s+/).length);
    a.sentences.forEach((st, i) => {
      assert.ok(Math.abs(st.start - m.units[i].start) < 0.001 && Math.abs(st.end - m.units[i].end) < 0.001);
      assert.equal(st.paragraph, m.units[i].paragraph);
    });
    for (let i = 1; i < a.words.length; i++) assert.ok(a.words[i].start >= a.words[i - 1].end - 1e-6);
  });

  test("Mode B timings apply only to the audio the TTS step wrote", async () => {
    const dir = path.join(tmp, "p4");
    const out = path.join(dir, "voiceover_tts.wav");
    const m = await synthesizeUnits({ script, outFile: out, config: voice, cacheDir, speak: fakeSpeak([]) });
    const { synthesized: _s, reused: _r, ...manifest } = m;
    fs.writeFileSync(path.join(dir, "tts_chunks.json"), JSON.stringify(manifest));
    assert.ok(ttsTimingsFor(dir, out));
    assert.equal(ttsTimingsFor(dir, path.join(dir, "uploaded.mp3")), null, "an uploaded voiceover goes through Whisper");
  });
});

describe("a moved scene keeps its render cache", () => {
  const words = (offset: number) => ["Number", "two", "is", "the", "Honda."].map((w, i) => ({ word: w, start: offset + i * 0.5, end: offset + i * 0.5 + 0.4 }));

  test("same words and length, different start -> same cuts", () => {
    assert.deepEqual(
      randomCuts(10, 21, words(10), [2, 3, 4]).map((c) => +(c - 10).toFixed(3)),
      randomCuts(13.4, 24.4, words(13.4), [2, 3, 4]).map((c) => +(c - 13.4).toFixed(3)),
    );
    assert.equal(contentSeed(10, 21, words(10), 1), contentSeed(13.4, 24.4, words(13.4), 1));
  });

  test("captions are hashed relative to the segment", () => {
    const base = { sceneId: 3, asset: { path: "/x.png", kind: "image" }, overlays: [], transition: "cut", motion: "none", frames: 90, fadeIn: false, fadeOut: false, version: 6 };
    const at = (s: number) => sceneContentHash({ ...base, captions: { lines: relativeCaptions([{ text: "Number two", start: s + 0.2, end: s + 1.4 }], s) } });
    assert.equal(at(10), at(13.4));
  });
});
