import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-beats-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.EMBEDDINGS = "off";

const S = await import("../src/lib/agents/llm/settings.js");
const J = await import("../src/lib/agents/llm/json.js");
const Bt = await import("../src/lib/agents/script/beats.js");
const { buildOutline } = await import("../src/lib/agents/script/outline.js");
const { writeScript } = await import("../src/lib/agents/script/index.js");
const { cleanBrief } = await import("../src/lib/channelBrief.js");
const { paths } = await import("../src/lib/paths.js");
after(() => {
  J.setJsonAsk(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  // writeScript with a brief records the channel's history.
  fs.rmSync(path.join(paths.channels, "zz-beats-test"), { recursive: true, force: true });
});
S.saveLlmSettings({ primary: "off" });

const PRODUCTS = ["Lamp A", "Lamp B", "Lamp C", "Lamp D", "Lamp E", "Lamp F"];
const countW = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

describe("beat sheet", () => {
  test("re-hooks every wpm x 3 words, snapped to a nearby section start", () => {
    const secs = [0, 150, 450, 900, 1300, 1700].map((startWord, i, a) => ({ startWord, words: (a[i + 1] ?? 1800) - startWord }));
    const r = Bt.scheduleRehooks(secs, 450, 1800);
    assert.deepEqual(r.map((x) => x.section), [2, 3, 4]);
    assert.deepEqual(r.map((x) => x.atWord), [450, 900, 1300], "1300 is a section start within 20% of 1350");
  });

  test("rule plan: question-first hook, #1 withheld and paid off in its own section, promise by word 75", async () => {
    const outline = await buildOutline("budget lights", PRODUCTS, 1800, []);
    const sheet = await Bt.planBeats(outline, { brief: cleanBrief("zz-beats-test", { wpm: 150 }) });
    assert.equal(sheet.source, "fallback");
    assert.equal(sheet.hook.type, "question");
    assert.equal(sheet.promiseByWord, 75);
    assert.equal(sheet.rehookEveryWords, 450);
    assert.equal(sheet.loops.length, 1);
    assert.equal(sheet.loops[0].answerKey, "Lamp F");
    assert.equal(outline.sections[sheet.loops[0].paidOffInSection].product, "Lamp F");
    assert.equal(sheet.rehooks.length, 3);
    const intro = Bt.beatInstructions(sheet, 0).join(" ");
    assert.match(intro, /Start with the hook/);
    assert.match(intro, /Within the first 75 words/);
    assert.match(intro, /Plant this open question/);
    assert.match(Bt.beatInstructions(sheet, sheet.loops[0].paidOffInSection).join(" "), /say "Lamp F"/);
  });

  test("model plan: a loop paid off before it is planted is refused and asked again; the SOP sets a stakes-first hook", async () => {
    // The outline first (its own angle call would go to a real Ollama), then the model on.
    const outline = await buildOutline("budget lights", PRODUCTS.slice(0, 3), 900, []);
    S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local" } });
    let calls = 0;
    J.setJsonAsk(async (system) => {
      calls++;
      assert.match(system, /stakes-first/);
      return {
        hook: { idea: "Buy the wrong light and you will be in the dark when it counts.", withheld: "which light we trust" },
        promise: "By the end you will know which one to buy.",
        sections: outline.sections.map((s, index) => ({ index, angle: `angle ${index} for the section`, turn: "but it runs hot; therefore use the low mode" })),
        loops: [{ question: "Which one do we trust?", answerKey: "Lamp C", plantedInSection: calls === 1 ? 3 : 0, paidOffInSection: calls === 1 ? 1 : 3 }],
        rehookTechniques: [],
      };
    });
    const sop = { hookFormula: { type: "stakes", steps: ["a", "b"], withinSeconds: 20 }, rules: ["open on the risk"], do: ["pay off loops"], dont: ["no early answer"] } as never;
    const logs: string[] = [];
    const sheet = await Bt.planBeats(outline, { sop, log: (m) => logs.push(m) });
    J.setJsonAsk(null);
    S.saveLlmSettings({ primary: "off" });
    assert.equal(calls, 2);
    assert.equal(sheet.source, "model");
    assert.equal(sheet.hook.type, "stakes");
    assert.deepEqual([sheet.loops[0].plantedInSection, sheet.loops[0].paidOffInSection], [0, 3]);
    assert.equal(outline.sections[1].angle, "angle 1 for the section");
    assert.ok(sheet.rulesFromSop.includes("open on the risk"));
  });
});

describe("retention checks", () => {
  const sheet = {
    format: "countdown", wpm: 150, hook: { type: "question" as const, idea: "", withheld: "" }, promise: "", promiseByWord: 75, rehookEveryWords: 100,
    rehooks: [{ section: 1, atWord: 100, technique: "problem" as const }],
    loops: [{ question: "Which one is number one?", answerKey: "Lamp B", plantedInSection: 0, paidOffInSection: 2 }],
    sections: [{ index: 0, startWord: 0, words: 100, turn: "" }, { index: 1, startWord: 100, words: 100, turn: "" }, { index: 2, startWord: 200, words: 100, turn: "" }],
    rulesFromSop: [], source: "fallback" as const,
  };
  const pad = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ") + ".";
  const good = [
    { label: "intro", budget: 100, text: `Which of these two lights is worth your money? By the end you'll know which one fits you. ${pad(82)}` },
    { label: "Lamp A", budget: 100, text: `But here's the catch with cheap lights. ${pad(92)}` },
    { label: "Lamp B", budget: 100, text: `Number one is Lamp B. ${pad(95)}` },
  ];

  test("a script that follows its beats passes", () => {
    const r = Bt.retentionReport(sheet, good);
    assert.equal(r.status, "pass", r.problems.join("; "));
    assert.deepEqual(r.rehooks.gaps, [100]);
    assert.ok(r.loops[0].paidOff && !r.loops[0].revealedEarly);
  });

  test("long hook, no promise, missing re-hook, unpaid loop, a section over 2x budget: all reported", () => {
    const bad = [
      { label: "intro", budget: 100, text: `${pad(45)} Lamp B is great. ${pad(20)}` },
      { label: "Lamp A", budget: 100, text: `It is a lamp. ${pad(250)}` },
      { label: "Lamp B", budget: 100, text: `This one is fine. ${pad(60)}` },
    ];
    const r = Bt.retentionReport(sheet, bad);
    assert.equal(r.status, "fail");
    for (const re of [/hook is \d+ words/, /curiosity gap/, /no promise/, /re-hook\(s\) missing/, /not paid off/, /answered too early/, /over 2x/]) assert.ok(r.problems.some((p) => re.test(p)), `${re} in ${r.problems.join(" | ")}`);
  });

  test("section checks the writer retries on", () => {
    assert.deepEqual(Bt.sectionBeatProblems(sheet, 0, good[0].text), []);
    assert.ok(Bt.sectionBeatProblems(sheet, 0, "Lamp B is the best light you can buy today for anyone. By the end you'll know.").some((p) => /do not reveal/.test(p)));
    assert.ok(Bt.sectionBeatProblems(sheet, 2, "This one is fine.").some((p) => /pay off/.test(p)));
    assert.ok(Bt.sectionBeatProblems(sheet, 1, "It is a lamp. It is small.").some((p) => /re-hook/.test(p)));
    assert.equal(Bt.hookOf("Short one. Is it good? More text."), "Short one. Is it good?");
  });
});

describe("writeScript with beats", () => {
  /** A fake writer that does what the beat lines say (as a good model would). */
  const beatWriter = async (_system: string, user: string) => {
    const target = Number(/Target: (\d+) words/.exec(user)![1]);
    const beats = /Beats for this section:\n((?:- .+\n?)+)/.exec(user)?.[1] ?? "";
    const out: string[] = [];
    if (/Start with the hook/.test(beats)) out.push("Which of these lights is actually worth your money? By the end you'll know which one fits you.");
    if (/re-hook/.test(beats)) out.push("But here's the catch most buyers miss.");
    const pay = /say "(Lamp [A-F])"\./.exec(beats);
    if (pay) out.push(`Number one is ${pay[1]}.`);
    const own = /The section for #\d+: (Lamp [A-F])/.exec(user);
    if (own && !pay) out.push(`Next is ${own[1]}.`);
    const filler = "It is simple to carry and easy to use every day on short walks".split(" ");
    let k = 0;
    while (countW(out.join(" ")) < target) out.push(filler[k++ % filler.length] + (k % 10 === 0 ? "." : ""));
    return out.join(" ").split(" ").slice(0, target).join(" ") + ".";
  };

  test("the written script passes retention_beats; facts-only and +-3% still hold; report has beats + retention", async () => {
    const dir = path.join(tmp, "p");
    const { report } = await writeScript(dir, { topic: "budget lights", products: PRODUCTS, targetWords: 1500, ask: beatWriter, brief: cleanBrief("zz-beats-test", { wpm: 150 }) });
    assert.equal(report.retention.status, "pass", report.retention.problems.join("; "));
    assert.ok(report.withinTolerance);
    assert.deepEqual(report.claims.unsourced, []);
    assert.equal(report.beats.rehooks.length, 2);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "script_report.json"), "utf8"));
    assert.equal(saved.retention.status, "pass");
  });

  test("a writer that ignores the beats is asked again, and the report says what is missing", async () => {
    const dir = path.join(tmp, "q");
    const prompts: string[] = [];
    const lazy = async (_s: string, user: string) => {
      prompts.push(user);
      const target = Number(/Target: (\d+) words/.exec(user)![1]);
      return Array.from({ length: target }, () => "plain").join(" ") + ".";
    };
    const { report } = await writeScript(dir, { topic: "budget lights", products: PRODUCTS, targetWords: 1500, ask: lazy });
    assert.ok(prompts.some((p) => /missed its beats/.test(p)));
    assert.equal(report.retention.status, "fail");
    assert.ok(report.retention.problems.some((p) => /not paid off/.test(p)));
  });
});
