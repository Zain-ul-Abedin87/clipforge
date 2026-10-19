import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { autoProvider, TtsConfigError } from "../src/lib/tts.js";
import { BUNDLED, captionFamily, captionFontsDir, findFont } from "../src/lib/fonts.js";
import { EncoderPicker, resetEncoderProbe, resolveEncoder } from "../src/lib/encoder.js";
import { exeName, ffmpegPath, findOnPath } from "../src/lib/tools.js";
import { paths } from "../src/lib/paths.js";

const envOf = (o: Record<string, string>) => (k: string, d = "") => o[k] ?? d;

describe("TTS: cross-platform default", () => {
  test("first configured provider wins: ElevenLabs, OpenAI, Piper", () => {
    assert.equal(autoProvider(envOf({ ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v", OPENAI_API_KEY: "o" }), "linux"), "elevenlabs");
    assert.equal(autoProvider(envOf({ ELEVENLABS_API_KEY: "k", OPENAI_API_KEY: "o" }), "linux"), "openai", "an ElevenLabs key without a voice is not set up");
    assert.equal(autoProvider(envOf({ PIPER_MODEL: "/v.onnx", PIPER_PATH: "/usr/bin/piper" }), "linux"), "piper");
  });
  test("nothing set: the Windows voice on Windows only, a clear error elsewhere", () => {
    assert.equal(autoProvider(envOf({}), "win32"), "windows");
    assert.throws(() => autoProvider(envOf({}), "linux"), TtsConfigError);
    assert.throws(() => autoProvider(envOf({}), "darwin"), /PIPER_MODEL/);
  });
});

describe("fonts: bundled, same on every OS", () => {
  test("bundled files exist and nothing points at C:/Windows", () => {
    for (const f of [BUNDLED.regular(), BUNDLED.bold(), BUNDLED.display()]) assert.ok(fs.existsSync(f), f);
    for (const [name, bold] of [["Inter", true], ["Oswald", true], ["Arial", false], [undefined, true]] as const) {
      const f = findFont(name, bold);
      assert.ok(fs.existsSync(f) && !/windows/i.test(f), `${name}: ${f}`);
    }
  });
  test("Oswald (not bundled) falls back to the condensed Anton, other names to Inter", () => {
    assert.equal(path.basename(findFont("Oswald", true)), "Anton-Regular.ttf");
    assert.equal(path.basename(findFont("Arial", true)), "Inter-Bold.ttf");
    assert.equal(path.basename(findFont("Inter", false)), "Inter-Regular.ttf");
  });
  test("captions: a bundled family, and only font files in the folder libass reads", () => {
    assert.equal(captionFamily("Inter"), "Inter");
    assert.equal(captionFamily("Arial"), "Inter");
    const files = fs.readdirSync(captionFontsDir()).filter((f) => fs.statSync(path.join(captionFontsDir(), f)).isFile());
    assert.ok(files.every((f) => /\.(ttf|otf)$/i.test(f)), files.join(", "));
  });
});

describe("encoder: NVENC only where it works", () => {
  const ok = async () => ({ code: 0, stdout: "", stderr: "" });
  const fail = async () => ({ code: 1, stdout: "", stderr: "Cannot load libcuda.so.1\n" });
  test("probe fails (no GPU) -> libx264; probe works -> NVENC; VIDEO_ENCODER=libx264 skips the probe", async () => {
    delete process.env.VIDEO_ENCODER;
    resetEncoderProbe();
    const logs: string[] = [];
    assert.equal(await resolveEncoder("ffmpeg", (m) => logs.push(m), fail as never), "x264");
    assert.match(logs[0], /libcuda/);
    resetEncoderProbe();
    assert.equal(await resolveEncoder("ffmpeg", () => {}, ok as never), "nvenc");
    process.env.VIDEO_ENCODER = "libx264";
    let probed = false;
    assert.equal(await resolveEncoder("ffmpeg", () => {}, (async () => ((probed = true), { code: 0, stdout: "", stderr: "" })) as never), "x264");
    assert.equal(probed, false);
    delete process.env.VIDEO_ENCODER;
  });
  test("mid-render NVENC failures trip to libx264 for the remaining segments", () => {
    const p = new EncoderPicker("nvenc");
    assert.deepEqual(p.tries(), ["nvenc", "nvenc", "x264"]);
    p.failed("nvenc");
    p.failed("nvenc");
    assert.deepEqual(p.tries(), ["nvenc", "nvenc", "x264"]);
    p.failed("nvenc");
    assert.deepEqual(p.tries(), ["x264"]);
    assert.deepEqual(new EncoderPicker("x264").tries(), ["x264"]);
  });
});

describe("tools: found on PATH on every OS", () => {
  test("platform file names and PATH lookup", () => {
    assert.equal(exeName("ffmpeg"), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    assert.ok(findOnPath("node"), "node is on PATH");
    assert.equal(findOnPath("definitely-not-a-program-xyz"), null);
    if (process.platform !== "win32") assert.match(paths.venvPython, /\.venv\/bin\/python$/);
  });
  test("ffmpeg resolves without FFMPEG_PATH when it is installed", { skip: !findOnPath("ffmpeg") && "ffmpeg not installed" }, () => {
    const saved = process.env.FFMPEG_PATH;
    delete process.env.FFMPEG_PATH;
    try {
      assert.ok(ffmpegPath());
    } finally {
      if (saved !== undefined) process.env.FFMPEG_PATH = saved;
    }
  });
});
