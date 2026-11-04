import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-titles-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const S = await import("../src/lib/agents/llm/settings.js");
const { setQwenFetch, stripThink } = await import("../src/lib/agents/llm/llm.js");
const { setEmbedFetch } = await import("../src/lib/models/embed.js");
const { closest, containment, ngramJaccard, tokenCosine, cosine } = await import("../src/lib/originality/similarity.js");
const { analyzeTitles, templatesFor } = await import("../src/lib/research/title-patterns.js");
const { parseRss, newsHooks } = await import("../src/lib/research/news.js");
const { generateTitles, templateTitles } = await import("../src/lib/agents/titles.js");
const { ResearchDb } = await import("../src/lib/research/db.js");

const COMP = [
  { title: "Top 10 Best Budget 9mm Pistols for 2026", views: 900_000 },
  { title: "Don't Buy a Carry Gun Until You Watch This", views: 1_200_000 },
  { title: "Glock 19 vs Sig P365: Which Is Better?", views: 400_000 },
  { title: "Best Survival Knife in 2026", views: 300_000 },
];

/** Fake local model: answers the title schema with `titles` (first call) / `rewrites` (later calls). */
function fakeModel(first: string[], rewrites: string[]) {
  let n = 0;
  const prompts: string[] = [];
  setQwenFetch((async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    prompts.push(body.messages.at(-1).content);
    const list = n++ === 0 ? first : rewrites;
    const content = JSON.stringify({ titles: list.map((title) => ({ title, pattern: "Top {N} {X} ({YEAR})" })) });
    return new Response(JSON.stringify({ message: { content }, done: true, done_reason: "stop" }), { status: 200 });
  }) as unknown as typeof fetch);
  return prompts;
}

beforeEach(() => {
  fs.rmSync(process.env.LLM_SETTINGS_FILE!, { force: true });
  S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local" } });
  // No embedding model in tests: lexical scores only.
  setEmbedFetch((async () => new Response("no", { status: 404 })) as unknown as typeof fetch);
});

describe("similarity (originality guard)", () => {
  test("n-gram Jaccard, word cosine, containment, embedding cosine", () => {
    assert.equal(ngramJaccard("best budget pistols", "best budget pistols"), 1);
    assert.ok(ngramJaccard("best budget pistols 2026", "cheap rifles for hunting") === 0);
    assert.ok(tokenCosine("Glock 19 vs Sig P365", "Sig P365 vs Glock 19") > 0.99, "same words, other order");
    assert.equal(containment("one two three four five", "zero one two three four five six", 5), 1);
    assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-9);
    const hit = closest("Top 10 Best Budget 9mm Pistols for 2026!", COMP.map((c) => c.title));
    assert.ok(hit.score > 0.8);
    assert.equal(hit.against, COMP[0].title);
  });

  test("embedding cosine is rescaled: unrelated (~0.5) counts as 0", () => {
    const h = closest("a", ["b"], { vec: [1, 0], vecs: [[0.5, Math.sqrt(0.75)]] });
    assert.equal(h.embedding, 0);
  });
});

describe("title patterns + news hooks", () => {
  test("patterns are found and ranked by views x count; templates never contain competitor wording", () => {
    const s = analyzeTitles(COMP);
    const ids = s.patterns.map((p) => p.pattern.id);
    for (const id of ["countdown", "warning", "versus", "best_year"]) assert.ok(ids.includes(id), id);
    assert.ok(s.yearShare >= 0.5);
    const t = templatesFor(s, 6);
    assert.equal(t.length, 6);
    assert.ok(t.every((x) => !/glock|sig|carry gun/i.test(x)));
  });

  test("Google News RSS is parsed (source suffix removed) and cached", async () => {
    const xml = `<rss><channel><item><title>New ATF rule hits pistol braces - Reuters</title><link>https://x</link><pubDate>Mon, 02 Nov 2026</pubDate><source url="https://reuters.com">Reuters</source></item></channel></rss>`;
    assert.deepEqual(parseRss(xml)[0], { title: "New ATF rule hits pistol braces", source: "Reuters", link: "https://x", published: "Mon, 02 Nov 2026" });
    const db = new ResearchDb(":memory:");
    let calls = 0;
    const f = (async () => (calls++, new Response(xml))) as unknown as typeof fetch;
    assert.equal((await newsHooks("pistol", { db, fetch: f })).length, 1);
    await newsHooks("pistol", { db, fetch: f });
    assert.equal(calls, 1);
  });
});

describe("title agent", () => {
  test("10 titles, none more than 80% similar to a competitor; copies are rewritten", async () => {
    const own = ["9 Pistols Under $500 That Shoot Like $1,000 Guns", "The Only Pocket 9mm You'll Ever Need", "I Ranked Every Compact 9mm From Worst to Best", "Why Nobody Talks About This $300 Pistol", "Is the Budget 9mm Still Worth It This Year?", "7 Carry Pistols Gun Shops Won't Recommend", "The Cheapest 9mm I'd Trust My Life With", "5 Mistakes New Pistol Owners Make at the Counter"];
    const copies = ["Top 10 Best Budget 9mm Pistols for 2026", "Don't Buy a Carry Gun Until You Watch This"];
    const prompts = fakeModel([...copies, ...own], ["Ten Wallet-Friendly 9mm Handguns Ranked by Reliability", "Watch This Before Your First Concealed Carry Purchase"]);
    const r = await generateTitles("budget 9mm pistols", COMP, { count: 10 });
    assert.equal(r.titles.length, 10);
    assert.ok(r.titles.every((t) => t.similarity.score <= 0.8), JSON.stringify(r.titles.map((t) => [t.title, t.similarity.score])));
    assert.ok(r.rejected.some((x) => x.title === copies[0]));
    assert.ok(r.titles.some((t) => t.source === "rewrite"));
    assert.ok(!r.titles.some((t) => copies.includes(t.title)));
    assert.match(prompts[0], /do NOT reuse their wording/);
  });

  test("no model available: template titles still give 10 options", async () => {
    S.saveLlmSettings({ primary: "off" });
    const r = await generateTitles("survival knives", COMP, { count: 10 });
    assert.equal(r.titles.length, 10);
    assert.ok(r.titles.every((t) => t.source === "template" && t.similarity.score <= 0.8));
    assert.equal(new Set(r.titles.map((t) => t.title)).size, 10);
  });

  test("template fill and think-block stripping", () => {
    assert.equal(templateTitles("survival knives", ["Best {X} in {YEAR}"], 1, 2027)[0].title, "Best Survival Knives in 2027");
    assert.equal(templateTitles("best budget 9mm pistols", ["Best {X} in {YEAR}"], 1, 2027)[0].title, "Best Budget 9mm Pistols in 2027");
    assert.equal(stripThink("<think>hmm</think>\n{\"a\":1}"), '{"a":1}');
  });
});
