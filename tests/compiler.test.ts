import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as R from "../src/domain/rational.math.js";
import { fromLegacyTimeline, LegacyTimeline, timelineToJson } from "../src/domain/timeline.types.js";
import { compileTimeline, limitFrames, loadTimeline, V3_FILE, writeTimelineV3 } from "../src/lib/compiler/timelineCompiler.js";
import { concatList, totalDuration } from "../src/lib/compiler/concatDemuxer.js";
import { SegmentCache } from "../src/lib/compiler/incrementalCache.js";
import { paths } from "../src/lib/paths.js";
import { ffmpegPath } from "../src/lib/tools.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-compiler-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const legacy = (): LegacyTimeline => ({
  version: 2, fps: 30, width: 1920, height: 1080, voice: "voice.wav",
  music: { files: ["bed.mp3"], volumeDb: -20 },
  motion: { sfx: true, sfxDb: -12 },
  captions: { enabled: true, font: "Arial", fontSize: 54, maxWordsPerLine: 7 },
  logo: { path: "logo.png", position: "top-right", opacity: 0.8 },
  scenes: [
    {
      id: 0, startFrame: 0, endFrame: 76, motion: "zoom_in", transition: "cut",
      asset: { path: "photo.jpg", kind: "image", source: "presskit", in: 0 },
      overlays: [{ path: "chip.png", delay: 0.1, anim: "slide_right", out: 2 }, { path: "card.mov", delay: 0.5, anim: "fade", video: true, card: { comp: "SpecCard", props: { title: "Deck" } } }],
      sfx: [{ kind: "whoosh", at: 0 }],
    },
    {
      id: 1, startFrame: 76, endFrame: 151, motion: "none", transition: "fade", backdrop: "blur",
      asset: { path: "p1.mp4", kind: "video", source: "youtube_exact_model", shots: [{ path: "p1.mp4", kind: "video", in: 1.25, frames: 40, verified: true }, { path: "p2.mp4", kind: "video", in: 0.5, frames: 35, variant: "mirror" }] },
    },
  ],
});

describe("v3 -> render jobs (compiler)", () => {
  test("a migrated v2 timeline compiles back to the same scenes, shots, layers, sfx and settings", () => {
    const c = compileTimeline(fromLegacyTimeline(legacy(), { 0: "intro line", 1: "second line" }));
    assert.equal(c.totalFrames, 151);
    assert.equal(R.toRationalString(c.duration), "151/30");
    const [a, b] = c.scenes;
    assert.deepEqual([a.startFrame, a.endFrame, b.startFrame, b.endFrame], [0, 76, 76, 151]);
    // Scene 0: one picture (Ken Burns / showcase path), no sub-shots.
    assert.deepEqual(a.asset, { path: "photo.jpg", kind: "image", source: "presskit", in: 0 });
    assert.equal(a.motion, "zoom_in");
    assert.deepEqual(a.overlays, [
      { path: "chip.png", delay: 0.1, anim: "slide_right", out: 2 },
      { path: "card.mov", delay: 0.5, anim: "fade", video: true, card: { comp: "SpecCard", props: { title: "Deck" } } },
    ]);
    assert.deepEqual(a.sfx, [{ kind: "whoosh", at: 0 }]);
    assert.equal(a.text, "intro line");
    // Scene 1: pacing sub-shots kept, with frames, in-points, variant, verified flag, backdrop, fade.
    assert.deepEqual(b.asset.shots?.map((s) => [s.path, s.in, s.frames, s.variant ?? null, s.verified ?? false]), [["p1.mp4", 1.25, 40, null, true], ["p2.mp4", 0.5, 35, "mirror", false]]);
    assert.equal(b.backdrop, "blur");
    assert.equal(b.transition, "fade");
    assert.deepEqual(c.audio, { voice: "voice.wav", music: { files: ["bed.mp3"], volumeDb: -20 }, sfx: { enabled: true, gainDb: -12, events: [{ kind: "whoosh", at: 0 }] } });
    assert.equal(c.captions.enabled, true);
    assert.deepEqual(c.logo, { path: "logo.png", position: "top-right", opacity: 0.8 });
  });

  test("previews cut the last scene on the frame; invalid or non-30 fps timelines are refused", () => {
    const c = compileTimeline(fromLegacyTimeline(legacy()));
    const p = limitFrames(c, 90);
    assert.deepEqual(p.scenes.map((s) => [s.startFrame, s.endFrame]), [[0, 76], [76, 90]]);
    assert.equal(R.toRationalString(p.duration), "3");
    const bad = fromLegacyTimeline(legacy());
    bad.tracks.find((t) => t.kind === "broll")!.clips[1].start = R.rat(1);
    assert.throws(() => compileTimeline(bad), /not renderable/);
    const ntsc = { ...fromLegacyTimeline(legacy()), fps: R.FPS_2997 };
    assert.throws(() => compileTimeline(ntsc), /not renderable|only 30 fps/);
  });
});

describe("concat demuxer (rational durations)", () => {
  test("exact per-file durations, also at 29.97 fps", () => {
    assert.equal(concatList([{ file: "C:\\a\\it's.mp4", frames: 45 }]), "file 'C:/a/it'\\''s.mp4'\nduration 1.500000\n");
    assert.equal(concatList([{ file: "x.mp4", frames: 1001 }], R.FPS_2997), "file 'x.mp4'\nduration 33.400033\n");
    // 600 scenes of 77 frames at 29.97: the exact sum vs a float accumulation of rounded durations.
    const entries = Array.from({ length: 600 }, (_, i) => ({ file: `s${i}.mp4`, frames: 77 }));
    const exact = totalDuration(entries, R.FPS_2997);
    assert.equal(R.toRationalString(exact), "77077/50"); // 600 x 77 x 1001 / 30000 = 1541.54 s exactly
    let float = 0;
    for (let i = 0; i < 600; i++) float += Number((77 * 1001 / 30000).toFixed(3));
    assert.notEqual(float.toFixed(6), R.toFixed(exact, 6), "rounded float durations drift");
  });
});

describe("v3 file is the source of truth (sync rules)", () => {
  test("v2 only -> migrated; v3 newer -> v3; v2 edited later -> v3 rewritten, text and subjects kept", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "sync-"));
    fs.writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(legacy()));
    assert.equal(loadTimeline(dir)!.source, "v2");
    const v3 = fromLegacyTimeline(legacy(), { 0: "intro line", 1: "second" });
    v3.scenes[1].subject = { productKey: "ego_lm2135sp", confidence: 0.95, reason: "named" };
    writeTimelineV3(dir, v3);
    assert.equal(loadTimeline(dir)!.source, "v3");
    // A swap in the simple UI rewrites timeline.json after the v3 file.
    const edited = legacy();
    edited.scenes[1].asset.shots![0].path = "swapped.mp4";
    fs.writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(edited));
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, "timeline.json"), t, t);
    const r = loadTimeline(dir)!;
    assert.equal(r.source, "v2-synced");
    const back = compileTimeline(loadTimeline(dir)!.tl);
    assert.equal(back.scenes[1].asset.shots![0].path, "swapped.mp4");
    assert.equal(back.scenes[0].text, "intro line");
    assert.equal(back.scenes[1].subject.productKey, "ego_lm2135sp");
    assert.ok(fs.readFileSync(path.join(dir, V3_FILE), "utf8").includes("swapped.mp4"));
  });
});

const ff = ffmpegPath();
describe("render from an edited v3 timeline (FFmpeg)", { skip: ff ? false : "ffmpeg not found" }, () => {
  const project = `_test_v3_${process.pid}`;
  const dir = path.join(paths.workspace, project);
  let render: typeof import("../src/commands/render.js").render;
  before(async () => {
    render = (await import("../src/commands/render.js")).render;
    process.env.VIDEO_ENCODER = "libx264";
    process.env.RENDER_CONCURRENCY = "1";
    fs.mkdirSync(dir, { recursive: true });
    const gen = (args: string[]) => assert.equal(spawnSync(ff!, ["-hide_banner", "-loglevel", "error", "-y", ...args]).status, 0);
    for (const [i, c] of ["red", "green", "blue", "white"].entries()) gen(["-f", "lavfi", "-i", `color=c=${c}:s=1920x1080`, "-frames:v", "1", path.join(dir, `c${i}.png`)]);
    gen(["-f", "lavfi", "-i", "sine=frequency=330:duration=3", path.join(dir, "voice.wav")]);
    const scene = (id: number) => ({ id, startFrame: id * 30, endFrame: (id + 1) * 30, asset: { path: path.join(dir, `c${id}.png`), kind: "image" as const, source: "local" }, motion: "none" as const, transition: "cut" as const });
    const v2: LegacyTimeline = { version: 2, fps: 30, width: 1920, height: 1080, voice: path.join(dir, "voice.wav"), music: { files: [], volumeDb: -18 }, motion: { sfx: false }, captions: { enabled: false }, logo: null, scenes: [scene(0), scene(1), scene(2)] };
    writeTimelineV3(dir, fromLegacyTimeline(v2));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(paths.output, `${project}.mp4`), { force: true });
  });
  const report = () => JSON.parse(fs.readFileSync(path.join(dir, "render_report.json"), "utf8"));

  test("renders straight from timeline.v3.json, then re-renders only the edited clip's scene", async () => {
    assert.equal(await render({ project }, () => {}), 0);
    assert.equal(report().timelineSource, "v3");
    assert.equal(report().segmentsRendered, 3);
    assert.equal(report().sync, true);
    // Edit one clip in the v3 file (what the block editor will do).
    const file = path.join(dir, V3_FILE);
    const tl = JSON.parse(fs.readFileSync(file, "utf8"));
    tl.tracks.find((t: { kind: string }) => t.kind === "broll").clips[2].media.path = path.join(dir, "c3.png");
    fs.writeFileSync(file, JSON.stringify(tl));
    assert.equal(await render({ project }, () => {}), 0);
    assert.deepEqual(report().scenesRerendered, [2]);
    assert.equal(report().framesExpected, 90);
    assert.equal(new SegmentCache(path.join(dir, "cache", "segments")).previous?.scenes["2"].frames, 30);
  });
});

test("timelineToJson is stable for the cache (same timeline, same bytes)", () => {
  assert.equal(timelineToJson(fromLegacyTimeline(legacy())), timelineToJson(fromLegacyTimeline(legacy())));
});
