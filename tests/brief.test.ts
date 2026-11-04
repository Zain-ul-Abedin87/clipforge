import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-brief-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.EMBEDDINGS = "off";

const B = await import("../src/lib/channelBrief.js");
const { writeScript } = await import("../src/lib/agents/script/index.js");
const { dropBanned, systemFor } = await import("../src/lib/agents/script/sections.js");
const { stageSteps } = await import("../src/lib/orchestrator/pipeline.js");
const { paths } = await import("../src/lib/paths.js");

const ID = "zz-brief-test";
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(paths.channels, ID), { recursive: true, force: true });
  fs.rmSync(path.join(paths.channels, `${ID}-cli`), { recursive: true, force: true });
});

describe("channel brief", () => {
  test("cleaning: limits, lists from text, bad language kept from the base", () => {
    const b = B.cleanBrief(ID, { name: "  My  Channel ", pillars: "a; b\n- c", wpm: 999, targetMinutes: 0, language: "english" });
    assert.equal(b.name, "My Channel");
    assert.deepEqual(b.pillars, ["a", "b", "c"]);
    assert.equal(b.wpm, 260);
    assert.equal(b.targetMinutes, 1);
    assert.equal(b.language, "en");
    assert.equal(B.targetWords({ targetMinutes: 12, wpm: 150 }), 1800);
  });

  test("brief.md round trip; a hand-edited brief.md wins over brief.json", () => {
    const saved = B.saveBrief(ID, { name: "Test Channel", tone: "calm expert, no hype", pillars: ["History", "Specs"], bannedPhrases: ["game-changer"], targetMinutes: 8, wpm: 160 });
    const md = fs.readFileSync(path.join(paths.channels, ID, "brief.md"), "utf8");
    assert.deepEqual(B.mdToBrief(ID, md), saved);
    // Edit the markdown by hand (a newer file).
    const edited = md.replace("calm expert, no hype", "dry and precise").replace("- Specs", "- Specs\n- Myths");
    const f = path.join(paths.channels, ID, "brief.md");
    fs.writeFileSync(f, edited);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(f, later, later);
    const b = B.loadBrief(ID)!;
    assert.equal(b.tone, "dry and precise");
    assert.deepEqual(b.pillars, ["History", "Specs", "Myths"]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(paths.channels, ID, "brief.json"), "utf8")).tone, "dry and precise");
    assert.equal(B.loadBrief("no-such-channel-zz"), null);
    assert.equal(B.loadBrief("../etc"), null);
  });

  test("banned phrases: whole words, any case, straight or curly apostrophe", () => {
    const b = B.cleanBrief(ID, { bannedPhrases: ["you won't believe", "insane"] });
    assert.deepEqual(B.bannedIn("You won’t believe this.", b), ["you won't believe"]);
    assert.deepEqual(B.bannedIn("An INSANE deal.", b), ["insane"]);
    assert.deepEqual(B.bannedIn("Insanely good.", b), []);
  });

  test("the seeded briefs are valid and YouTube-safe", () => {
    for (const id of ["survival-legacy", "survival-pulse"]) {
      const b = B.loadBrief(id)!;
      assert.ok(b, id);
      assert.ok(b.rules.some((r) => /no instructions for modifying/i.test(r)), id);
      assert.ok(b.bannedPhrases.length >= 5);
    }
    assert.equal(B.targetWords(B.loadBrief("survival-legacy")!), 1800);
  });
});

describe("the brief in the script", () => {
  test("voice, audience and banned phrases go into every section prompt; a banned phrase is rewritten; length from the brief", async () => {
    const brief = B.cleanBrief(ID, { name: "Pulse", tone: "fast, direct, no hype", audience: "budget buyers on phones", bannedPhrases: ["game-changer"], targetMinutes: 2, wpm: 150 });
    const systems: string[] = [];
    let first = true;
    const ask = async (system: string, user: string) => {
      systems.push(system);
      const target = Number(/Target: (\d+) words/.exec(user)![1]);
      const base = first ? "This light is a game-changer for night walks." : "This light suits night walks and short trips.";
      first = false;
      const filler = "It is simple to carry and easy to use every day".split(" ");
      const words = base.split(" ");
      while (words.length < target) words.push(filler[words.length % filler.length]);
      return words.slice(0, target).join(" ") + ".";
    };
    const dir = path.join(tmp, "p1");
    const logs: string[] = [];
    const { text, report } = await writeScript(dir, { topic: "budget flashlights", products: ["Lamp A", "Lamp B"], ask, brief, log: (m) => logs.push(m) });
    assert.equal(report.targetWords, 300);
    assert.ok(systems.every((s) => /Tone: fast, direct, no hype/.test(s) && /budget buyers on phones/.test(s) && /"game-changer"/.test(s)));
    assert.ok(!/game-changer/i.test(text));
    assert.deepEqual(report.channel, { id: ID, name: "Pulse", bannedFound: [] });
  });

  test("a non-English brief switches the writing language", () => {
    assert.match(systemFor(B.cleanBrief(ID, { language: "de" })), /Plain spoken German/);
    assert.doesNotMatch(systemFor(null), /Write in this channel's voice/);
    const b = B.cleanBrief(ID, { bannedPhrases: ["insane"] });
    assert.equal(dropBanned("An insane light. It is small.", b), "It is small.");
    assert.equal(dropBanned("An insane light", b), "An light");
  });

  test("the pipeline passes the channel to titles and the script", () => {
    const dir = path.join(paths.workspace, "zz-brief-pipe");
    fs.mkdirSync(dir, { recursive: true });
    try {
      const cfg = { topic: "budget lights", products: ["A", "B"], channel: "survival-pulse" };
      assert.deepEqual(stageSteps("writing", "zz-brief-pipe", cfg)[0].slice(-2), ["--channel", "survival-pulse"]);
      assert.ok(stageSteps("research", "zz-brief-pipe", cfg).some((s) => s[0] === "titles" && s.includes("survival-pulse")));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("CLI: channel init with flags (no questions) and channel show", () => {
    const cli = (args: string[]) => spawnSync(process.execPath, [path.join(paths.root, "node_modules", "tsx", "dist", "cli.mjs"), path.join(paths.root, "src", "cli.ts"), ...args], { encoding: "utf8", cwd: paths.root });
    const r = cli(["channel", "init", `${ID}-cli`, "-y", "--name", "CLI Test", "--tone", "calm", "--banned", "insane; crazy", "--minutes", "10", "--wpm", "140"]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /1400 words per video/);
    const s = cli(["channel", "show", `${ID}-cli`]);
    assert.match(s.stdout, /# CLI Test/);
    assert.match(s.stdout, /- crazy/);
    assert.equal(cli(["channel", "show", "zz-none-here"]).status, 1);
  });
});
