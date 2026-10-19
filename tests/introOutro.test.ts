import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyBounds, findBounds, heuristicBounds, OUTRO_RE, pickBounds, type BoundSentence } from "../src/lib/planner/introOutro.js";
import { detectSections } from "../src/lib/planner/structure.js";
import { heuristicLabels } from "../src/lib/planner/label.js";
import { sectionsFromScript } from "../src/commands/plan.js";
import { loadNiche } from "../src/lib/niche.js";
import type { Section } from "../src/lib/scenes.js";

/** Sentences back to back, each `len` s long. */
const timed = (texts: string[], len = 5): BoundSentence[] => texts.map((text, i) => ({ text, start: i * len, end: (i + 1) * len }));
const filler = (n: number, word = "Here is more detail about the topic.") => Array.from({ length: n }, () => word);

describe("outro phrases", () => {
  test("common wrap-ups are recognised", () => {
    for (const t of [
      "So which one would you pick?",
      "Before you go, check the links below.",
      "Final thoughts: buy the cheaper one.",
      "If I had to choose just one, it's the Honda.",
      "And there you have it.",
      "That's my list for this year.",
      "Thanks for watching!",
      "Hope this helped you decide.",
    ])
      assert.ok(OUTRO_RE.test(t), t);
  });
  test("ordinary lines are not", () => {
    for (const t of ["This mower has a 21 inch deck.", "Which is why the battery matters.", "You would pick this for small yards."]) assert.ok(!OUTRO_RE.test(t), t);
  });
});

describe("heuristicBounds", () => {
  test("hook = first sentence(s) until >= 3 s", () => {
    const s = [{ text: "Stop.", start: 0, end: 1.2 }, { text: "This one tool cut my mowing time in half.", start: 1.2, end: 4.4 }, ...timed(filler(30)).map((x) => ({ ...x, start: x.start + 4.4, end: x.end + 4.4 }))];
    assert.equal(heuristicBounds(s, 160).hookEnd, 4.4);
  });

  test("an explainer (no countdown) gets an outro from its wrap-up line near the end", () => {
    const s = timed([...filler(30), "So which one would you pick?", "Let me know below."]);
    const b = heuristicBounds(s, 160);
    assert.equal(b.outroStart, 150);
  });

  test("a wrap-up phrase in the middle of the video is not the outro", () => {
    const s = timed(["Hook line here.", ...filler(5), "Let me know in the comments what you use.", ...filler(40)]);
    assert.equal(heuristicBounds(s, s.length * 5).outroStart, undefined);
  });

  test("a closing call to action is the outro when there is no wrap-up line", () => {
    const s = timed([...filler(30), "Subscribe for more reviews like this."]);
    assert.equal(heuristicBounds(s, 155).outroStart, 150);
  });
});

describe("pickBounds (LLM answer checks)", () => {
  const s = timed(["Hook.", "More hook.", ...filler(40), "Final verdict time.", "Bye."]);
  const dur = s.length * 5;
  const fb = heuristicBounds(s, dur);

  test("valid indices become times", () => {
    const b = pickBounds({ hook_end_sentence: 1, intro_end_sentence: 3, outro_start_sentence: 42 }, s, dur, fb);
    assert.deepEqual({ h: b.hookEnd, i: b.introEnd, o: b.outroStart, src: b.source }, { h: 10, i: 20, o: 210, src: "llm" });
  });

  test("an outro in the middle or out-of-range indices fall back per field", () => {
    const b = pickBounds({ hook_end_sentence: 99, intro_end_sentence: 40, outro_start_sentence: 10 }, s, dur, fb);
    assert.equal(b.hookEnd, fb.hookEnd);
    assert.equal(b.introEnd, undefined); // 205 s is past the first 40 %
    assert.equal(b.outroStart, fb.outroStart);
  });

  test("findBounds uses the injected LLM and survives its failure", async () => {
    const ok = await findBounds(s, dur, { useLlm: true, ask: async () => ({ hook_end_sentence: 0, intro_end_sentence: null, outro_start_sentence: 42 }) });
    assert.equal(ok.outroStart, 210);
    const failed = await findBounds(s, dur, { useLlm: true, ask: async () => { throw new Error("rate limited"); } });
    assert.deepEqual(failed, fb);
  });

  test("a countdown's outro may not start before its last header", async () => {
    const b = await findBounds(s, dur, { useLlm: true, afterIdx: 43, ask: async () => ({ hook_end_sentence: 0, intro_end_sentence: null, outro_start_sentence: 42 }) });
    assert.equal(b.outroStart, undefined);
  });
});

describe("applyBounds", () => {
  const s = timed([...filler(30), "So there you have it.", "Thanks for watching."]);
  const body: Section[] = [{ id: 0, kind: "body", start: 0, end: 160 }];

  test("a one-section explainer gets intro, body and outro", () => {
    const out = applyBounds(body, { hookEnd: 5, outroStart: 150, source: "heuristic" }, s, 160, 6);
    assert.deepEqual(out.map((x) => [x.kind, x.start, x.end]), [["intro", 0, 10], ["body", 10, 150], ["outro", 150, 160]]);
    assert.equal(out[0].hookEnd, 5);
  });

  test("an outro shorter than one scene is not split off", () => {
    const out = applyBounds(body, { hookEnd: 5, outroStart: 157, source: "heuristic" }, s, 160, 6);
    assert.ok(!out.some((x) => x.kind === "outro"));
  });

  test("script-labelled sections are kept; only the hook is added", () => {
    const lab: Section[] = [{ id: 0, kind: "intro", start: 0, end: 20 }, { id: 1, kind: "item", start: 20, end: 160, product_name: "X" }];
    const out = applyBounds(lab, { hookEnd: 4, outroStart: 150, source: "llm" }, s, 160, 6, true);
    assert.deepEqual(out.map((x) => x.kind), ["intro", "item"]);
    assert.equal(out[0].hookEnd, 4);
  });
});

describe("countdown detection", () => {
  test("'Final thoughts' after the last item becomes the outro", () => {
    const texts = ["Five mowers, one winner.", ...filler(2), "Number 3 is the Honda HRX.", ...filler(8), "Number 2 is the Toro Recycler.", ...filler(8), "Number 1 is the Ego LM.", ...filler(6), "Final thoughts: the Ego wins for most yards.", "See you next time."];
    const s = timed(texts).map((x, id) => ({ ...x, id, firstWord: 0, lastWord: 0, paragraph: 0 }));
    const kinds = detectSections(s, s.length * 5, []).map((x) => x.kind);
    assert.deepEqual(kinds, ["intro", "item", "item", "item", "outro"]);
  });
});

describe("labelled scripts", () => {
  test("a non-product beat between items is a body section, not 'outro'", () => {
    const sentences = [0, 1, 2, 3].map((p) => ({ id: p, text: "x", start: p * 20, end: p * 20 + 20, firstWord: 0, lastWord: 0, paragraph: p }));
    const secs = sectionsFromScript(
      [
        { label: "Hook", kind: "intro" },
        { label: "Honda", kind: "item", product_name: "Honda" },
        { label: "Buying guide", kind: "body" },
        { label: "Wrap", kind: "outro" },
      ],
      { sentences },
      80,
    );
    assert.deepEqual(secs.map((x) => x.kind), ["intro", "item", "body", "outro"]);
    assert.equal(secs[2].label, "Buying guide");
  });
});

describe("intro labels", () => {
  test("the first intro scene is footage, not a 'Top Picks' card", () => {
    const sections: Section[] = [{ id: 0, kind: "intro", start: 0, end: 8, hookEnd: 4 }, { id: 1, kind: "item", start: 8, end: 20, rank: 1, product_name: "Honda HRX" }];
    const spans = [{ start: 0, end: 8, section: 0, text: "Stop buying the wrong mower." }, { start: 8, end: 20, section: 1, text: "Number 1 is the Honda HRX." }];
    const scenes = heuristicLabels(spans, sections, loadNiche("listicle"));
    assert.notEqual(scenes[0].type, "graphic");
    assert.ok(!scenes.some((x) => x.graphic?.kind === "intro_card"));
  });
});
