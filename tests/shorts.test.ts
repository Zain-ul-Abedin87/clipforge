import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-shorts-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.SHORTS_X264_PRESET = "ultrafast";

const S = await import("../src/lib/agents/llm/settings.js");
const F = await import("../src/lib/settings/features.js");
const { setQwenFetch } = await import("../src/lib/agents/llm/llm.js");
const { candidateWindows, pickShorts, ruleHookScore } = await import("../src/lib/shorts/pick.js");
const { shortAss } = await import("../src/lib/shorts/render.js");
const { shorts } = await import("../src/commands/shorts.js");
const { paths } = await import("../src/lib/paths.js");
const { ffmpegPath } = await import("../src/lib/tools.js");
const { run } = await import("../src/lib/exec.js");

const PROJECT = "zz_shorts_test";
const projDir = path.join(paths.workspace, PROJECT);
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(projDir, { recursive: true, force: true });
  for (const f of fs.existsSync(paths.output) ? fs.readdirSync(paths.output) : []) if (f.startsWith(PROJECT)) fs.rmSync(path.join(paths.output, f), { force: true });
});

/** 40 sentences of 4 s each (160 s); a few have strong hooks. */
const SENTENCES = Array.from({ length: 40 }, (_, i) => ({
  text: i === 5 ? "Why does nobody talk about the $299 pistol that beats a Glock?" : i === 22 ? "Stop buying cheap holsters, you will regret it." : i === 31 ? "And it also has a rail." : `This is sentence number ${i} about the gear we tested.`,
  start: i * 4,
  end: i * 4 + 3.8,
}));
const wordsOf = (ss: typeof SENTENCES) => ss.flatMap((s) => s.text.split(" ").map((w, k, all) => ({ word: w, start: s.start + (k * (s.end - s.start)) / all.length, end: s.start + ((k + 1) * (s.end - s.start)) / all.length })));

describe("Shorts picker", () => {
  test("windows are whole sentences, 30-58 s", () => {
    const w = candidateWindows(SENTENCES, 30, 58);
    assert.ok(w.length > 0);
    for (const x of w) assert.ok(x.end - x.start >= 30 && x.end - x.start <= 58, `${x.start}-${x.end}`);
  });

  test("rule hook score: strong openers beat mid-thought starts", () => {
    assert.ok(ruleHookScore(SENTENCES[5].text, "") > ruleHookScore(SENTENCES[31].text, ""));
    assert.ok(ruleHookScore("Stop buying cheap holsters, you will regret it.", "") >= 6);
  });

  test("3 non-overlapping Shorts, best hooks first; the model's hook score is used when available", async () => {
    S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local" } });
    setQwenFetch((async (_u: string, init: RequestInit) => {
      const items = JSON.parse(JSON.parse(String(init.body)).messages.at(-1).content) as { id: number; first_sentence: string }[];
      const windows = items.map((x) => ({ id: x.id, hook: /nobody|Stop/.test(x.first_sentence) ? 9 : 4, standalone: 7, title: `Short ${x.id}` }));
      return new Response(JSON.stringify({ message: { content: JSON.stringify({ windows }) }, done: true, done_reason: "stop" }));
    }) as unknown as typeof fetch);
    const picks = await pickShorts(SENTENCES, { count: 3, minSec: 30, maxSec: 58 });
    assert.equal(picks.length, 3);
    for (let i = 1; i < picks.length; i++) assert.ok(picks[i].start >= picks[i - 1].end);
    assert.ok(picks.some((p) => p.hook === SENTENCES[5].text));
    assert.ok(picks.some((p) => p.hook === SENTENCES[22].text));
    assert.ok(picks.every((p) => p.modelScore !== null && p.title));
    S.saveLlmSettings({ primary: "off" });
  });

  test("vertical captions: PlayRes 1080x1920, word events relative to the Short", () => {
    const ass = shortAss(wordsOf(SENTENCES), { start: 20, end: 52 });
    assert.match(ass, /PlayResX: 1080\nPlayResY: 1920/);
    const first = /Dialogue: 0,(\d+:\d+:\d+\.\d+)/.exec(ass)![1];
    assert.equal(first, "0:00:00.00");
    assert.ok(!/Dialogue: 0,0:00:3[3-9]/.test(ass), "nothing after the end of the Short");
  });
});

describe("shorts step (FFmpeg)", { skip: !ffmpegPath() }, () => {
  test("one run -> 3 Shorts under 60 s, 1080x1920, with captions", async () => {
    const ff = ffmpegPath()!;
    fs.rmSync(projDir, { recursive: true, force: true });
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(paths.output, { recursive: true });
    const video = path.join(paths.output, `${PROJECT}.mp4`);
    await run(ff, ["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=160", "-f", "lavfi", "-i", "sine=frequency=300:duration=160", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", video]);
    const words = wordsOf(SENTENCES).map((w) => ({ ...w, source: "script" }));
    let first = 0;
    const sentences = SENTENCES.map((s, id) => {
      const n = s.text.split(" ").length;
      const out = { id, text: s.text, start: s.start, end: s.end, firstWord: first, lastWord: first + n - 1, paragraph: 0 };
      first += n;
      return out;
    });
    fs.writeFileSync(path.join(projDir, "aligned.json"), JSON.stringify({ mode: "script", words, sentences, corrections: [], stats: {} }));
    F.saveFeatures({ shorts: { count: 3, minSec: 30, maxSec: 34, captions: true } });
    const logs: string[] = [];
    assert.equal(await shorts({ project: PROJECT }, (m) => logs.push(m)), 0, logs.join("\n"));
    const meta = JSON.parse(fs.readFileSync(path.join(projDir, "shorts.json"), "utf8")) as { shorts: { file: string }[] };
    assert.equal(meta.shorts.length, 3);
    const fp = ff.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1");
    for (const s of meta.shorts) {
      const p = await run(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", s.file]);
      const j = JSON.parse(p.stdout) as { streams: { width: number; height: number }[]; format: { duration: string } };
      assert.deepEqual([j.streams[0].width, j.streams[0].height], [1080, 1920]);
      assert.ok(Number(j.format.duration) < 60 && Number(j.format.duration) >= 29, j.format.duration);
      assert.ok(fs.existsSync(s.file.replace(/\.mp4$/, ".ass")), "captions file burned in");
    }
  });
});
