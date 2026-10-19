import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { findKeywordMoments, keywordWindow, parseJson3, parseVtt, segmentsToWords, wordsForVideo, type CaptionWord } from "../src/lib/agents/youtube/ytExtractor.js";

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

describe("transcript chain: youtube-transcript-api screen -> yt-dlp word captions -> Whisper", () => {
  const v = { url: "https://www.youtube.com/watch?v=abcdefghijk", title: "Ruger Security-9 review", duration: 600 };
  const says = (word: string) => (w: CaptionWord[]) => findKeywordMoments(w, word).length > 0;
  const words = (text: string, t0 = 10): CaptionWord[] => text.split(" ").map((x, i) => ({ text: x, t: t0 + i * 0.3 }));

  test("transcript lines become evenly spread words; [Music] / [ __ ] are dropped", () => {
    const w = segmentsToWords([{ text: "check the [Music] trigger pull", start: 10, duration: 2 }, { text: "[ __ ]", start: 12, duration: 1 }]);
    assert.deepEqual(w, [{ text: "check", t: 10 }, { text: "the", t: 10.5 }, { text: "trigger", t: 11 }, { text: "pull", t: 11.5 }]);
  });

  test("keyword never spoken in the quick transcript: skipped, nothing else fetched", async () => {
    const calls: string[] = [];
    const r = await wordsForVideo(v, says("trigger"), {
      whisper: () => true, prompt: "",
      deps: { quick: async () => (calls.push("quick"), { words: words("nice slide and grip"), kind: "auto" }), captions: async () => (calls.push("captions"), null), whisper: async () => (calls.push("whisper"), null) },
    });
    assert.equal(r.words, null);
    assert.match(r.reason, /not spoken/);
    assert.deepEqual(calls, ["quick"]);
  });

  test("spoken -> exact word captions win; if yt-dlp fails the line-timed transcript is used", async () => {
    const cap = { words: words("the trigger is light", 42), kind: "auto", duration: 600 };
    const a = await wordsForVideo(v, says("trigger"), { whisper: () => true, prompt: "", deps: { quick: async () => ({ words: words("the trigger is light"), kind: "auto" }), captions: async () => cap } });
    assert.equal(a.words?.kind, "auto captions");
    assert.equal(a.words?.words[1].t, 42.3);
    const b = await wordsForVideo(v, says("trigger"), { whisper: () => true, prompt: "", deps: { quick: async () => ({ words: words("the trigger is light"), kind: "manual" }), captions: async () => null } });
    assert.equal(b.words?.kind, "manual transcript (line timing)");
  });

  test("no captions anywhere -> Whisper, only while the budget lasts", async () => {
    let budget = 1;
    const deps = { quick: async () => null, captions: async () => null, whisper: async () => ({ words: words("trigger"), duration: 500, device: "cpu" }) };
    const a = await wordsForVideo(v, says("trigger"), { whisper: () => budget-- > 0, prompt: "Ruger Security-9", deps });
    assert.equal(a.words?.kind, "whisper (cpu)");
    assert.equal(a.words?.duration, 500);
    const b = await wordsForVideo(v, says("trigger"), { whisper: () => budget-- > 0, prompt: "", deps });
    assert.equal(b.words, null);
    assert.match(b.reason, /budget/);
  });
});
