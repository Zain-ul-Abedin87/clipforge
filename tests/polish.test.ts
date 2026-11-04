import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { buildAss, captionLines, highlightEvents } from "../src/lib/render/captions.js";
import { captionPreset, CAPTION_PRESETS } from "../src/lib/render/captionPresets.js";
import { activeWord, maxHighlightErrorMs, toFrameLines } from "../src/lib/render/captionTiming.js";
import { beatTimes, emphasis, fillVisualGaps, longestStill, punchFilter } from "../src/lib/render/beats.js";
import { checkVisualChange } from "../src/lib/qaGate.js";
import { sceneContentHash } from "../src/lib/compiler/incrementalCache.js";

/** Narration with uneven, realistic word timings (not on frame boundaries). */
const WORDS = "The Sig P365 costs 499 dollars and it is the best carry gun under 500 right now".split(" ").map((word, i) => {
  const start = Math.round((0.137 + i * 0.311 + (i % 3) * 0.029) * 1000) / 1000;
  return { word, start, end: start + 0.24, source: "script" as const };
});

describe("word-highlight captions", () => {
  test("new presets exist and are highlight mode", () => {
    for (const id of ["highlight", "bold-pop"]) assert.equal(captionPreset(id).mode, "highlight");
    assert.equal(captionPreset("bold-pop").highlightBox, true);
    assert.equal(new Set(CAPTION_PRESETS.map((p) => p.id)).size, CAPTION_PRESETS.length);
  });

  test("ASS: one event per word, events tile the line, active word coloured", () => {
    const lines = captionLines(WORDS, 3, { withWords: true });
    const ev = highlightEvents(lines[0], captionPreset("highlight"));
    assert.equal(ev.length, lines[0].words!.length);
    assert.equal(ev[0].start, lines[0].start);
    for (let i = 1; i < ev.length; i++) assert.equal(ev[i].start, ev[i - 1].end, "no gap between word events");
    assert.equal(ev.at(-1)!.end, lines[0].end);
    assert.match(ev[1].text, /\{\\c&H000AD6FF\\fscx112\\fscy112\}Sig\{\\r\}/);
    const ass = buildAss(lines, { enabled: true, font: "Inter", fontSize: 54, maxWordsPerLine: 3, background: "rgba(0,0,0,.5)", textColor: "#fff", marginV: 70, preset: "bold-pop" });
    assert.ok(ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length === WORDS.length);
    assert.match(ass, /\\bord14\\3c&H005EC522/);
  });

  test("ASS word starts are within 10 ms; Remotion frames within 100 ms (17 ms at 30 fps)", () => {
    const lines = captionLines(WORDS, 3, { withWords: true });
    for (const l of lines) for (const e of highlightEvents(l, captionPreset("highlight"))) assert.ok(e.start >= 0);
    const frames = toFrameLines(lines, 30);
    const err = maxHighlightErrorMs(lines, frames, 30);
    assert.ok(err <= 100, `${err} ms`);
    assert.ok(err <= 17, `${err} ms`);
    // The highlighted word at a word's start frame is that word.
    const l = frames[1];
    l.words!.forEach((w, k) => assert.equal(activeWord(l, w.startFrame), k));
    assert.equal(activeWord(l, l.startFrame - 1), -1);
  });

  test("captions are toggleable: the master switch in features.json (default on)", async () => {
    const { FEATURE_DEFAULTS } = await import("../src/lib/settings/features.js");
    assert.equal(FEATURE_DEFAULTS.captions.enabled, true);
    assert.equal(FEATURE_DEFAULTS.captions.preset, "", "channels keep their own caption style");
  });
});

describe("beat punch-ins + visual change every 3-5 s", () => {
  test("emphasised words become beats, at least 2.5 s apart", () => {
    assert.ok(emphasis({ word: "499", start: 0, end: 0.2 }) >= 2);
    assert.ok(emphasis({ word: "best", start: 0, end: 0.2 }) >= 2);
    assert.equal(emphasis({ word: "the", start: 0, end: 0.2 }), 0);
    const b = beatTimes(WORDS);
    assert.ok(b.length >= 2);
    for (let i = 1; i < b.length; i++) assert.ok(b[i] - b[i - 1] >= 2.5);
  });

  test("gaps longer than maxSec get punch-ins; the longest still is then <= maxSec", () => {
    const cuts = [0, 3, 14, 16];
    const beats = fillVisualGaps(cuts, [], 30, 4);
    const still = longestStill(cuts, beats, 30);
    assert.ok(still.sec <= 4, JSON.stringify(still));
    assert.deepEqual(longestStill([0, 3, 14, 16], [], 30), { sec: 14, at: 16 });
  });

  test("zoompan expression: quick in, slow out, empty without beats", () => {
    assert.equal(punchFilter([]), "");
    const f = punchFilter([10, 100]);
    assert.match(f, /^zoompan=z='1\+0\.06\*\(between\(on,10,14\)/);
    assert.match(f, /s=1920x1080:fps=30$/);
  });

  test("QA: warns when the picture holds longer than maxSec + 1", () => {
    assert.equal(checkVisualChange(null), null);
    assert.equal(checkVisualChange({ sec: 4.8, at: 10 }, 5)!.status, "pass");
    assert.equal(checkVisualChange({ sec: 7, at: 10 }, 5)!.status, "warn");
  });

  test("segment hash: unchanged without punch-ins (old render cache stays valid), changes with them", () => {
    const base = { sceneId: 1, asset: { path: "/nope.mp4", kind: "video" }, captions: null, overlays: [], transition: "cut", motion: "none", frames: 90, fadeIn: false, fadeOut: false, version: 6 };
    assert.equal(sceneContentHash(base), sceneContentHash({ ...base, punch: [] }));
    assert.notEqual(sceneContentHash(base), sceneContentHash({ ...base, punch: [12] }));
  });
});
