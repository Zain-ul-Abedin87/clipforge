import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-script-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.EMBEDDINGS = "off";
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const S = await import("../src/lib/agents/llm/settings.js");
const { setQwenFetch } = await import("../src/lib/agents/llm/llm.js");
const { splitBudget } = await import("../src/lib/agents/script/outline.js");
const { factsFromUrls, htmlToText, numbersIn, pageHas, resetFactIds, unsourcedClaims } = await import("../src/lib/agents/script/facts.js");
const { originalityReport } = await import("../src/lib/agents/script/originality.js");
const { countWords, fitWords } = await import("../src/lib/agents/script/sections.js");
const { writeScript } = await import("../src/lib/agents/script/index.js");

const PRODUCTS = ["Taurus G3C", "Ruger Max-9", "Glock 43X", "Sig P365", "S&W Shield Plus", "Springfield Hellcat", "Kimber R7 Mako", "CZ P-10 S", "Walther PDP F", "Canik Mete MC9"];
const COMPETITOR = "number one on our list is the sig pistol because it carries ten rounds in a tiny frame and it simply disappears on your belt all day long without any printing at all which is why so many people carry it every single day of the week";

/**
 * Fake writer: follows "Target: N words", only uses the listed facts, and for one product first
 * copies a competitor transcript (the originality check must catch and rewrite it).
 */
function fakeWriter() {
  const calls: string[] = [];
  let copied = false;
  const ask = async (_system: string, user: string) => {
    calls.push(user);
    const target = Number(/Target: (\d+) words/.exec(user)![1]);
    const facts = [...user.matchAll(/^- (.+?): (.+)$/gm)].map((m) => `Its ${m[1].toLowerCase()} is ${m[2]}.`);
    if (/#1: Canik/.test(user) && !copied) {
      copied = true;
      return (COMPETITOR + " ").repeat(4).split(" ").slice(0, target).join(" ");
    }
    const filler = "This pick balances size and control in a way that suits daily carry for most people who want something simple".split(" ");
    const out = [...facts.join(" ").split(" ").filter(Boolean)];
    for (let k = 0; out.length < target; k++) out.push(filler[k % filler.length] + ((k + 1) % 9 === 0 ? "." : ""));
    return out.slice(0, target).join(" ") + ".";
  };
  return { ask, calls };
}

beforeEach(() => {
  resetFactIds();
  S.saveLlmSettings({ primary: "off" });
});

describe("script writer pieces", () => {
  test("budgets add up exactly; #1 gets a little more", () => {
    const b = splitBudget(1500, [0.08, 1, 1, 1.2, 0.05]);
    assert.equal(b.reduce((a, x) => a + x, 0), 1500);
    assert.ok(b[3] > b[2]);
  });

  test("facts from a page: only values whose numbers are in the page text; source URL kept", async () => {
    const html = "<html><title>Sig P365 specs</title><body><li>Capacity: 10+1 rounds</li><li>Weight 17.8 oz</li><script>x=1</script></body></html>";
    assert.match(htmlToText(html).text, /Capacity: 10\+1 rounds/);
    assert.ok(pageHas("Weight 17.8 oz", "17.8 oz"));
    assert.ok(!pageHas("Weight 17.8 oz", "21 oz"));
    S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local" } });
    setQwenFetch((async () => new Response(JSON.stringify({ message: { content: JSON.stringify({ facts: [{ label: "Capacity", value: "10+1 rounds" }, { label: "Weight", value: "17.8 oz" }, { label: "Barrel", value: "3.1 in" }] }) }, done: true, done_reason: "stop" }))) as unknown as typeof fetch);
    const f = await factsFromUrls("Sig P365", ["https://sig.example/p365"], () => {}, (async () => new Response(html)) as unknown as typeof fetch);
    assert.deepEqual(f.map((x) => x.label), ["Capacity", "Weight"], "the invented barrel length is dropped");
    assert.equal(f[0].source.url, "https://sig.example/p365");
    assert.equal(f[0].source.title, "Sig P365 specs");
  });

  test("claim checker: numbers must be sourced; small counting numbers are fine", () => {
    const facts = [{ id: "F1", product: "X", label: "Weight", value: "17.8 oz", source: { url: "u", title: "t" } }];
    assert.deepEqual(numbersIn("1,200 rounds and 17.80 oz"), ["1200", "17.8"]);
    assert.equal(unsourcedClaims("It weighs 17.8 oz. It has 2 safeties.", facts).length, 0);
    assert.deepEqual(unsourcedClaims("It costs $499 today.", facts)[0].numbers, ["499"]);
  });

  test("fitWords lands within +-3 words and keeps the first sentence", () => {
    const t = "First line stays. " + "Another plain sentence here. ".repeat(30);
    const f = fitWords(t, 40);
    assert.ok(Math.abs(countWords(f) - 40) <= 3, String(countWords(f)));
    assert.ok(f.startsWith("First line stays."));
  });

  test("originality: copied phrasing is flagged by 5-gram overlap", async () => {
    const r = await originalityReport([COMPETITOR, "A completely different paragraph about holsters and range bags for new owners."], [COMPETITOR], { useEmbeddings: false });
    assert.equal(r.paragraphs[0].flagged, true);
    assert.equal(r.paragraphs[1].flagged, false);
    assert.equal(r.flagged, 1);
  });
});

describe("writeScript: 10 products", () => {
  test("target length +-3%, clean originality after a rewrite, every number sourced", async () => {
    const dir = path.join(tmp, "proj");
    const factsFile = path.join(tmp, "facts_sources.json");
    fs.writeFileSync(factsFile, JSON.stringify(PRODUCTS.map((p, i) => ({ product: p, label: "Capacity", value: `${11 + i}+1 rounds`, url: `https://maker.example/${i}`, title: p }))));
    const w = fakeWriter();
    const logs: string[] = [];
    const { text, report } = await writeScript(dir, { topic: "best concealed carry pistols", products: PRODUCTS, targetWords: 1500, factsFile, competitors: [COMPETITOR], ask: w.ask, useEmbeddings: false, log: (m) => logs.push(m) });
    assert.equal(report.sections.filter((s) => s.kind === "product").length, 10);
    assert.ok(report.withinTolerance, `${report.totalWords} words`);
    assert.ok(Math.abs(countWords(text) - 1500) <= 45);
    assert.ok(report.originality?.clean, JSON.stringify(report.originality?.paragraphs.filter((p) => p.flagged)));
    assert.ok(logs.some((l) => /too close to a competitor/.test(l)), "the copied section was rewritten");
    assert.deepEqual(report.claims.unsourced, []);
    assert.equal(report.claims.factsUsed.length, 10);
    assert.ok(report.claims.factsUsed.every((f) => f.source.url.startsWith("https://")));
    assert.ok(fs.existsSync(path.join(dir, "script.txt")) && fs.existsSync(path.join(dir, "script_report.json")));
    // One call per section (12) + one rewrite; every request is small (one product's facts).
    assert.ok(w.calls.length >= 13 && w.calls.every((c) => c.length < 2000));
  });

  test("no model: a short skeleton marked 'rules', no filler sentences, only sourced facts", async () => {
    const dir = path.join(tmp, "proj2");
    const { text, report } = await writeScript(dir, { topic: "budget pistols", products: PRODUCTS.slice(0, 3), targetWords: 400, ask: null, log: () => {} });
    assert.equal(report.writer, "rules");
    assert.ok(report.totalWords < 400, "it does not pretend to be a full script");
    assert.ok(!/Keep that in mind|fair trade for most buyers/.test(text), "no filler sentences");
    for (const p of PRODUCTS.slice(0, 3)) assert.ok(text.includes(p), p);
    assert.deepEqual(report.claims.unsourced, []);
  });
});
