import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-ideas-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.EMBEDDINGS = "off";

const S = await import("../src/lib/agents/llm/settings.js");
const J = await import("../src/lib/agents/llm/json.js");
const I = await import("../src/lib/agents/ideas.js");
const H = await import("../src/lib/channelHistory.js");
const { cleanBrief } = await import("../src/lib/channelBrief.js");
const { researchRoute } = await import("../src/server/routes/research.js");
const { paths } = await import("../src/lib/paths.js");

const CH = "zz-ideas-test";
const PROJ = "zz-ideas-proj";
after(() => {
  J.setJsonAsk(null);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(paths.channels, CH), { recursive: true, force: true });
  fs.rmSync(path.join(paths.workspace, PROJ), { recursive: true, force: true });
});
S.saveLlmSettings({ primary: "off" });

const SRC = { videoId: "abcDEF12345", title: "5 Survival Knives That Outlast Everything Else", views: 900000, multiple: 6.2, channelTitle: "Some Channel", transcript: Array.from({ length: 3000 }, (_, i) => `w${i}`).join(" ") };
const brief = cleanBrief(CH, { name: "Pulse", tone: "fast and direct", pillars: ["Budget survival knives", "Fire starting gear", "Water filters"], bannedPhrases: ["insane"] });

describe("idea multiplier", () => {
  test("triggers from a title", () => {
    assert.deepEqual(I.titleTriggers("Glock vs Sig: which is better?"), ["versus", "curiosity"]);
    assert.ok(I.titleTriggers("Top 10 cheapest knives").includes("ranking"));
    assert.ok(I.titleTriggers("Top 10 cheapest knives").includes("money"));
    assert.ok(I.titleTriggers("The history of the M1911").includes("nostalgia"));
  });

  test("transcript excerpt: the opening first, bounded size", () => {
    const e = I.transcriptExcerpt(SRC.transcript, 800);
    assert.ok(e.startsWith("w0 w1"));
    assert.ok(e.split(/\s+/).filter((x) => /^w\d+$/.test(x)).length <= 802);
    assert.equal(I.transcriptExcerpt(undefined), "");
  });

  test("rules (no model): ideas from the brief's pillars x formats, valid, no padding", async () => {
    const r = await I.multiplyIdeas(SRC, { channel: CH, brief, save: false });
    assert.equal(r.writer, "rules");
    assert.ok(r.ideas.length >= 10 && r.ideas.length <= 15);
    assert.equal(new Set(r.ideas.map((i) => i.workingTitle)).size, r.ideas.length);
    assert.ok(r.ideas.every((i) => I.IDEA_FORMATS.includes(i.format)));
    assert.ok(r.why.triggers.includes("ranking"));
  });

  test("model: banned phrase refused and asked again; ideas like our past titles, competitor titles or each other are dropped; saved", async () => {
    // One of our own past videos for this channel.
    fs.mkdirSync(path.join(paths.workspace, PROJ), { recursive: true });
    fs.writeFileSync(path.join(paths.workspace, PROJ, "project.json"), JSON.stringify({ channel: CH, title: "Best Fire Starters for Wet Weather" }));
    H.recordHistory(CH, { project: "older-one", title: "Water Filters That Actually Work", topic: "filters", text: "x" });
    S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local" } });
    let calls = 0;
    const sizes: number[] = [];
    J.setJsonAsk(async (system, user, stage, max) => {
      calls++;
      sizes.push(J.approxTokens(system) + J.approxTokens(user) - J.promptBudget(stage, max));
      assert.match(system, /Tone: fast and direct/);
      const base = Array.from({ length: 12 }, (_, k) => ({ idea: `Idea number ${k} about a different survival subject`, trigger: "ranking", format: "countdown", workingTitle: `Survival topic ${["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"][k]} tested on a budget`, whyFits: "fits the budget pillar", copyRisk: "low" }));
      return {
        why: { triggers: ["ranking", "stakes"], explanation: "A clear ranking with a promise that the picks last." },
        ideas: [
          ...base,
          { idea: "Our own old video again", trigger: "ranking", format: "countdown", workingTitle: "Best Fire Starters for Wet Weather", whyFits: "same as before", copyRisk: "high" },
          { idea: "A remake of the outlier", trigger: "ranking", format: "countdown", workingTitle: "5 Survival Knives That Outlast Everything", whyFits: "same as before", copyRisk: "high" },
          { idea: calls === 1 ? "An insane one" : "A twin of the first", trigger: "ranking", format: "countdown", workingTitle: calls === 1 ? "The insane knife test" : "Survival topic alpha tested on a budget!", whyFits: "same as before", copyRisk: "low" },
        ],
      };
    });
    const logs: string[] = [];
    const r = await I.multiplyIdeas(SRC, { channel: CH, brief, competitorTitles: ["Other channel title about axes"], log: (m) => logs.push(m) });
    J.setJsonAsk(null);
    S.saveLlmSettings({ primary: "off" });
    assert.equal(calls, 2, "the banned phrase was refused once");
    assert.ok(sizes.every((x) => x <= 0), "the prompt fits the context");
    assert.equal(r.writer, "model");
    assert.equal(r.ideas.length, 12);
    const reasons = r.dropped.map((d) => d.reason).sort();
    assert.deepEqual(reasons, ["repeats another idea", "too close to a competitor title", "too close to one of our past titles"]);
    assert.ok(fs.existsSync(path.join(paths.channels, CH, "ideas", "abcDEF12345.json")));
    assert.deepEqual(H.pastTitles(CH).sort(), ["Best Fire Starters for Wet Weather", "Water Filters That Actually Work"]);
  });

  test("API: saved run, bad input refused", async () => {
    const saved = await researchRoute(["api", "research", "ideas", CH, "abcDEF12345"], "GET", async () => "");
    assert.equal((saved?.body as { ideas: unknown[] }).ideas.length, 12);
    const bad = await researchRoute(["api", "research", "ideas"], "POST", async () => JSON.stringify({ videoId: "../x", channel: CH }));
    assert.equal(bad?.status, 400);
  });

  test("CLI: ideas with --title and no transcript (no model: rule ideas)", () => {
    const r = spawnSync(process.execPath, [path.join(paths.root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(paths.root, "src", "cli.ts"), "ideas", "--channel", CH, "--from", "zzNoSuchVid1", "--title", "Glock vs Sig: which is better?", "--no-transcript"], { encoding: "utf8", cwd: paths.root, env: { ...process.env, YOUTUBE_API_KEY: "" } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Why it worked \(versus, curiosity\)/);
    assert.match(r.stdout, / 1\. \[countdown/);
  });
});
