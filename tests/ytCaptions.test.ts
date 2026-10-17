import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findKeywordMoments, keywordWindow, parseJson3, parseVtt } from "../src/lib/agents/youtube/ytExtractor.js";

// Synthetic captions in YouTube's real json3 shape (auto captions: per-word tOffsetMs; "\n" events).
const JSON3 = JSON.stringify({
  wireMagic: "pb3",
  events: [
    { tStartMs: 0, dDurationMs: 5000 },
    { tStartMs: 240, dDurationMs: 5680, segs: [{ utf8: "check" }, { utf8: " out", tOffsetMs: 240 }, { utf8: " the", tOffsetMs: 480 }, { utf8: " brush-less", tOffsetMs: 640 }, { utf8: " motor", tOffsetMs: 1100 }] },
    { tStartMs: 3350, dDurationMs: 2570, aAppend: 1, segs: [{ utf8: "\n" }] },
    { tStartMs: 74159, dDurationMs: 3521, segs: [{ utf8: "run" }, { utf8: " their", tOffsetMs: 161 }, { utf8: " twin", tOffsetMs: 320 }, { utf8: " blades", tOffsetMs: 640 }] },
    // Uploader caption: one segment per line, words spread evenly over the line.
    { tStartMs: 90000, dDurationMs: 2000, segs: [{ utf8: "brushless motor runs cool" }] },
  ],
});

describe("caption parsing", () => {
  test("json3: per-word times, newline events skipped, plain lines spread evenly", () => {
    const w = parseJson3(JSON3);
    assert.deepEqual(w.slice(0, 5), [
      { text: "check", t: 0.24 }, { text: "out", t: 0.48 }, { text: "the", t: 0.72 }, { text: "brush-less", t: 0.88 }, { text: "motor", t: 1.34 },
    ]);
    assert.deepEqual(w.find((x) => x.text === "blades"), { text: "blades", t: 74.8 });
    assert.deepEqual(w.filter((x) => x.t >= 90).map((x) => x.t), [90, 90.5, 91, 91.5]);
  });

  test("vtt: inline word timings, and rolling auto-caption repeats are dropped", () => {
    const vtt = [
      "WEBVTT",
      "",
      "00:00:01.000 --> 00:00:03.000",
      "the<00:00:01.400><c> brushless</c><00:00:02.000><c> motor</c>",
      "",
      "00:00:03.000 --> 00:00:05.000",
      "the brushless motor",
      "is quiet",
    ].join("\n");
    const w = parseVtt(vtt);
    assert.deepEqual(w.map((x) => x.text), ["the", "brushless", "motor", "is", "quiet"]);
    assert.deepEqual(w.slice(0, 3).map((x) => x.t), [1, 1.4, 2]);
  });
});

describe("keyword moments -> 3-5 s windows", () => {
  const words = parseJson3(JSON3);

  test("phrases match across hyphens, case and simple plurals", () => {
    const m = findKeywordMoments(words, "brushless motor");
    assert.deepEqual(m.map((x) => x.t), [0.88, 90]);
    assert.match(m[0].context, /check out the brush-less motor/);
    assert.equal(findKeywordMoments(words, "blade").length, 1, "plural 'blades' matches 'blade'");
    assert.equal(findKeywordMoments(words, "battery").length, 0);
  });

  test("mentions closer than minGap are merged; a custom matcher can relax spelling", () => {
    const close = [{ text: "motor", t: 10 }, { text: "motor", t: 12 }, { text: "motor", t: 30 }];
    assert.deepEqual(findKeywordMoments(close, "motor").map((x) => x.t), [10, 30]);
    const typo = [{ text: "brushles", t: 5 }];
    assert.equal(findKeywordMoments(typo, "brushless").length, 0);
    assert.equal(findKeywordMoments(typo, "brushless", { matcher: (a, b) => a === b || b.startsWith(a) }).length, 1);
  });

  test("window starts just before the word, is 3-5 s and stays inside the video", () => {
    const m = { keyword: "blades", t: 74.8, tEnd: 74.8, context: "run their twin blades" };
    assert.deepEqual(keywordWindow(m, 466), { start: 74.3, end: 78.3, feature: "blades", keyword: "blades", caption: "run their twin blades" });
    assert.equal(keywordWindow(m, 466, { seconds: 9 }).end - 74.3, 5, "clamped to 5 s");
    assert.deepEqual([keywordWindow({ ...m, t: 0.2 }, 466).start, keywordWindow({ ...m, t: 0.2 }, 466).end], [0, 4]);
    const nearEnd = keywordWindow({ ...m, t: 465.5 }, 466);
    assert.deepEqual([nearEnd.start, nearEnd.end], [462, 466]);
  });
});
