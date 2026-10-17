import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { audioLevels, frameLevels, microCuts, silentRanges, sliceScene } from "../src/lib/engine/pacing/autoEditor.js";
import { chooseFit, ensureLandscape, fitGraph, isVertical } from "../src/lib/engine/filters/lavfiBuilder.js";
import { combine, judge, promptSet, thresholdsFor } from "../src/lib/agents/vision/clipScorer.js";
import { buildMicroPlan, detectSpecs, lockSubject, microConfig, readMicroPlan } from "../src/lib/planner/activeSubject.js";
import { filterHits } from "../src/lib/agents/youtube/ytExtractor.js";
import { ffmpegPath, ffprobePath } from "../src/lib/tools.js";
import type { Scene } from "../src/lib/scenes.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-engine-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ff = ffmpegPath();

/** words: one every 0.4 s from `from` to `to`, with a sentence end every 8th word. */
const wordsBetween = (from: number, to: number) => {
  const out: { word: string; start: number; end: number }[] = [];
  for (let t = from, k = 0; t < to - 0.2; t += 0.4, k++) out.push({ word: k % 8 === 7 ? "end." : `w${k}`, start: Math.round(t * 100) / 100, end: Math.round((t + 0.35) * 100) / 100 });
  return out;
};

describe("auto-editor silence math", () => {
  test("per-frame peak levels", () => {
    const s = new Int16Array(16000); // 1 s at 16 kHz
    s.fill(16384, 0, 8000); // first half at -6 dBFS
    const lv = frameLevels(s, 16000, 30);
    assert.equal(lv.length, 30);
    assert.equal(lv[0], 0.5);
    assert.equal(lv[29], 0);
  });

  test("threshold, margin and minimum silence", () => {
    const fps30 = 30;
    const lv = new Float32Array(90); // 3 s
    lv.fill(0.3, 0, 30); // speech 0-1 s
    lv.fill(0.3, 60, 90); // speech 2-3 s
    lv[45] = 0.05; // a 1-frame blip in the gap
    // margin 0.2 s (6 frames) on each side of speech and of the blip; silences shorter than 0.15 s dropped
    const s = silentRanges(lv, { threshold: 0.04, margin: 0.2, minSilence: 0.15 });
    assert.deepEqual(s, [{ start: 36, end: 39 }, { start: 52, end: 54 }].filter((r) => r.end - r.start >= Math.round(0.15 * fps30)));
    const loud = silentRanges(lv, { threshold: 0.1, margin: 0.2 });
    assert.deepEqual(loud, [{ start: 36, end: 54 }], "the blip is under a 0.1 threshold");
  });
});

describe("micro-scenes (2.5-4 s)", () => {
  test("every piece is 2.5-4 s, silences win as cut points", () => {
    const words = wordsBetween(0, 12);
    // a pause around 3.0 s (frames 87-93) and one around 6.4 s
    const silences = [{ start: 87, end: 93 }, { start: 189, end: 195 }];
    const cuts = microCuts(0, 12, words, silences);
    const bounds = [0, ...cuts, 12];
    for (let i = 1; i < bounds.length; i++) {
      const d = bounds[i] - bounds[i - 1];
      assert.ok(d >= 2.5 - 1e-9 && d <= 4 + 1e-9, `piece ${i}: ${d}`);
    }
    assert.equal(cuts[0], 3, "cut in the middle of the first silence");
    assert.equal(cuts[1], 6.4, "and of the second");
  });

  test("short scenes are not cut; frame boundaries are exact and contiguous", () => {
    assert.deepEqual(microCuts(10, 13.9, wordsBetween(10, 13.9), []), []);
    const pieces = sliceScene(5.017, 15.983, wordsBetween(5, 16), []);
    assert.equal(pieces[0].startFrame, Math.round(5.017 * 30));
    assert.equal(pieces[pieces.length - 1].endFrame, Math.round(15.983 * 30));
    for (let i = 1; i < pieces.length; i++) assert.equal(pieces[i].startFrame, pieces[i - 1].endFrame);
    assert.ok(pieces.every((p) => (p.endFrame - p.startFrame) / 30 >= 2.4 && (p.endFrame - p.startFrame) / 30 <= 4.04));
    assert.ok(pieces.every((p) => p.text.length > 0));
  });

  test("niche opt-in and MICRO_SCENES override", () => {
    const prev = process.env.MICRO_SCENES;
    delete process.env.MICRO_SCENES;
    try {
      assert.equal(microConfig({ pacing: {} }).enabled, false);
      assert.deepEqual(microConfig({ pacing: { micro: { maxSec: 3.5 } } }), { enabled: true, minSec: 2.5, maxSec: 3.5, targetSec: 3.2 });
      process.env.MICRO_SCENES = "on";
      assert.equal(microConfig({}).enabled, true);
    } finally {
      if (prev === undefined) delete process.env.MICRO_SCENES;
      else process.env.MICRO_SCENES = prev;
    }
  });
});

describe("active subject + spec tags", () => {
  test("specs: longest phrase wins, spoken order kept", () => {
    assert.deepEqual(detectSpecs("Its brushless motor and the 5Ah battery pack").map((s) => s.spec), ["brushless motor", "battery"]);
    assert.deepEqual(detectSpecs("starting with the 21in steel deck").map((s) => s.spec), ["deck"]);
    assert.ok(detectSpecs("thanks to lithium-ion cells")[0].diagramFallback);
    assert.deepEqual(detectSpecs("we loved the color"), []);
  });

  test("a line naming a model wins over its section; otherwise the section's product", () => {
    const products = ["Cat DG671", "EGO LM2135SP", "Ryobi RY401150"];
    const named = lockSubject("the EGO LM2135SP has a brushless motor", "Cat DG671", products);
    assert.equal(named.reason, "named");
    assert.equal(named.productKey, "ego_lm2135sp");
    assert.equal(named.spec?.spec, "brushless motor");
    const section = lockSubject("it folds flat for storage", "Cat DG671", products);
    assert.deepEqual([section.reason, section.productKey, section.spec?.spec], ["section", "cat_dg671", "folding handle"]);
    assert.equal(lockSubject("so which one should you buy", undefined, products).reason, "none");
  });
});

describe("CLIP profiles (scores measured on real frames)", () => {
  // raw scores as clip_score.py returns them: "<text key>|<image key>"
  const raw = (pos: number[], neg: number[]) => Object.fromEntries([...pos.map((v, i) => [`p${i}|x`, v]), ...neg.map((v, i) => [`n${i}|x`, v])]);

  test("both profiles keep every negative prompt; handson adds close-up positives", () => {
    const m = promptSet("machine", "Honda", "HRX217", "lawn mower");
    const h = promptSet("handson", "Honda", "HRX217", "lawn mower", ["blades"]);
    assert.equal(m.positives.length, 1);
    assert.equal(h.positives.length, 3);
    assert.deepEqual(h.negatives, m.negatives, "relaxing never drops a negative (that let presenters through)");
    assert.deepEqual(h.features, [["blades", "Honda HRX217 lawn mower blades close up"]]);
  });

  test("best positive vs worst negative", () => {
    const h = promptSet("handson", "Honda", "HRX217", "lawn mower");
    const s = combine(h, raw([0.2394, 0.2784, 0.25], [0.2232, 0.2, 0.19, 0.1, 0.1]), "x");
    assert.deepEqual([s.pos, s.neg, s.negKind], [0.2784, 0.2232, "person"]);
    assert.equal(judge(s, thresholdsFor("handson")), "keep", "gloved hand on the blade (was a thin +0.016 under machine)");
    const dealer = combine(h, raw([0.2992, 0.29, 0.28], [0.3906, 0.3, 0.2, 0.1, 0.1]), "x");
    assert.equal(judge(dealer, thresholdsFor("handson")), "talking_head");
    const logo = combine(h, raw([0.2666, 0.2, 0.2], [0.2, 0.2, 0.2, 0.2932, 0.1]), "x");
    assert.equal(judge(logo, thresholdsFor("handson")), "off_topic");
  });
});

describe("Shorts", () => {
  const hit = (id: string, url: string, duration: number) => ({ id, url, title: "Honda HRX217 blade change", duration, channel: "c" });

  test("Shorts of 15-60 s pass only when allowed; ordinary videos keep the 45 s minimum", () => {
    const hits = [hit("s", "https://www.youtube.com/shorts/s", 30), hit("v", "https://www.youtube.com/watch?v=v", 30), hit("t", "https://www.youtube.com/shorts/t", 8)];
    assert.deepEqual(filterHits(hits, "Honda", "HRX217", [], true).kept.map((h) => h.id), ["s"]);
    assert.deepEqual(filterHits(hits, "Honda", "HRX217", [], false).kept.map((h) => h.id), []);
  });

  test("fit choice and filter graphs", () => {
    assert.equal(chooseFit({ w: 1920, h: 1080 }), "cover");
    assert.equal(chooseFit({ w: 1280, h: 720 }), "cover");
    assert.equal(chooseFit({ w: 1080, h: 1920 }), "blur_pad");
    assert.equal(chooseFit({ w: 1080, h: 1080 }), "blur_pad");
    assert.ok(isVertical({ w: 1080, h: 1920 }));
    const g = fitGraph("blur_pad");
    assert.match(g, /split=2\[lf_bg\]\[lf_fg\]/);
    assert.match(g, /boxblur=28:2/);
    assert.match(g, /overlay=\(W-w\)\/2:\(H-h\)\/2/);
    assert.match(fitGraph("cover"), /crop=1920:1080/);
  });

  test("a 9:16 clip becomes a 1920x1080 blur-pad clip (FFmpeg)", { skip: ff ? false : "ffmpeg not found" }, async () => {
    const src = path.join(tmp, "short.mp4");
    const out = path.join(tmp, "short_16x9.mp4");
    assert.equal(spawnSync(ff!, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=540x960:rate=30:duration=1", "-pix_fmt", "yuv420p", src]).status, 0);
    const r = await ensureLandscape(ff!, ffprobePath()!, src, out);
    assert.deepEqual(r, { fit: "blur_pad", src: { w: 540, h: 960 } });
    const probe = spawnSync(ffprobePath()!, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", out], { encoding: "utf8" });
    assert.equal(probe.stdout.trim(), "1920,1080");
    const land = path.join(tmp, "land.mp4");
    spawnSync(ff!, ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=1", "-pix_fmt", "yuv420p", land]);
    assert.equal(await ensureLandscape(ff!, ffprobePath()!, land, path.join(tmp, "x.mp4")), null, "16:9 is left alone");
  });
});

describe("micro plan end to end (FFmpeg audio)", { skip: ff ? false : "ffmpeg not found" }, () => {
  test("cuts land in the real pauses of a voiceover", async () => {
    // 12 s "voice": tone, with silences at 2.9-3.3 s and 6.2-6.6 s
    const voice = path.join(tmp, "voice.wav");
    const expr = "if(between(t,2.9,3.3)+between(t,6.2,6.6),0,0.5*sin(2*PI*220*t))";
    assert.equal(spawnSync(ff!, ["-v", "error", "-y", "-f", "lavfi", "-i", `aevalsrc='${expr}':s=16000:d=12`, voice]).status, 0);
    const levels = await audioLevels(ff!, voice);
    assert.equal(levels.length, 360);
    const dir = fs.mkdtempSync(path.join(tmp, "proj-"));
    const scenes = [
      { id: 0, start: 0, end: 12, text: "the EGO LM2135SP has a brushless motor and a steel deck", type: "product", queries: ["x"], product_name: "EGO LM2135SP", section: 1, labeledBy: "heuristic" },
    ] as Scene[];
    const plan = await buildMicroPlan(dir, { ffmpeg: ff!, audio: voice, words: wordsBetween(0, 12), scenes, minSec: 2.5, maxSec: 4, targetSec: 3.2, threshold: 0.04 });
    assert.deepEqual(readMicroPlan(dir)?.scenes.length, plan.scenes.length);
    const cuts = plan.scenes.slice(1).map((m) => m.startFrame / 30);
    // The cut is the centre of each 0.4 s pause (3.1 s / 6.4 s).
    assert.ok(Math.abs(cuts[0] - 3.1) <= 0.05, `first cut ${cuts[0]}`);
    assert.ok(Math.abs(cuts[1] - 6.4) <= 0.05, `second cut ${cuts[1]}`);
    assert.ok(plan.scenes.every((m) => m.productName === "EGO LM2135SP"));
  });
});

describe("micro-scenes: lengths that cannot fit 2.5-4 s", () => {
  test("the piece count that misses the range by less wins", () => {
    assert.deepEqual(microCuts(0, 4.1, wordsBetween(0, 4.1), []), [], "4.1 s: one 4.1 s piece beats two 2.05 s pieces");
    assert.equal(microCuts(0, 4.9, wordsBetween(0, 4.9), []).length, 1, "4.9 s: two 2.45 s pieces beat one 4.9 s piece");
    assert.equal(microCuts(0, 5, wordsBetween(0, 5), []).length, 1, "5 s: two 2.5 s pieces (feasible)");
  });
});
