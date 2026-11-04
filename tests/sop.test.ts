import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-sop-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.EMBEDDINGS = "off";

const S = await import("../src/lib/agents/llm/settings.js");
const J = await import("../src/lib/agents/llm/json.js");
const T = await import("../src/lib/agents/sop/transcript.js");
const X = await import("../src/lib/agents/sop/extract.js");
const { paths } = await import("../src/lib/paths.js");

const CH = "zz-sop-test";
after(() => {
  J.setJsonAsk(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(paths.channels, CH), { recursive: true, force: true });
});
S.saveLlmSettings({ primary: "off" });

/** Synthetic countdown transcripts (no real channel's words): hook, promise, items, re-hooks, CTA. */
const NOUNS = ["lantern", "stove", "knife", "radio", "filter", "tarp", "compass", "axe", "flashlight", "water bottle", "sleeping bag", "multitool"];
function fixture(k: number, items: number, punctuated = true): string {
  const s: string[] = [];
  s.push(k % 2 ? `Why do so many campers regret the ${NOUNS[k]} they bought first?` : `If you buy the wrong ${NOUNS[k]} you could lose a whole weekend.`);
  s.push(`By the end you'll know which ${NOUNS[k]} model ${k} people keep for years and which one goes back.`);
  for (let i = items; i >= 1; i--) {
    const n = NOUNS[(k + i) % NOUNS.length];
    s.push(`Number ${i} is the ${n} model ${k}${i} from brand ${String.fromCharCode(65 + i)}.`);
    s.push(`It weighs ${10 + i * 3} ounces and costs ${20 + i * 7} dollars in test round ${k}.`);
    s.push(`But here's the catch with the ${n} variant ${k}${i}, the latch wears out faster than you would expect.`);
    s.push(`So that's why owners of version ${k}${i} carry a spare part in season ${i}.`);
    for (let f = 0; f < 6; f++) s.push(`Detail ${f} of item ${i} in video ${k} covers grip size ${f + i} and finish colour ${f * k}.`);
    if (i === Math.ceil(items / 2)) s.push(`Stick around because number one in list ${k} surprised our whole crew.`);
  }
  s.push(`If this helped, subscribe and leave a comment with the ${NOUNS[k]} you trust in video ${k}.`);
  s.push(`So number one in run ${k} wins because it lasted the full test series ${k}.`);
  const text = s.join(" ");
  return punctuated ? text : text.replace(/[.?!,]/g, "").toLowerCase();
}
const TRANSCRIPTS = [fixture(1, 5), fixture(2, 6), fixture(3, 5, false), fixture(4, 7), fixture(5, 24)].map((text, i) => ({ id: `v${i + 1}`, text, meta: i === 0 ? { durationSec: 300 } : undefined }));

describe("transcript preparation", () => {
  test("sentences or fixed pieces; positions by words; wpm only when the duration is known", () => {
    const p = T.prepareTranscript("v1", TRANSCRIPTS[0].text, { durationSec: 300 });
    assert.ok(p.punctuated);
    assert.equal(T.pctOf(p, 0), 0);
    assert.ok(T.pctOf(p, p.units.length - 1) > 90);
    assert.equal(p.wpm, Math.round(p.totalWords / 5));
    const q = T.prepareTranscript("v3", TRANSCRIPTS[2].text);
    assert.equal(q.punctuated, false);
    assert.ok(q.units.every((u) => u.words <= 18));
    assert.equal(q.wpm, null);
    assert.ok(q.estimatedDuration);
  });

  test("hook types from the opening", () => {
    assert.equal(T.hookTypeOf("Why does this fail? Let's see."), "question");
    assert.equal(T.hookTypeOf("If you buy the wrong one you could lose a weekend."), "stakes");
    assert.equal(T.hookTypeOf("Back in 1952 a small shop changed everything."), "story");
  });

  test("quotes / stripQuoted: 5-word runs from the corpus are found and removed", () => {
    const corpus = T.corpusOf(["the latch wears out faster than you would expect"]);
    assert.ok(T.quotes("note: the latch wears out faster here", corpus));
    assert.ok(!T.quotes("the latch fails early", corpus));
    const r = T.stripQuoted("Point out that the latch wears out faster than you would expect, then compare the prices of all the options side by side and give one clear verdict for every kind of buyer.", corpus);
    assert.ok(r.text && !T.quotes(r.text, corpus), r.text ?? "");
    assert.ok(r.removed >= 5);
    assert.equal(T.stripQuoted("the latch wears out faster than you would expect", corpus).text, null);
  });
});

const allStrings = (s: Record<string, unknown>) => [
  ...(s.hookFormula as { steps: string[] }).steps,
  ...(s.beats as { name: string; technique: string }[]).flatMap((b) => [b.name, b.technique]),
  ...(s.rules as string[]),
  ...(s.do as string[]),
  ...(s.dont as string[]),
];

describe("SOP without a model (rules only)", () => {
  test("valid SOP from 5 transcripts, saved; measured stats; no 5-word run of any transcript", async () => {
    const logs: string[] = [];
    const sop = await X.buildSop({ channel: CH, competitor: "fixture-a", transcripts: TRANSCRIPTS, log: (m) => logs.push(m) });
    assert.ok(X.SopSchema.safeParse(sop).success, JSON.stringify(X.SopSchema.safeParse(sop)));
    assert.equal(sop.stats.videos, 5);
    assert.equal(sop.meta.reduce, "fallback");
    assert.ok(sop.stats.rehookEveryPct !== null && sop.stats.rehookEveryPct > 0);
    assert.ok(sop.stats.ctaPct.length >= 5);
    assert.ok(sop.stats.sectionsPerVideo >= 5);
    assert.deepEqual(sop.beats.map((b) => b.targetPct), [...sop.beats.map((b) => b.targetPct)].sort((a, b) => a - b));
    assert.equal(sop.beats[0].name, "Hook");
    assert.ok(sop.beats.at(-1)!.targetPct >= 90, "the beat sheet keeps its payoff even with many sections");
    const corpus = T.corpusOf(TRANSCRIPTS.map((t) => t.text));
    for (const s of allStrings(sop as unknown as Record<string, unknown>)) assert.ok(!T.quotes(s, corpus), s);
    assert.equal(sop.meta.originality.maxNgram, 0);
    assert.ok(fs.existsSync(X.sopFile(CH, "fixture-a")));
    assert.equal(X.loadSop(CH)?.competitor, "fixture-a");
    assert.match(X.sopText(sop), /Beats:/);
  });
});

describe("SOP with a (fake) model: schema, validation, retries, 8K budget, leak stripping", () => {
  test("refused answers are retried; quoted wording never reaches the SOP; every prompt fits the context", async () => {
    // A small context forces several map chunks and a grouped reduce.
    S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local" }, stages: { script: { numCtx: 3600 } } });
    const sizes: number[] = [];
    let mapCalls = 0;
    let quotedOnce = false;
    let outOfRangeOnce = false;
    let reduceCalls = 0;
    J.setJsonAsk(async (system, user, stage, maxTokens) => {
      sizes.push(J.approxTokens(system) + J.approxTokens(user) - J.promptBudget(stage, maxTokens));
      const lines = [...user.matchAll(/^\[(\d+)\]/gm)].map((m) => Number(m[1]));
      if (lines.length) {
        mapCalls++;
        const lo = Math.min(...lines);
        const hi = Math.max(...lines);
        const quoted = !quotedOnce && lo === 0;
        if (quoted) quotedOnce = true;
        const outOfRange = !quoted && !outOfRangeOnce && lo > 0;
        if (outOfRange) outOfRangeOnce = true;
        return {
          hook: lo === 0 ? { type: "question", technique: quoted ? "asks why do so many campers regret the gear" : "opens on a regret the viewer may share", promise: "names what the viewer will know at the end" } : null,
          rehooks: [{ unit: outOfRange ? hi + 50 : Math.min(hi, lo + 3), technique: "teases the winner to keep viewers" }],
          loops: lo === 0 ? [{ plantedUnit: 1, paidOffUnit: null, technique: "plants the question of which item lasts" }] : [],
          sections: [{ unit: lo, opens: "names the item, its rank and the maker", closes: "ends on a weakness" }],
          factIntro: ["gives weight and price, then a use case"],
          transitions: ["moves on by naming the next rank"],
          turns: [{ unit: lo, kind: "but", technique: "adds a flaw after praise" }],
          cta: [],
          ending: hi >= 40 ? "pays off the winner and asks for a comment" : null,
        };
      }
      reduceCalls++;
      return {
        hookFormula: { type: "question", steps: ["ask a question about a common regret", "hold the answer back", "promise a clear pick"], withinSeconds: 20 },
        beats: [
          { name: "Hook", targetPct: 0, technique: "a question about a regret" },
          { name: "Promise", targetPct: 3, technique: "says what the viewer will know" },
          { name: "Items", targetPct: 10, technique: "each item opens on rank and maker" },
          { name: "Re-hook", targetPct: 50, technique: "teases the winner" },
          { name: "Payoff", targetPct: 95, technique: "reveals the winner" },
        ],
        // The second rule repeats exactly 5 words of a transcript (6+ is refused outright): they must be stripped.
        rules: ["follow praise with one flaw", "point out where the latch wears out faster on cheap models, with the price difference and who should care about it", "close each item on a verdict"],
        do: ["give a number with what it means", "keep sentences short"],
        dont: ["do not reveal the winner early", "do not stack facts without context"],
      };
    });
    const logs: string[] = [];
    const sop = await X.buildSop({ channel: CH, competitor: "fixture-b", transcripts: TRANSCRIPTS, log: (m) => logs.push(m) });
    S.saveLlmSettings({ primary: "off" });
    J.setJsonAsk(null);
    assert.ok(sizes.every((x) => x <= 0), `a prompt was over the budget by ${Math.max(...sizes)} tokens`);
    assert.ok(mapCalls > TRANSCRIPTS.length, `the long transcript must be split (${mapCalls} map calls)`);
    assert.ok(reduceCalls >= 2, "5 analyses in a small context are reduced in groups");
    assert.ok(logs.some((l) => /copies the transcript/.test(l)), "the quoted answer was refused");
    assert.ok(logs.some((l) => /not in lines/.test(l)), "the out-of-range answer was refused");
    assert.equal(sop.meta.reduce, "model");
    assert.ok(sop.meta.leaksRemoved >= 5);
    const corpus = T.corpusOf(TRANSCRIPTS.map((t) => t.text));
    for (const s of allStrings(sop as unknown as Record<string, unknown>)) assert.ok(!T.quotes(s, corpus), s);
    assert.ok(sop.rules.includes("follow praise with one flaw"));
    assert.ok(!sop.rules.some((r) => /the latch wears out faster/.test(r)));
    assert.ok(sop.rules.some((r) => /on cheap models/.test(r)), "the rest of the rule is kept");
  });

  test("askJson: 2 retries then the deterministic fallback; a prompt over the context is never sent", async () => {
    const { z } = await import("zod");
    S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local" }, stages: { script: { numCtx: 8192 } } });
    let calls = 0;
    J.setJsonAsk(async () => (calls++, { n: "not a number" }));
    const r = await J.askJson({ stage: "script", schema: z.object({ n: z.number() }), system: "s", user: "u", label: "t", fallback: () => ({ n: 7 }) });
    assert.deepEqual([r.value.n, r.source, calls, r.problems.length], [7, "fallback", 3, 3]);
    calls = 0;
    const big = await J.askJson({ stage: "script", schema: z.object({ n: z.number() }), system: "s", user: "x".repeat(40000), label: "t", fallback: () => ({ n: 1 }) });
    assert.deepEqual([big.source, calls], ["fallback", 0]);
    assert.match(big.problems[0], /too big/);
    J.setJsonAsk(null);
    S.saveLlmSettings({ primary: "off" });
  });
});

describe("CLI", () => {
  test("sop build from a folder (no model) and sop show", () => {
    const dir = path.join(tmp, "fixture-c");
    fs.mkdirSync(dir, { recursive: true });
    TRANSCRIPTS.forEach((t) => fs.writeFileSync(path.join(dir, `${t.id}.txt`), t.text));
    fs.writeFileSync(path.join(dir, "v1.json"), JSON.stringify({ durationSec: 300 }));
    const cli = (args: string[]) => spawnSync(process.execPath, [path.join(paths.root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(paths.root, "src", "cli.ts"), ...args], { encoding: "utf8", cwd: paths.root, env: process.env });
    const b = cli(["sop", "build", "--channel", CH, "--competitor", dir, "--videos", "5"]);
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /Hook \(/);
    const s = cli(["sop", "show", "--channel", CH, "--competitor", "fixture-c"]);
    assert.equal(s.status, 0, s.stderr);
    assert.match(s.stdout, /SOP: zz-sop-test <- fixture-c \(5 videos/);
    assert.equal(cli(["sop", "build", "--channel", CH, "--competitor", "not-a-thing-zz"]).status, 1);
  });
});
