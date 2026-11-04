import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-clips-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.SHORTS_X264_PRESET = "ultrafast";

const S = await import("../src/lib/agents/llm/settings.js");
const F = await import("../src/lib/settings/features.js");
const R = await import("../src/lib/shorts/reframe.js");
const { shortlistOpenings } = await import("../src/lib/shorts/pick.js");
const { renderShort } = await import("../src/lib/shorts/render.js");
const L = await import("../src/lib/shorts/longform.js");
const { createMade, madeView, makeRoute } = await import("../src/server/routes/make.js");
const { stageSteps, readConfig } = await import("../src/lib/orchestrator/pipeline.js");
const { paths } = await import("../src/lib/paths.js");
const { ffmpegPath } = await import("../src/lib/tools.js");
const { run } = await import("../src/lib/exec.js");

const made: string[] = [];
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const p of made) {
    fs.rmSync(path.join(paths.workspace, p), { recursive: true, force: true });
    for (const f of fs.existsSync(paths.output) ? fs.readdirSync(paths.output) : []) if (f.startsWith(p)) fs.rmSync(path.join(paths.output, f), { force: true });
  }
});

describe("reframe", () => {
  test("crop width per shape from a 1920x1080 source", () => {
    assert.equal(R.cropWidth(1920, 1080, "9:16"), 608);
    assert.equal(R.cropWidth(1920, 1080, "1:1"), 1080);
    assert.equal(R.cropWidth(1920, 1080, "16:9"), 1920);
  });

  test("keyframes hold still on small moves and follow a clear move", () => {
    // Face at 30% of the width with a little jitter, then it moves to 70%.
    const samples = [0.30, 0.31, 0.29, 0.30, 0.32, 0.70, 0.71, 0.69, 0.70].map((cx, i) => ({ t: i * 0.5, cx }));
    const keys = R.cropKeyframes(samples, 1920, 1080, "9:16")!;
    assert.equal(keys.length, 2, JSON.stringify(keys));
    assert.ok(Math.abs(keys[0].x - Math.round(0.3 * 1920 - 304)) <= 20, String(keys[0].x));
    assert.ok(keys[1].t >= 2.5 && keys[1].t <= 3, String(keys[1].t));
    assert.ok(Math.abs(keys[1].x - Math.round(0.7 * 1920 - 304)) <= 20);
  });

  test("one lost face in a row is ignored; too few faces = no keyframes (falls back to fit)", () => {
    const one = R.cropKeyframes([0.5, 0.5, null, 0.5, 0.5].map((cx, i) => ({ t: i, cx })), 1920, 1080, "9:16")!;
    assert.equal(one.length, 1);
    assert.equal(R.cropKeyframes([null, null, null, 0.5].map((cx, i) => ({ t: i, cx })), 1920, 1080, "9:16"), null);
    assert.equal(R.cropKeyframes([], 1920, 1080, "9:16"), null);
  });

  test("the crop stays inside the frame at the edges", () => {
    const keys = R.cropKeyframes([0.01, 0.01, 0.99, 0.99, 0.99].map((cx, i) => ({ t: i, cx })), 1920, 1080, "9:16")!;
    assert.equal(keys[0].x, 0);
    assert.equal(keys.at(-1)!.x, 1920 - 608);
  });

  test("crop x expression: hold, then a short pan", () => {
    assert.equal(R.cropXExpr([{ t: 0, x: 100 }]), "100");
    const e = R.cropXExpr([{ t: 0, x: 100 }, { t: 2, x: 500 }], 0.4);
    const at = (t: number) => Function("t", `const lt=(a,b)=>a<b?1:0; const iff=(c,a,b)=>c?a:b; return ${e.replace(/if\(/g, "iff(")}`)(t) as number;
    assert.equal(at(0.5), 100);
    assert.equal(at(1.6), 100);
    assert.ok(Math.abs(at(1.8) - 300) < 1e-6);
    assert.equal(at(3), 500);
  });

  test("filters: fit for a source that is not wider, smart without keys, or fit chosen", () => {
    assert.match(R.reframeFilter("9:16", "smart", 1920, 1080, null), /boxblur/);
    assert.match(R.reframeFilter("9:16", "fit", 1920, 1080, [{ t: 0, x: 0 }]), /boxblur/);
    assert.match(R.reframeFilter("9:16", "center", 1080, 1920, null), /^\[0:v\]scale=1080:1920,setsar=1/);
    assert.match(R.reframeFilter("9:16", "center", 1920, 1080, null), /crop=608:1080:656:0/);
    assert.match(R.reframeFilter("1:1", "smart", 1920, 1080, [{ t: 0, x: 10 }, { t: 3, x: 800 }]), /crop=1080:1080:'if\(lt\(t,/);
    assert.match(R.reframeFilter("16:9", "smart", 1920, 1080, [{ t: 0, x: 0 }]), /boxblur|scale=1920:1080/);
  });
});

describe("long video -> Shorts: counting and choosing", () => {
  test("the count follows the length, at least 1, at most maxClips", () => {
    assert.equal(L.clipCount(600, 10, 40), 2);
    assert.equal(L.clipCount(3600, 10, 40), 10);
    assert.equal(L.clipCount(3 * 3600, 10, 40), 30);
    assert.equal(L.clipCount(10 * 3600, 10, 40), 40);
    assert.equal(L.clipCount(30, 10, 40), 1);
  });

  test("spread: every part of a long video sends openings to the model, not only the wordy start", () => {
    // 1000 openings over 2 hours; the first 100 all score high on the word rules.
    const openings = Array.from({ length: 1000 }, (_, i) => ({ start: i * 7.2, ruleScore: i < 100 ? 9 : 3 }));
    const plain = shortlistOpenings(openings, 5);
    assert.ok(plain.every((o) => o.start < 720), "without spread only the start is asked about");
    const spread = shortlistOpenings(openings, 5, true);
    assert.ok(spread.length <= 40);
    assert.ok(spread.some((o) => o.start > 6000), "the last part of the video is in the shortlist");
  });
});

describe("long video -> Shorts: project, pipeline, page", () => {
  test("no project without the rights box", () => {
    assert.throws(() => createMade({ type: "clips", topic: "Episode 1" }), /yours or that you have permission/);
  });

  test("project + settings + pipeline steps", () => {
    const { project } = createMade({ type: "clips", topic: "zz clips test episode", rights: true, format: "1:1", reframe: "nope", captionPreset: "karaoke", language: "de" });
    made.push(project);
    assert.equal(readConfig(project)?.type, "clips");
    const i = L.readClipsInput(project)!;
    assert.equal(i.format, "1:1");
    assert.equal(i.reframe, "smart", "an unknown framing falls back to the setting");
    assert.equal(i.captionPreset, "karaoke");
    // No video yet: nothing to transcribe.
    assert.deepEqual(stageSteps("writing", project, readConfig(project)), []);
    fs.mkdirSync(L.clipsDir(project), { recursive: true });
    fs.writeFileSync(path.join(L.clipsDir(project), "source.mp4"), "x");
    L.setClipsSource(project, "source.mp4");
    const w = stageSteps("writing", project, readConfig(project));
    assert.deepEqual(w.map((s) => s[0]), ["transcribe", "align", "clips"]);
    assert.ok(w[0].includes("de"), "the spoken language goes to Whisper");
    assert.deepEqual(stageSteps("render", project, readConfig(project)), [["clips", "-p", project, "--render"]]);
    assert.deepEqual(stageSteps("voice", project, readConfig(project)), []);
    const v = madeView(project) as { type: string; stages: { id: string }[]; source: { name: string } };
    assert.equal(v.type, "clips");
    assert.deepEqual(v.stages.map((s) => s.id), ["writing", "render"]);
    assert.equal(v.source.name, "source.mp4");
  });
});

describe("long video -> Shorts (FFmpeg)", { skip: !ffmpegPath() }, () => {
  const ff = () => ffmpegPath()!;
  const probe = async (f: string) => {
    const p = await run(ff().replace(/ffmpeg(\.exe)?$/i, "ffprobe$1"), ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", f]);
    const j = JSON.parse(p.stdout) as { streams: { width: number; height: number }[]; format: { duration: string } };
    return { w: j.streams[0].width, h: j.streams[0].height, d: Number(j.format.duration) };
  };
  /** Mean brightness of the left third of a frame at `t` seconds. */
  const leftLuma = async (f: string, t: number) => {
    const out = execFileSync(ff(), ["-v", "error", "-ss", String(t), "-i", f, "-frames:v", "1", "-vf", "crop=iw/3:ih:0:0,scale=1:1,format=gray", "-f", "rawvideo", "-"]);
    return out[0];
  };

  test("smart crop follows the keyframes in the clip's own time (input seek), 9:16 and 1:1", async () => {
    fs.mkdirSync(tmp, { recursive: true });
    // 1280x720, black, with a white box on the left (x 0-300).
    const src = path.join(tmp, "box.mp4");
    await run(ff(), ["-y", "-f", "lavfi", "-i", "color=black:size=1280x720:rate=30:duration=6", "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-vf", "drawbox=x=0:y=0:w=300:h=720:color=white:t=fill", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", src]);
    const keys = [{ t: 0, x: 0 }, { t: 1.5, x: 1280 - R.cropWidth(1280, 720, "9:16") }];
    const out = path.join(tmp, "smart916.mp4");
    // Starts 2 s into the source: if the expression saw the source's time, the crop would already be on the right.
    await renderShort(src, { start: 2, end: 5 }, [], out, { captions: false, maxSec: 10, frame: { format: "9:16", reframe: "smart", srcW: 1280, srcH: 720, keys } });
    const m = await probe(out);
    assert.deepEqual([m.w, m.h], [1080, 1920]);
    assert.ok(Math.abs(m.d - 3) < 0.25, String(m.d));
    assert.ok((await leftLuma(out, 0.3)) > 200, "starts on the white box");
    assert.ok((await leftLuma(out, 2.5)) < 40, "ends on the black right side");
    const sq = path.join(tmp, "smart11.mp4");
    await renderShort(src, { start: 0, end: 2 }, [], sq, { captions: false, maxSec: 10, frame: { format: "1:1", reframe: "center", srcW: 1280, srcH: 720, keys: null } });
    const s = await probe(sq);
    assert.deepEqual([s.w, s.h], [1080, 1080]);
  });

  test("find -> render: ranked Shorts, smart falls back to fit when no face is seen; one rank can be rendered again", async () => {
    S.saveLlmSettings({ primary: "off" });
    F.saveFeatures({ clips: { perHour: 3600, maxClips: 2, minSec: 3, maxSec: 6, format: "9:16", reframe: "smart", captionPreset: "bold-pop" } });
    const { project } = createMade({ type: "clips", topic: "zz clips render test", rights: true });
    made.push(project);
    fs.mkdirSync(L.clipsDir(project), { recursive: true });
    const src = path.join(L.clipsDir(project), "source.mp4");
    await run(ff(), ["-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=20", "-f", "lavfi", "-i", "sine=frequency=300:duration=20", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-shortest", src]);
    L.setClipsSource(project, "source.mp4");
    const texts = ["Here is the intro of the show.", "Why does nobody talk about the $299 tool that beats them all?", "It is cheap.", "And it also works.", "Stop buying expensive gear, you will regret it.", "That is the end."];
    const sentences = texts.map((text, i) => ({ text, start: i * 3.2, end: i * 3.2 + 3 }));
    const words = sentences.flatMap((s) => s.text.split(" ").map((w, k, all) => ({ word: w, start: s.start + (k * 3) / all.length, end: s.start + ((k + 1) * 3) / all.length })));
    fs.writeFileSync(path.join(paths.workspace, project, "aligned.json"), JSON.stringify({ words, sentences }));
    const clips = await L.findClips(project, { log: () => {} });
    assert.equal(clips.length, 2);
    assert.deepEqual(clips.map((c) => c.rank), [1, 2]);
    assert.ok(clips[0].score >= clips[1].score);
    let tracked = 0;
    const r = await L.renderClips(project, { faces: async () => (tracked++, [{ t: 0, cx: null }, { t: 0.5, cx: null }]), log: () => {} });
    assert.equal(tracked, 2);
    for (const c of r) {
      assert.ok(c.file && !c.error, c.error);
      assert.equal(c.reframed, "fit (too few faces seen)");
      const m = await probe(path.join(paths.output, c.file!));
      assert.deepEqual([m.w, m.h], [1080, 1920]);
    }
    // The page's clip route streams the file.
    const res = await makeRoute(["api", "make", project, "clip", "1"], "GET", async () => "");
    assert.equal(res?.status, 200);
    assert.ok(res?.file?.endsWith(`${project}_clip_1.mp4`));
    // A new shape for rank 2 only.
    await makeRoute(["api", "make", project, "settings"], "PUT", async () => JSON.stringify({ format: "1:1", reframe: "center" }));
    let rendered = 0;
    await L.renderClips(project, { ranks: [2], render: async (...a) => (rendered++, renderShort(...a)), log: () => {} });
    assert.equal(rendered, 1);
    const m2 = await probe(path.join(paths.output, `${project}_clip_2.mp4`));
    assert.deepEqual([m2.w, m2.h], [1080, 1080]);
  });
});
