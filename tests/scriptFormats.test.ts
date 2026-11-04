import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-sfmt-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.EMBEDDINGS = "off";

const S = await import("../src/lib/agents/llm/settings.js");
const F = await import("../src/lib/agents/script/formats.js");
const Bt = await import("../src/lib/agents/script/beats.js");
const { buildOutline } = await import("../src/lib/agents/script/outline.js");
const { writeScript } = await import("../src/lib/agents/script/index.js");
const { selfRepetition } = await import("../src/lib/agents/script/selfRepeat.js");
const H = await import("../src/lib/channelHistory.js");
const { cleanBrief } = await import("../src/lib/channelBrief.js");
const { createVideo } = await import("../src/lib/orchestrator/wizard.js");
const { readConfig, stageSteps } = await import("../src/lib/orchestrator/pipeline.js");
const { paths } = await import("../src/lib/paths.js");

const CH = "zz-sfmt-test";
const made: string[] = [];
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(paths.channels, CH), { recursive: true, force: true });
  for (const p of made) fs.rmSync(path.join(paths.workspace, p), { recursive: true, force: true });
});
S.saveLlmSettings({ primary: "off" });
const countW = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

describe("formats", () => {
  test("suggested from the title; countdown otherwise", () => {
    assert.equal(F.suggestFormat("Glock 19 vs Sig P320: which is better?"), "versus");
    assert.equal(F.suggestFormat("5 Myths About Hollow Points"), "myth-vs-reality");
    assert.equal(F.suggestFormat("The History of the AK-47"), "history-of");
    assert.equal(F.suggestFormat("Every Type of Knife Steel Explained"), "every-x-explained");
    assert.equal(F.suggestFormat("Best Budget Flashlights 2026"), "countdown");
  });

  test("item rules: versus is exactly two", () => {
    assert.match(F.itemsProblem("versus", ["A", "B", "C"]) ?? "", /at most 2/);
    assert.equal(F.itemsProblem("versus", ["A", "B"]), null);
    assert.match(F.itemsProblem("countdown", ["A"]) ?? "", /at least 2/);
  });

  test("every format: budgets add up, its own sections; head to head may state both sides' facts", async () => {
    for (const id of F.FORMAT_IDS) {
      const items = id === "versus" ? ["Alpha", "Bravo"] : ["Alpha", "Bravo", "Charlie"];
      const o = await buildOutline("lights", items, 1200, [], () => {}, null, id);
      assert.equal(o.format, id);
      assert.equal(o.sections.reduce((s, x) => s + x.words, 0), 1200, id);
      assert.equal(o.sections[0].kind, "intro");
      assert.equal(o.sections.at(-1)!.kind, "outro");
      if (id === "versus") {
        assert.deepEqual(o.sections.map((s) => s.kind), ["intro", "product", "product", "compare", "outro"]);
        assert.deepEqual(o.sections[3].factItems, ["Alpha", "Bravo"]);
      }
    }
  });

  test("rule beats per format: a loop paid off at the end, never given away by the promise", async () => {
    for (const id of F.FORMAT_IDS) {
      const items = id === "versus" ? ["Alpha", "Bravo"] : ["Alpha", "Bravo", "Charlie"];
      const o = await buildOutline("lights", items, 1200, [], () => {}, null, id);
      const sh = await Bt.planBeats(o);
      assert.equal(sh.format, id);
      assert.equal(sh.loops.length, 1, id);
      const l = sh.loops[0];
      assert.ok(l.paidOffInSection > l.plantedInSection, id);
      assert.ok(!sh.promise.toLowerCase().includes(l.answerKey.toLowerCase()), `${id}: the promise says "${l.answerKey}"`);
      assert.ok(!sh.hook.idea.toLowerCase().includes(l.answerKey.toLowerCase()), `${id}: the hook says "${l.answerKey}"`);
    }
  });
});

/** A fake writer that follows the beat lines (as a good model would). */
const beatWriter = (copyFrom?: { text: string; once: { done: boolean } }) => async (_s: string, user: string) => {
  const target = Number(/Target: (\d+) words/.exec(user)![1]);
  const beats = /Beats for this section:\n((?:- .+\n?)+)/.exec(user)?.[1] ?? "";
  if (copyFrom && !copyFrom.once.done && /Alpha on its own/.test(user)) {
    copyFrom.once.done = true;
    return copyFrom.text.split(" ").slice(0, target).join(" ");
  }
  const out: string[] = [];
  if (/Start with the hook/.test(beats)) out.push("Alpha or Bravo: which one deserves your money? By the end you'll know which one fits you.");
  if (/re-hook/.test(beats)) out.push("But here's the catch most buyers miss.");
  const pay = /say "([^"]+)"\./.exec(beats);
  if (pay) out.push(`The ${pay[1]} is simple: pick the one you will carry.`);
  const facts = [...(/Facts you may state \(and only these\):\n((?:- .+\n?)+)/.exec(user)?.[1] ?? "").matchAll(/^- (.+?): (.+)$/gm)].map((m) => `The ${m[1]} is ${m[2]}.`);
  out.push(...facts);
  const filler = "It is simple to carry and easy to use every day on short walks".split(" ");
  let k = 0;
  while (countW(out.join(" ")) < target) out.push(filler[k++ % filler.length] + (k % 10 === 0 ? "." : ""));
  return out.join(" ").split(" ").slice(0, target).join(" ") + ".";
};

describe("versus script end to end", () => {
  test("retention passes; the head-to-head states both sides' sourced facts; nothing unsourced", async () => {
    const factsFile = path.join(tmp, "facts.json");
    fs.writeFileSync(factsFile, JSON.stringify([{ product: "Alpha", label: "Weight", value: "12 oz", url: "https://a.example", title: "A" }, { product: "Bravo", label: "Weight", value: "15 oz", url: "https://b.example", title: "B" }]));
    const { report, text } = await writeScript(path.join(tmp, "v1"), { topic: "lights", products: ["Alpha", "Bravo"], targetWords: 900, format: "versus", factsFile, ask: beatWriter() });
    assert.equal(report.outline.format, "versus");
    assert.equal(report.retention.status, "pass", report.retention.problems.join("; "));
    assert.deepEqual(report.claims.unsourced, []);
    assert.match(text, /Alpha Weight is 12 oz/);
    assert.ok(report.withinTolerance);
  });
});

describe("self-repetition (our own videos)", () => {
  // No digits: the copy must not be refused for unsourced numbers before the repetition check sees it.
  const NAMES = ["red", "blue", "green", "black", "white", "grey", "amber", "olive", "sand", "teal"];
  const OLD = Array.from({ length: 30 }, (_, i) => `our older video said the beam on the ${NAMES[i % 10]} lamp reaches far and the clip holds tight on a belt`).join(" ");

  test("a section copied from our own earlier script is flagged; a fresh one is not", async () => {
    H.recordHistory(CH, { project: "older-video", title: "Alpha vs Bravo: which light wins", topic: "lights", text: OLD });
    const r = await selfRepetition(CH, [OLD.split(" ").slice(0, 120).join(" "), "A completely new section about water filters and how to clean them after a trip."], "Alpha vs Bravo: which light wins", { exclude: "new-one" });
    assert.equal(r.checkedAgainst, 1);
    assert.equal(r.sections[0].flagged, true);
    assert.equal(r.sections[1].flagged, false);
    assert.ok(r.title?.flagged);
    assert.equal((await selfRepetition(CH, ["x"], "t", { exclude: "older-video" })).checkedAgainst, 0, "a project is never checked against itself");
  });

  test("writeScript rewrites the copied section once, reports it, and adds the new script to the history", async () => {
    const brief = cleanBrief(CH, { name: "Test", wpm: 150 });
    const logs: string[] = [];
    const once = { done: false };
    const dir = path.join(tmp, "new-video");
    const { report } = await writeScript(dir, { topic: "lights", products: ["Alpha", "Bravo"], targetWords: 900, format: "versus", brief, title: "Alpha or Bravo for night walks", ask: beatWriter({ text: OLD, once }), log: (m) => logs.push(m) });
    assert.ok(logs.some((l) => /too close to our own earlier video "Alpha vs Bravo: which light wins"/.test(l)), logs.join("\n"));
    assert.ok(report.selfRepetition?.clean, JSON.stringify(report.selfRepetition));
    const hist = H.loadHistory(CH);
    assert.deepEqual(hist.map((h) => h.project).sort(), ["new-video", "older-video"]);
    assert.ok(H.pastTitles(CH).includes("Alpha or Bravo for night walks"));
  });
});

describe("wizard + pipeline", () => {
  test("the format is saved and passed to the script step; versus refuses three items", () => {
    assert.throws(() => createVideo({ topic: "zz sfmt a vs b vs c", products: ["A", "B", "C"], format: "versus" }), /at most 2/);
    const { project } = createVideo({ topic: "zz sfmt alpha vs bravo", products: ["Alpha", "Bravo"], format: "versus", channel: "default" });
    made.push(project);
    assert.equal(readConfig(project)?.format, "versus");
    const w = stageSteps("writing", project, readConfig(project));
    assert.deepEqual(w[0].slice(-2), ["--format", "versus"]);
    const { project: p2 } = createVideo({ topic: "zz sfmt best lights", products: ["A", "B"] });
    made.push(p2);
    assert.equal(readConfig(p2)?.format, undefined, "countdown is the default and not written");
  });
});
