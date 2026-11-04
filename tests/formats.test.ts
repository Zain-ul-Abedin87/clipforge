import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-formats-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.GPU_TIME_FILE = path.join(tmp, "gpu_time.json");
const { paths } = await import("../src/lib/paths.js");
const X = await import("../src/lib/formats/explainer.js");
const T = await import("../src/lib/formats/tutorial.js");
const M = await import("../src/server/routes/make.js");
const P = await import("../src/lib/orchestrator/pipeline.js");
const { splitCommand } = await import("../src/lib/formats/tool.js");
const { run } = await import("../src/lib/exec.js");
const { ffmpegPath } = await import("../src/lib/tools.js");
const made: string[] = [];
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const p of made) {
    fs.rmSync(path.join(paths.workspace, p), { recursive: true, force: true });
    for (const ext of [".mp4", ".srt", ".vtt"]) fs.rmSync(path.join(paths.output, p + ext), { force: true });
  }
});
type Call = { cmd: string; args: string[]; cwd?: string };

describe("explainer (explainroo)", () => {
  test("script.md is written by code and read back; ids are valid method names", () => {
    const md = X.scriptMd("How DNS works", [{ id: "hook", text: "You type a name [#type] and a page appears." }, { id: "steps", chapter: 'Three "steps"', text: "First [#one] the resolver asks." }]);
    assert.match(md, /^# How DNS works\n\n## hook\nYou type a name \[#type\] and a page appears\.\n\n## steps \{chapter="Three 'steps'"\}/);
    const back = X.parseScriptMd(md + "> a note, not spoken\n");
    assert.deepEqual(back.scenes.map((s) => [s.id, s.chapter ?? null]), [["hook", null], ["steps", "Three 'steps'"]]);
    assert.equal(back.title, "How DNS works");
    assert.equal(X.sceneId("Why it matters!", 0), "why_it_matters");
    assert.equal(X.sceneId("3 steps", 2), "scene_3_3_steps");
  });

  test("scene code: on-screen words are fine, browser / network / endless loops are refused, must compile", () => {
    assert.equal(X.checkSceneCode("s.text('Your location and window size', { at: 0 });"), null);
    assert.match(X.checkSceneCode("fetch('http://x');")!, /fetch/);
    assert.match(X.checkSceneCode("s.text(`${window.name}`, {at:0});")!, /window/);
    assert.match(X.checkSceneCode("while (true) {}")!, /while/);
    assert.match(X.checkSceneCode("s.text('a', {at: 0}")!, /does not compile/);
    assert.equal(X.checkSceneCode(X.fallbackScene({ id: "a", text: "One thing. Two things [#two]. {API|A P I} three." }, 1)), null);
  });

  test("write: init once, AI script + code, explainroo check errors go back to the AI, refused code falls back", async () => {
    const project = "zz-formats-explainer";
    made.push(project);
    X.saveExplainerInput(project, { topic: "how DNS works", points: ["a resolver finds the address", "the answer is cached"], seconds: 60 });
    const calls: Call[] = [];
    let checks = 0;
    const exec = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      if (args.includes("init")) {
        const dir = args[args.indexOf("init") + 1];
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "video.json"), "{}");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (args.includes("check")) {
        checks++;
        const issues = checks === 1 ? [{ level: "error", scene: "answer", t: 2, message: 'cue "cache" is not spoken in this scene' }, { level: "warning", scene: "hook", message: "text close to the edge" }] : [{ level: "warning", scene: "hook", message: "text close to the edge" }];
        return { code: checks === 1 ? 1 : 0, stdout: JSON.stringify({ issues, scenes: 3, duration: 40 }), stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const asked: string[] = [];
    const ask = async (_sys: string, user: string, schema: "script" | "code") => {
      asked.push(schema);
      if (schema === "script") return { title: "How DNS finds a site", scenes: [{ id: "hook", text: "You type a name [#type]." }, { id: "Answer", text: "The answer is kept [#keep]." }, { id: "net", text: "It never calls home [#home]." }] };
      const fix = user.includes("found these errors");
      return { scenes: [
        { id: "hook", body: "s.title('How DNS works', { at: 0 });" },
        { id: "answer", body: fix ? "s.text('kept', { at: '#keep' });" : "s.text('cached', { at: 'cache' });" },
        { id: "net", body: "fetch('https://evil.example');" },
      ].filter((x) => !fix || x.id === "answer") };
    };
    const r = await X.writeExplainer(project, { ask, exec, log: () => {} });
    const dir = X.explainerDir(project);
    assert.equal(calls.filter((c) => c.args.includes("init")).length, 1);
    assert.deepEqual(asked, ["script", "code", "code"]);
    assert.equal(r.rounds, 1);
    assert.deepEqual(r.fallbacks, ["net"]);
    assert.equal(r.open.length, 1);
    const js = fs.readFileSync(path.join(dir, "scenes.js"), "utf8");
    assert.match(js, /answer\(s\) \{\n    s\.text\('kept'/);
    assert.doesNotMatch(js, /fetch/);
    assert.match(fs.readFileSync(path.join(dir, "script.md"), "utf8"), /^# How DNS finds a site/);
    // The creator's edited script is kept on the next write (only the pictures are redone).
    fs.writeFileSync(path.join(dir, "script.md"), "# Mine\n\n## only\nMy own words [#mine].\n");
    fs.writeFileSync(path.join(dir, ".script-edited"), "x");
    asked.length = 0;
    await X.writeExplainer(project, { ask, exec, log: () => {} });
    assert.deepEqual(asked, ["code"]);
    assert.match(fs.readFileSync(path.join(dir, "script.md"), "utf8"), /My own words/);
    assert.equal(calls.filter((c) => c.args.includes("init")).length, 1, "init only once");
  });

  test("render: voice, render to output/<project>.mp4, verify", async () => {
    const project = "zz-formats-explainer";
    const calls: string[] = [];
    const exec = async (_c: string, args: string[]) => {
      calls.push(args[0]);
      if (args[0] === "render") fs.writeFileSync(args[args.indexOf("--out") + 1], "mp4");
      return { code: 0, stdout: args[0] === "verify" ? "loudness -14 LUFS" : "", stderr: "" };
    };
    const r = await X.renderExplainer(project, { exec, log: () => {} });
    assert.deepEqual(calls, ["voice", "render", "verify"]);
    assert.equal(r.file, path.join(paths.output, `${project}.mp4`));
    await assert.rejects(X.renderExplainer(project, { exec: async () => ({ code: 1, stdout: "", stderr: "Chrome not found" }), log: () => {} }), /voice failed: Chrome not found/);
  });

  test("a .js path runs with this Node; npx on Windows is npx.cmd", () => {
    assert.deepEqual(splitCommand("C:\\tools\\explainroo\\bin\\explainroo.js"), { cmd: process.execPath, pre: ["C:\\tools\\explainroo\\bin\\explainroo.js"] });
    assert.deepEqual(splitCommand("explainroo"), { cmd: "explainroo", pre: [] });
    assert.equal(splitCommand("npx argo").pre[0], "argo");
  });
});

describe("tutorial (argo import route)", () => {
  test("scenes from picture changes: one at 0, at least minSec long, strongest changes first", () => {
    const s = T.scenesFromChanges([{ t: 1, score: 0.9 }, { t: 6, score: 0.5 }, { t: 7, score: 0.8 }, { t: 15, score: 0.4 }, { t: 18.5, score: 0.9 }], 20, 4);
    assert.deepEqual(s.map((x) => [x.start, x.end]), [[0, 7], [7, 15], [15, 20]]);
    assert.deepEqual(T.scenesFromChanges([], 12, 4), [{ start: 0, end: 12 }]);
  });

  test("a scene's voice keeps whole sentences under its word limit", () => {
    assert.deepEqual(T.fitWords("Open the menu. Then click Settings and wait.", 4), { text: "Open the menu.", cut: true });
    assert.deepEqual(T.fitWords("Short one.", 10), { text: "Short one.", cut: false });
    assert.equal(T.fitWords("A very long single sentence without an end", 3).text, "A very long.");
  });

  test("write + render: AI voice-over per scene, then argo import / tts / export into output/", async () => {
    const project = "zz-formats-tutorial";
    made.push(project);
    M.createMade({ type: "tutorial", topic: "schedule a post", notes: "Open the dashboard, click create post, paste the text and pick a time.", project: undefined });
    const p = fs.readdirSync(paths.workspace).find((n) => n.startsWith("schedule-a-post"))!;
    made.push(p);
    fs.writeFileSync(path.join(T.tutorialDir(p), "recording.mp4"), "x");
    T.setRecording(p, "recording.mp4");
    const scenes = await T.writeTutorial(p, {
      log: () => {},
      changes: { changes: [{ t: 5, score: 0.6 }], duration: 9 },
      ask: async (_s, user) => (assert.match(user, /s1: 0\.0-5\.0 s, at most 12 words/), { scenes: [{ id: "s1", text: "Open the dashboard and click Create post. This sentence is far too long for the scene." }, { id: "s2", text: "Paste your text." }] }),
    });
    assert.deepEqual(scenes.map((s) => s.text), ["Open the dashboard and click Create post.", "Paste your text."]);
    const calls: Call[] = [];
    const exec = async (cmd: string, args: string[], o?: { cwd?: string }) => {
      calls.push({ cmd, args, cwd: o?.cwd });
      if (args[0] === "export") {
        fs.mkdirSync(path.join(o!.cwd!, "videos"), { recursive: true });
        fs.writeFileSync(path.join(o!.cwd!, "videos", "tutorial.mp4"), "mp4");
        fs.writeFileSync(path.join(o!.cwd!, "videos", "tutorial.srt"), "1");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await T.renderTutorial(p, { exec, log: () => {} });
    assert.deepEqual(calls.map((c) => c.args.join(" ")), ["import recording.mp4 --demo tutorial --force", "tts generate demos/tutorial.scenes.json", "export tutorial"]);
    assert.ok(calls.every((c) => c.cwd === T.tutorialDir(p)));
    const dir = T.tutorialDir(p);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "demos", "tutorial.scenes.json"), "utf8")), [{ scene: "s1", text: "Open the dashboard and click Create post." }, { scene: "s2", text: "Paste your text." }]);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".argo", "tutorial", ".timing.json"), "utf8")), { s1: 0, s2: 5000 });
    assert.equal(r.file, path.join(paths.output, `${p}.mp4`));
    assert.ok(fs.existsSync(path.join(paths.output, `${p}.srt`)));
    // The creator's edits; a text over the limit is flagged.
    const edited = T.saveTutorialScenes(p, { s2: "Paste your text, pick the account, choose the day, set the hour and press schedule now please." });
    assert.equal(T.tooLong(edited[1]), true);
  });

  test("picture changes found in a real recording (FFmpeg)", { skip: !ffmpegPath() }, async () => {
    const f = path.join(tmp, "rec.mp4");
    const r = await run(ffmpegPath()!, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=white:s=320x180:d=3", "-f", "lavfi", "-i", "testsrc2=s=320x180:d=3", "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", "-r", "30", "-pix_fmt", "yuv420p", f]);
    assert.equal(r.code, 0, r.stderr);
    const pc = await T.pictureChanges(f, 0.3);
    assert.ok(Math.abs(pc.duration - 6) < 0.2);
    assert.ok(pc.changes.some((c) => Math.abs(c.t - 3) < 0.1), JSON.stringify(pc.changes));
  });
});

describe("video types in the pipeline and the page API", () => {
  test("explainer / tutorial: write + render(+QA) only; ranked unchanged", () => {
    const { project } = M.createMade({ type: "explainer", topic: "zz formats types", points: "one point" });
    made.push(project);
    const cfg = P.readConfig(project);
    assert.equal(cfg?.type, "explainer");
    assert.deepEqual(P.stageSteps("writing", project, cfg), [["explainer", "-p", project, "--write"]]);
    assert.deepEqual(P.stageSteps("render", project, cfg), [["explainer", "-p", project, "--render"], ["qa", "-p", project]]);
    assert.deepEqual(P.stageSteps("visuals", project, cfg), []);
    assert.equal(P.stageSteps("writing", project, { topic: "x", products: ["a", "b"] })[0][0], "script");
    assert.throws(() => M.createMade({ type: "explainer", topic: "zz formats none" }), /at least one point/);
    assert.throws(() => M.createMade({ type: "tutorial", topic: "zz formats none", notes: "too short" }), /a few sentences/);
    assert.throws(() => M.createMade({ type: "ranked", topic: "x" }), /explainer, tutorial or documentary/);
    assert.ok(!fs.existsSync(path.join(paths.workspace, "zz-formats-none")), "a refused request leaves no folder");
    const v = M.madeView(project) as { type: string; stages: { id: string }[] };
    assert.equal(v.type, "explainer");
    assert.deepEqual(v.stages.map((s) => s.id), ["writing", "render"]);
  });
});
