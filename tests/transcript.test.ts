import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromLegacyTimeline, LegacyTimeline } from "../src/domain/timeline.types.js";
import { toNumber } from "../src/domain/rational.math.js";
import { writeTimelineV3 } from "../src/lib/compiler/timelineCompiler.js";
import { findPauses, TranscriptWord, transcriptWords, wordsCutRange } from "../src/lib/transcriptEdit.js";
import { ProjectStore } from "../src/server/state/projectStore.js";
import { createEditorAPI } from "../src/server/routes/editorAPI.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-transcript-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const touch = (f: string) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, "x"), f);

const w = (text: string, start: number, end: number): TranscriptWord => ({ text, startFrame: start, endFrame: end });
/** "Hello there" .. 20-frame pause .. "big world" .. 8-frame pause .. "again" (30 fps). */
const words = [w("Hello", 30, 50), w("there", 50, 70), w("big", 90, 110), w("world", 110, 130), w("again", 138, 160)];

describe("pauses and word cuts (pure)", () => {
  test("pauses of at least the minimum are found, with the silence to keep", () => {
    // min 0.5 s = 15 frames, keep 0.2 s = 6 frames: the lead-in (30 frames) and the 20-frame pause qualify, the 8-frame one does not.
    const p = findPauses(words, 30, 0.5, 0.2);
    assert.deepEqual(p.map((x) => [x.afterWord, x.startFrame, x.endFrame, x.cutFrom, x.cutTo]), [[-1, 0, 30, 6, 30], [1, 70, 90, 76, 90]]);
    assert.deepEqual(findPauses(words, 30, 0.2, 0.2).map((x) => x.afterWord), [-1, 1, 3], "a lower minimum also finds the short one");
    assert.deepEqual(findPauses(words, 30, 0.5, 1), [], "nothing to cut when the kept silence is as long as the pause");
  });

  test("deleting words keeps the pause before them and lets the next word follow it", () => {
    assert.deepEqual(wordsCutRange(words, 2, 3), { fromFrame: 90, toFrame: 138 });
    assert.deepEqual(wordsCutRange(words, 0, 1), { fromFrame: 0, toFrame: 90 }, "the silence before the first word goes with it");
    assert.deepEqual(wordsCutRange(words, 4, 4), { fromFrame: 138, toFrame: 160 }, "the last word ends where it ends");
    assert.throws(() => wordsCutRange(words, 3, 9), /outside the transcript/);
    assert.throws(() => wordsCutRange(words, 3, 2), /outside the transcript/);
  });
});

describe("transcript editing in the studio", () => {
  const dir = path.join(tmp, "ws", "p");
  let store: ProjectStore;
  let api: ReturnType<typeof createEditorAPI>;
  const aligned = [
    { word: "Alpha", start: 1, end: 1.5 }, { word: "beta", start: 1.5, end: 2 },
    { word: "gamma", start: 4, end: 4.5 }, { word: "delta", start: 4.5, end: 5 },
    { word: "epsilon", start: 7, end: 7.5 }, { word: "zeta", start: 7.5, end: 8 },
  ];
  const call = async (method: string, params: Record<string, unknown> = {}) => (await api.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { project: "p", ...params } }))) as { result?: any; error?: { code: number; message: string } };

  beforeEach(() => {
    // Three 3 s scenes (270 frames). Scene 1 is one picture; scene 2 has two (frames 180-240 / 240-270).
    const legacy: LegacyTimeline = {
      version: 2, fps: 30, width: 1920, height: 1080, voice: touch(path.join(tmp, "media", "voice.wav")), music: { files: [], volumeDb: -18 }, motion: { sfx: false, sfxDb: -14 }, captions: { enabled: false }, logo: null,
      scenes: [
        { id: 0, startFrame: 0, endFrame: 90, motion: "none", transition: "cut", asset: { path: touch(path.join(tmp, "media", "a.png")), kind: "image", source: "local" } },
        { id: 1, startFrame: 90, endFrame: 180, motion: "none", transition: "cut", asset: { path: touch(path.join(tmp, "media", "b.png")), kind: "image", source: "local" } },
        {
          id: 2, startFrame: 180, endFrame: 270, motion: "none", transition: "cut",
          asset: { path: touch(path.join(tmp, "media", "c.mp4")), kind: "video", source: "youtube_exact_model", shots: [{ path: touch(path.join(tmp, "media", "c.mp4")), kind: "video", in: 0, frames: 60 }, { path: touch(path.join(tmp, "media", "d.mp4")), kind: "video", in: 0, frames: 30 }] },
        },
      ],
    };
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    writeTimelineV3(dir, fromLegacyTimeline(legacy, { 0: "a", 1: "b", 2: "c" }));
    fs.writeFileSync(path.join(dir, "aligned.json"), JSON.stringify({ words: aligned }));
    store = new ProjectStore(() => dir);
    api = createEditorAPI({ store, dirOf: () => dir, validProject: () => true, render: () => {}, isBusy: () => false, categoryOf: () => "pistol", musicLibrary: () => [] });
  });

  test("the transcript is on the timeline's clock and follows cuts", async () => {
    const t = (await call("editor.transcript")).result;
    assert.deepEqual(t.words.map((x: TranscriptWord) => [x.text, x.startFrame, x.endFrame]), [["Alpha", 30, 45], ["beta", 45, 60], ["gamma", 120, 135], ["delta", 135, 150], ["epsilon", 210, 225], ["zeta", 225, 240]]);
    assert.deepEqual(t.pauses.map((x: { afterWord: number }) => x.afterWord), [-1, 1, 3]);
    assert.equal(t.savedFrames, (30 - 6) + (120 - 60 - 6) + (210 - 150 - 6));
    // Cut seconds 2-4 (frames 60-120): the words in it are gone, later ones move 60 frames left.
    store.apply("p", null, [{ op: "cutRange", fromFrame: 60, toFrame: 120 }]);
    const after = transcriptWords(store.get("p").tl, aligned);
    assert.deepEqual(after.map((x) => [x.text, x.startFrame]), [["Alpha", 30], ["beta", 45], ["gamma", 60], ["delta", 75], ["epsilon", 150], ["zeta", 165]]);
  });

  test("deleting words cuts the same range out of voice, pictures and scenes in one undo step", async () => {
    const rev = (await call("editor.open")).result.revision;
    const r = (await call("editor.deleteWords", { baseRevision: rev, from: 2, to: 3 })).result; // gamma delta
    // From gamma's start (120) to epsilon's start (210): 90 frames, the pause before gamma stays.
    assert.equal(r.removedFrames, 90);
    const tl = store.get("p").tl;
    assert.equal(toNumber(tl.duration) * 30, 180);
    assert.deepEqual(transcriptWords(tl, aligned).map((x) => x.text), ["Alpha", "beta", "epsilon", "zeta"]);
    assert.deepEqual(r.view.dirty.sort(), [1, 2], "scenes 1 and 2 were cut into; no scene is left over");
    store.undo("p", null);
    assert.equal(toNumber(store.get("p").tl.duration) * 30, 270);
  });

  test("tighten pauses: every long pause shortened in one atomic edit", async () => {
    const rev = (await call("editor.open")).result.revision;
    const r = (await call("editor.tightenPauses", { baseRevision: rev })).result;
    assert.equal(r.pauses, 3);
    assert.equal(r.removedFrames, 24 + 54 + 54);
    const tl = store.get("p").tl;
    assert.equal(toNumber(tl.duration) * 30, 270 - 132);
    // Every word keeps its length and the gaps between words are now the kept 6 frames (the lead-in too).
    const t = (await call("editor.transcript")).result;
    assert.deepEqual(t.words.map((x: TranscriptWord) => [x.text, x.endFrame - x.startFrame]), [["Alpha", 15], ["beta", 15], ["gamma", 15], ["delta", 15], ["epsilon", 15], ["zeta", 15]]);
    assert.deepEqual(t.words.map((x: TranscriptWord, i: number) => x.startFrame - (t.words[i - 1]?.endFrame ?? 0)), [6, 0, 6, 0, 6, 0]);
    assert.equal(t.pauses.length, 0, "nothing left to tighten");
    store.undo("p", null);
    assert.equal(toNumber(store.get("p").tl.duration) * 30, 270, "one undo restores all three cuts");
    assert.match((await call("editor.tightenPauses", { baseRevision: store.get("p").revision, minGapSec: 5 })).error!.message, /no pause is long enough/);
  });

  test("words that start between frames are deleted completely and their neighbours stay", async () => {
    // Real times: 3.99 s is frame 119.7 and 4.99 s is frame 149.7 (rounding to the nearest frame would clip one and swallow the other).
    fs.writeFileSync(path.join(dir, "aligned.json"), JSON.stringify({ words: [{ word: "one", start: 1, end: 1.5 }, { word: "two", start: 3.99, end: 4.5 }, { word: "three", start: 4.5, end: 4.99 }, { word: "four", start: 4.99, end: 5.4 }, { word: "five", start: 7, end: 7.5 }] }));
    const rev = (await call("editor.open")).result.revision;
    await call("editor.deleteWords", { baseRevision: rev, from: 1, to: 2 }); // two three
    const left = transcriptWords(store.get("p").tl, JSON.parse(fs.readFileSync(path.join(dir, "aligned.json"), "utf8")).words).map((x) => x.text);
    assert.deepEqual(left, ["one", "four", "five"], "neither word of the range survives as a clipped piece, and the next word is not cut");
  });

  test("a cut that would leave a few-frame picture hands the time to its neighbour", () => {
    const frames = (sceneId: number) => store.get("p").tl.tracks.find((t) => t.kind === "broll")!.clips.filter((c) => c.sceneId === sceneId).map((c) => Math.round(toNumber(c.duration) * 30));
    // Scene 2's pictures are frames 180-240 and 240-270. Cutting 235-267 would leave 3 frames of the second one.
    store.apply("p", null, [{ op: "cutRange", fromFrame: 235, toFrame: 267 }]);
    assert.deepEqual(frames(2), [58], "the first picture took over: 55 + 3 frames, one picture");
    assert.equal(toNumber(store.get("p").tl.duration) * 30, 238);
    // Cutting 183-215 would leave 3 frames of the first picture in front of the cut: the next one starts earlier.
    store.undo("p", null);
    store.apply("p", null, [{ op: "cutRange", fromFrame: 183, toFrame: 215 }]);
    assert.ok(frames(2).every((n) => n >= 6), `no picture under 6 frames: ${frames(2)}`);
    assert.equal(frames(2).reduce((a, b) => a + b, 0), 90 - 32, "the scene keeps all the time that is left");
  });

  test("stale revisions and bad ranges are rejected without editing", async () => {
    const rev = (await call("editor.open")).result.revision;
    assert.equal((await call("editor.deleteWords", { baseRevision: rev + 5, from: 0, to: 0 })).error?.code, -32001);
    assert.equal((await call("editor.deleteWords", { baseRevision: rev, from: 3, to: 99 })).error?.code, -32602);
    assert.equal((await call("editor.deleteWords", { baseRevision: rev, from: "a", to: 1 })).error?.code, -32602);
    assert.equal((await call("editor.edit", { baseRevision: rev, ops: [{ op: "cutRange", fromFrame: 0, toFrame: 250 }] })).error?.code, -32000, "at least 1 second has to stay");
    assert.equal(store.get("p").revision, rev);
  });
});
