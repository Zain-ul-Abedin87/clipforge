import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-localtts-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { LineWorker } = await import("../src/lib/tts/worker.js");
const { kokoroSpeak, setKokoroSpawn } = await import("../src/lib/tts/kokoro.js");
const { ownVoiceSample } = await import("../src/lib/tts/xtts.js");
const { resolveTtsConfig, TtsConfigError, CHUNK_CHARS } = await import("../src/lib/tts.js");
const { synthesizeUnits, ttsCacheKey } = await import("../src/lib/ttsChunks.js");
const { engineFor, loudnorm } = await import("../src/lib/tts/index.js");
const { paths } = await import("../src/lib/paths.js");
const { ffmpegPath } = await import("../src/lib/tools.js");

/** A mono 16-bit WAV with a tone of `sec` seconds (what a TTS engine would write). */
function toneWav(sec: number, rate = 24000, amp = 3000): Buffer {
  const n = Math.round(sec * rate);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

/**
 * Fake python worker: answers the ready line, then for every job writes a WAV whose length is
 * proportional to the text (0.06 s per character) to job.out.
 */
function fakeWorker(o: { failStart?: string; jobs?: Record<string, unknown>[] } = {}) {
  let spawned = 0;
  const spawnFn = () => {
    spawned++;
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new Writable({
      write(chunk, _enc, cb) {
        const job = JSON.parse(String(chunk));
        o.jobs?.push(job);
        fs.writeFileSync(job.out, toneWav(Math.max(0.3, String(job.text).length * 0.06)));
        stdout.write(JSON.stringify({ ok: true }) + "\n");
        cb();
      },
    });
    Object.assign(child, { stdout, stderr, stdin, kill: () => child.emit("close", 0) });
    setImmediate(() => stdout.write(JSON.stringify(o.failStart ? { ready: false, error: o.failStart } : { ready: true, voices: ["am_michael"] }) + "\n"));
    return child;
  };
  return { spawnFn, spawned: () => spawned };
}

describe("local TTS engines", () => {
  test("worker: model loads once, jobs go one at a time; a failed start is a clear error", async () => {
    const jobs: Record<string, unknown>[] = [];
    const f = fakeWorker({ jobs });
    const w = new LineWorker("python", ["x.py"], f.spawnFn);
    const outs = [path.join(tmp, "a.wav"), path.join(tmp, "b.wav")];
    await Promise.all(outs.map((out, i) => w.request({ text: `sentence ${i}`, out })));
    assert.equal(f.spawned(), 1);
    assert.deepEqual(jobs.map((j) => j.text), ["sentence 0", "sentence 1"]);
    w.close();
    const bad = new LineWorker("python", ["x.py"], fakeWorker({ failStart: "kokoro-onnx not installed" }).spawnFn);
    await assert.rejects(bad.request({ text: "x", out: "y" }), /kokoro-onnx not installed/);
  });

  test("Kokoro via a Kokoro-FastAPI server (OpenAI-compatible) or the python worker", async () => {
    let body: Record<string, unknown> = {};
    const wav = await kokoroSpeak({ provider: "kokoro", url: "http://kokoro:8880", python: "python", model: "m", voices: "v", voice: "am_michael", speed: 1.1 }, "Hello there.", (async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(toneWav(0.5));
    }) as unknown as typeof fetch);
    assert.equal(body.voice, "am_michael");
    assert.equal(body.response_format, "wav");
    assert.ok(wav.length > 44);
    setKokoroSpawn(fakeWorker().spawnFn);
    const w2 = await kokoroSpeak({ provider: "kokoro", python: "python", model: "m", voices: "v", voice: "af_bella", speed: 1 }, "From the worker.");
    assert.equal(w2.subarray(0, 4).toString(), "RIFF");
  });

  test("config: Kokoro needs its model files or a server; XTTS takes only your own voice from channels/<id>/voice/", () => {
    const get = (m: Record<string, string>) => (n: string, f = "") => m[n] ?? f;
    assert.throws(() => resolveTtsConfig(get({ TTS_PROVIDER: "kokoro", KOKORO_MODEL: path.join(tmp, "none.onnx") })), TtsConfigError);
    const c = resolveTtsConfig(get({ TTS_PROVIDER: "kokoro", KOKORO_URL: "http://kokoro:8880", KOKORO_VOICE: "bf_emma" }));
    assert.deepEqual([c.provider, (c as { voice: string }).voice], ["kokoro", "bf_emma"]);
    const stranger = path.join(tmp, "celebrity.wav");
    fs.writeFileSync(stranger, toneWav(1));
    assert.equal(ownVoiceSample(stranger).ok, false);
    assert.throws(() => resolveTtsConfig(get({ TTS_PROVIDER: "xtts", XTTS_SPEAKER_WAV: stranger })), /own voice only/);
    const voiceDir = path.join(paths.channels, "zz_test_channel", "voice");
    fs.mkdirSync(voiceDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(voiceDir, "me.wav"), toneWav(1));
      assert.equal(ownVoiceSample(path.join(voiceDir, "me.wav")).ok, true);
      assert.equal(resolveTtsConfig(get({ TTS_PROVIDER: "xtts", XTTS_SPEAKER_WAV: path.join(voiceDir, "me.wav") })).provider, "xtts");
    } finally {
      fs.rmSync(path.dirname(voiceDir), { recursive: true, force: true });
    }
    assert.ok(CHUNK_CHARS.xtts <= 250, "XTTS reads at most ~250 characters per request");
  });

  test("per-sentence generation with cache keys per voice; sentence timings feed align; loudnorm keeps the length", { skip: !ffmpegPath() }, async () => {
    setKokoroSpawn(fakeWorker().spawnFn);
    const config = { provider: "kokoro" as const, python: "python", model: "kokoro-v1.0.onnx", voices: "voices.bin", voice: "am_michael", speed: 1 };
    assert.notEqual(ttsCacheKey(config, "Hi."), ttsCacheKey({ ...config, voice: "af_bella" }, "Hi."));
    const out = path.join(tmp, "vo.wav");
    const script = "The Sig P365 is small. It carries ten rounds.\n\nNumber one is next.";
    const m = await synthesizeUnits({ script, outFile: out, config, cacheDir: path.join(tmp, "cache"), log: () => {} });
    assert.equal(m.units.length, 3);
    assert.equal(m.synthesized, 3);
    for (let i = 1; i < m.units.length; i++) assert.ok(m.units[i].start >= m.units[i - 1].end);
    const again = await synthesizeUnits({ script, outFile: out, config, cacheDir: path.join(tmp, "cache"), log: () => {} });
    assert.equal(again.reused, 3, "unchanged sentences come from the cache");
    const before = fs.statSync(out).size;
    const logs: string[] = [];
    assert.equal(await loudnorm(out, -14, (l) => logs.push(l)), true);
    assert.ok(Math.abs(fs.statSync(out).size - before) <= 4096, "same length after loudnorm");
    assert.match(logs[0], /-14 LUFS/);
    assert.equal(engineFor(config).local, true);
  });
});
