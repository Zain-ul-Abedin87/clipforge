import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-thumbs-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.RESEARCH_DB = path.join(tmp, "research.db");
process.env.EMBEDDINGS = "off";

const S = await import("../src/lib/agents/llm/settings.js");
const J = await import("../src/lib/agents/llm/json.js");
const C = await import("../src/lib/research/comments.js");
const { YouTubeApi } = await import("../src/lib/research/youtube-api.js");
const { ResearchDb } = await import("../src/lib/research/db.js");
const T = await import("../src/lib/agents/thumbnails.js");
const { ideaSource } = await import("../src/lib/agents/ideasSource.js");
const { multiplyIdeas } = await import("../src/lib/agents/ideas.js");
const { wizardRoute } = await import("../src/server/routes/wizard.js");
const { paths } = await import("../src/lib/paths.js");

const PROJ = "zz-thumbs-proj";
after(() => {
  J.setJsonAsk(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(paths.workspace, PROJ), { recursive: true, force: true });
  fs.rmSync(path.join(paths.channels, "zz-thumbs-ch"), { recursive: true, force: true });
});
S.saveLlmSettings({ primary: "off" });

const COMMENTS = [
  { text: "First!", likes: 900 },
  { text: "Great video. Why didn't you test the Mora Companion against these?", likes: 500 },
  { text: "Why didn't you test the Mora Companion against these knives?", likes: 40 },
  { text: "The sheath on number 3 broke after two weeks, really disappointed with it.", likes: 300 },
  { text: "Check out my channel for giveaways https://x.example", likes: 800 },
  { text: "Nice editing", likes: 200 },
];

describe("comment mining", () => {
  test("questions and complaints, most liked first, near-duplicates merged, spam dropped", () => {
    const a = C.anglesFromComments(COMMENTS);
    assert.deepEqual(a.map((x) => x.kind), ["question", "complaint"]);
    assert.match(a[0].angle, /Mora Companion/);
    assert.match(a[1].angle, /sheath on number 3 broke/);
  });

  test("YouTube API: commentThreads mapped; comments turned off = no comments, no crash", async () => {
    let calls = 0;
    const f = (async (url: string) => {
      calls++;
      if (/videoId=off/.test(url)) return new Response(JSON.stringify({ error: { code: 403, message: "commentsDisabled" } }), { status: 403 });
      assert.match(url, /commentThreads\?/);
      return new Response(JSON.stringify({ items: [{ snippet: { topLevelComment: { snippet: { textOriginal: "Why is the steel so soft?", likeCount: "12" } } } }] }));
    }) as unknown as typeof fetch;
    const api = new YouTubeApi({ key: "k", db: new ResearchDb(":memory:"), fetch: f });
    assert.deepEqual(await api.topComments("abc"), [{ text: "Why is the steel so soft?", likes: 12 }]);
    assert.deepEqual(await api.topComments("off"), []);
    assert.equal(calls, 2);
  });

  test("no API key: skipped and said so", async () => {
    const logs: string[] = [];
    const api = new YouTubeApi({ key: "", db: new ResearchDb(":memory:") });
    assert.deepEqual(await C.commentAngles(api, ["abc"], (m) => logs.push(m)), []);
    assert.ok(logs.some((l) => /comment mining skipped/.test(l)));
  });

  test("the angles reach the idea multiplier's prompt", async () => {
    const api = { configured: true, canSpend: () => true, topComments: async () => COMMENTS } as never;
    const { source } = await ideaSource("zzVid123456", { title: "Best survival knives", transcript: false, api });
    assert.equal(source.angles?.length, 2);
    S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local" } });
    let prompt = "";
    J.setJsonAsk(async (_s, user) => {
      prompt = user;
      return { why: { triggers: ["ranking"], explanation: "a clear ranking" }, ideas: [] };
    });
    await multiplyIdeas(source, { channel: "zz-thumbs-ch", save: false });
    J.setJsonAsk(null);
    S.saveLlmSettings({ primary: "off" });
    assert.match(prompt, /Viewers' questions and complaints/);
    assert.match(prompt, /question: .*Mora Companion/);
  });
});

describe("thumbnail concepts", () => {
  const JPG = Buffer.alloc(2000, 7);
  const fetchJpg = (async () => new Response(JPG)) as unknown as typeof fetch;
  const REFS = [{ videoId: "aaaaaaaaaaa", title: "5 knives that never fail" }, { videoId: "bbbbbbbbbbb", title: "Knife steel tier list" }];

  test("rule concepts: 3, different, at most 4 words; versus gets a versus layout", () => {
    for (const [t, f] of [["Best Budget Knives 2026", undefined], ["Mora vs Buck: which one?", "versus"]] as const) {
      const c = T.ruleConcepts(t, f);
      assert.equal(c.length, 3);
      assert.equal(new Set(c.map((x) => x.text)).size, 3);
      assert.ok(c.every((x) => x.text.split(/\s+/).length <= 4));
    }
    assert.match(T.ruleConcepts("Mora vs Buck: which knife?", "versus")[0].mainSubject, /^Mora and Buck side by side/);
  });

  test("model: one picture per vision call; copied competitor text and long text are refused; saved", async () => {
    S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local" } });
    const calls: { stage: string; images: number; over: number }[] = [];
    let conceptCalls = 0;
    J.setJsonAsk(async (system, user, stage, max, images) => {
      calls.push({ stage, images: images ?? 0, over: J.approxTokens(system) + J.approxTokens(user) + (images ?? 0) * J.IMAGE_TOKENS - J.promptBudget(stage, max, (images ?? 0) > 0) });
      if (stage === "vision") return { subject: "a knife on a log", text: "NEVER FAILS", emotion: "confident", colors: ["orange", "black"], composition: "knife diagonal, text top left" };
      conceptCalls++;
      const first = conceptCalls === 1 ? "NEVER FAILS" : conceptCalls === 2 ? "THE ONE KNIFE YOU NEED NOW" : "WORTH IT?";
      return { concepts: [
        { mainSubject: "one knife, large", text: first, emotion: "curious", contrast: "orange on dark blue", why: "one subject and a question" },
        { mainSubject: "blade edge close-up", text: "SHARPEST?", emotion: "intrigued", contrast: "white on black", why: "a detail invites a look" },
        { mainSubject: "two knives crossed", text: "SKIP THIS", emotion: "concerned", contrast: "red accent", why: "a warning sets stakes" },
      ] };
    });
    const dir = path.join(tmp, "p");
    fs.mkdirSync(dir, { recursive: true });
    const logs: string[] = [];
    const r = await T.thumbnailConcepts({ dir, title: "Best budget survival knives", refs: REFS, fetchImpl: fetchJpg, log: (m) => logs.push(m) });
    J.setJsonAsk(null);
    S.saveLlmSettings({ primary: "off" });
    assert.deepEqual(calls.filter((c) => c.stage === "vision").map((c) => c.images), [1, 1]);
    assert.ok(calls.every((c) => c.over <= 0), JSON.stringify(calls));
    assert.equal(conceptCalls, 3);
    assert.ok(logs.some((l) => /repeats a competitor's on-image text/.test(l)));
    assert.ok(logs.some((l) => /4 words or fewer/.test(l)));
    assert.equal(r.writer, "model");
    assert.equal(r.references.length, 2);
    assert.deepEqual(r.concepts.map((c) => c.text), ["WORTH IT?", "SHARPEST?", "SKIP THIS"]);
    assert.ok(fs.existsSync(path.join(dir, "thumbnail_concepts.json")));
    assert.ok(fs.existsSync(path.join(dir, "thumbs", "ref_aaaaaaaaaaa.jpg")));
  });

  test("no model: thumbnails not described (said so), rule concepts", async () => {
    const dir = path.join(tmp, "q");
    fs.mkdirSync(dir, { recursive: true });
    const r = await T.thumbnailConcepts({ dir, title: "Best budget survival knives", refs: REFS, fetchImpl: fetchJpg });
    assert.equal(r.writer, "rules");
    assert.equal(r.references.length, 0);
    assert.ok(r.notes.some((n) => /not described/.test(n)));
  });

  test("references: the outliers closest to our title first", () => {
    const refs = T.pickRefs("best budget survival knives", [
      { video: { id: "x1", title: "Cooking with cast iron" }, score: 9 },
      { video: { id: "x2", title: "Best budget survival knives ranked" }, score: 2 },
    ], 1);
    assert.equal(refs[0].videoId, "x2");
  });

  test("wizard API and CLI on a project (no scan, no model: rule concepts)", async () => {
    fs.mkdirSync(path.join(paths.workspace, PROJ), { recursive: true });
    fs.writeFileSync(path.join(paths.workspace, PROJ, "project.json"), JSON.stringify({ title: "Mora vs Buck: which knife?" }));
    fs.writeFileSync(path.join(paths.workspace, PROJ, "pipeline.json"), JSON.stringify({ topic: "knives", products: ["Mora", "Buck"], channel: "default", format: "versus" }));
    assert.equal((await wizardRoute(["api", "wizard", PROJ, "thumbnails"], "GET", async () => ""))?.body, null);
    const r = spawnSync(process.execPath, [path.join(paths.root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(paths.root, "src", "cli.ts"), "thumbnails", "-p", PROJ], { encoding: "utf8", cwd: paths.root, env: process.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1\. "WHICH ONE\?"/);
    const saved = (await wizardRoute(["api", "wizard", PROJ, "thumbnails"], "GET", async () => ""))?.body as { concepts: unknown[] };
    assert.equal(saved.concepts.length, 3);
  });
});
