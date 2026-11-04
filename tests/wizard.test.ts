import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-wizard-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.GPU_TIME_FILE = path.join(tmp, "gpu_time.json");

const { paths } = await import("../src/lib/paths.js");
const W = await import("../src/lib/orchestrator/wizard.js");
const P = await import("../src/lib/orchestrator/pipeline.js");
const { friendlyHint } = await import("../src/lib/orchestrator/friendly.js");
const { wizardRoute } = await import("../src/server/routes/wizard.js");

const made: string[] = [];
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const p of made) fs.rmSync(path.join(paths.workspace, p), { recursive: true, force: true });
  for (const f of fs.existsSync(paths.output) ? fs.readdirSync(paths.output) : []) if (f.startsWith("zz-wizard-test")) fs.rmSync(path.join(paths.output, f), { force: true });
});

const body = (b: unknown) => async () => JSON.stringify(b);

describe("friendly errors", () => {
  test("known problems become a plain title + fix; unknown ones still get a retry hint", () => {
    assert.equal(friendlyHint(["[research] YOUTUBE_API_KEY is not set in .env"], "research exited with code 1")!.title, "YouTube API key missing");
    assert.equal(friendlyHint(["[tts] CONFIGURATION ERROR: No TTS voice is set up."], "tts exited with code 2")!.where, "/tools");
    assert.match(friendlyHint(["Qwen not reachable at http://localhost:11434"], "x")!.fix, /Start Ollama/);
    assert.match(friendlyHint(["something odd failed here"], "plan exited with code 1")!.fix, /something odd failed here/);
    assert.equal(friendlyHint(["all good"]), null);
  });

  test("a failed pipeline stage stores its hint", async () => {
    const p = W.createVideo({ topic: "zz wizard test hint", products: ["A", "B"] }).project;
    made.push(p);
    const s = await P.runStage(p, "voice", { runner: async (argv, line) => (line(argv[0] === "tts" ? "[tts] CONFIGURATION ERROR: No TTS voice is set up." : "ok"), argv[0] === "tts" ? 2 : 0) });
    assert.equal(s.status, "failed");
    assert.equal(s.hint?.title, "No voice engine set up");
  });
});

describe("wizard", () => {
  test("project names come from the topic and never clash", () => {
    assert.equal(W.projectSlug("Best Budget 9mm Pistols (2026)!", () => false), "best-budget-9mm-pistols-2026");
    assert.equal(W.projectSlug("Best Budget", (n) => n === "best-budget"), "best-budget-2");
    assert.equal(W.projectSlug("!!!", () => false), "video");
  });

  test("create: config, title, product links; needs a topic and 2 products", async () => {
    const bad = await wizardRoute(["api", "wizard"], "POST", body({ topic: "x", products: ["only one"] }));
    assert.equal(bad!.status, 400);
    assert.match((bad!.body as { error: string }).error, /at least 2 products/);
    const r = await wizardRoute(["api", "wizard"], "POST", body({ topic: "zz wizard test pistols", title: "My Title", products: "Taurus G3C\nGlock 43X\nSig P365", words: 800, sources: { "Sig P365": "https://sig.example/p365", "Glock 43X": "not a link" } }));
    const project = (r!.body as { project: string }).project;
    made.push(project);
    assert.equal(project, "zz-wizard-test-pistols");
    const dir = path.join(paths.workspace, project);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "sources.json"), "utf8")), { "Sig P365": ["https://sig.example/p365"] });
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).title, "My Title");
    const info = (await wizardRoute(["api", "wizard", project], "GET", body({})))!.body as { step: number; stages: unknown[] };
    assert.equal(info.step, 3, "next: the script");
    assert.equal(info.stages.length, 7);
  });

  test("script: edit, checks (words vs target, numbers without a source), approve; editing takes the approval back", async () => {
    const project = "zz-wizard-test-pistols";
    const dir = path.join(paths.workspace, project);
    fs.writeFileSync(path.join(dir, "script.txt"), "Number three is the Glock 43X. It costs 499 dollars.\n");
    fs.writeFileSync(path.join(dir, "script_report.json"), JSON.stringify({ targetWords: 800, claims: { facts: [{ id: "F1", product: "Glock 43X", label: "Price", value: "$499", source: { url: "https://g.example", title: "Glock" } }] }, originality: { clean: true, flagged: 0 } }));
    let v = (await wizardRoute(["api", "wizard", project, "script"], "GET", body({})))!.body as { words: number; unsourced: unknown[]; onTarget: boolean; facts: unknown[] };
    assert.equal(v.unsourced.length, 0, "499 is a sourced fact; 43 is part of a product name");
    assert.equal(v.onTarget, false);
    v = (await wizardRoute(["api", "wizard", project, "script"], "PUT", body({ text: "Number three is the Glock 43X. It weighs 22 ounces.", approve: true })))!.body as typeof v & { approved: string | null };
    assert.deepEqual((v as { unsourced: { numbers: string[] }[] }).unsourced[0].numbers, ["22"]);
    assert.ok((v as { approved: string | null }).approved);
    await wizardRoute(["api", "wizard", project, "approve"], "POST", body({ what: "voice", on: true }));
    assert.equal(W.wizardStep(project), 5, "script and voice approved: next is the footage");
    await wizardRoute(["api", "wizard", project, "script"], "PUT", body({ text: "A changed script." }));
    assert.deepEqual(W.readApprovals(project), {}, "a changed script needs approving (and a new voice) again");
    const empty = await wizardRoute(["api", "wizard", project, "script"], "PUT", body({ text: "  " }));
    assert.equal(empty!.status, 400);
  });

  test("finished Shorts are served by name only", async () => {
    const project = "zz-wizard-test-pistols";
    fs.mkdirSync(paths.output, { recursive: true });
    fs.writeFileSync(path.join(paths.output, `${project}_short_1.mp4`), "x");
    const ok = await wizardRoute(["api", "wizard", project, "short", `${project}_short_1.mp4`], "GET", body({}));
    assert.equal(ok!.file, path.join(paths.output, `${project}_short_1.mp4`));
    const evil = await wizardRoute(["api", "wizard", project, "short", "..%2F..%2F.env"], "GET", body({}));
    assert.equal(evil!.status, 404);
  });
});
