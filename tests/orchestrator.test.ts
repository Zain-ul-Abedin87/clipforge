import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-orch-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.GPU_TIME_FILE = path.join(tmp, "gpu_time.json");
process.env.CHAT_DIR = path.join(tmp, "chat");

const S = await import("../src/lib/agents/llm/settings.js");
const { paths } = await import("../src/lib/paths.js");
const P = await import("../src/lib/orchestrator/pipeline.js");
const A = await import("../src/lib/orchestrator/agent.js");
const { pipelineRoute } = await import("../src/server/routes/pipeline.js");

const PROJ = "zz-orch-test";
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(paths.workspace, PROJ), { recursive: true, force: true });
});

/** Fake CLI: records argv; "render" can be made to fail; local-model steps add GPU time. */
function fakeRunner(o: { fail?: string } = {}) {
  const calls: string[][] = [];
  const runner = async (argv: string[], onLine: (l: string) => void) => {
    calls.push(argv);
    onLine(`[fake] ${argv.join(" ")}`);
    if (["script", "plan", "titles"].includes(argv[0])) {
      const f = process.env.GPU_TIME_FILE!;
      const all = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
      const k = `${argv[0]}|qwen`;
      all[k] = { stage: argv[0], model: "qwen", requests: (all[k]?.requests ?? 0) + 1, loads: 1, loadMs: 500, gpuMs: (all[k]?.gpuMs ?? 0) + 4000, cpuMs: 0 };
      fs.writeFileSync(f, JSON.stringify(all));
    }
    return argv[0] === o.fail ? 1 : 0;
  };
  return { runner, calls };
}

beforeEach(() => {
  fs.rmSync(path.join(paths.workspace, PROJ), { recursive: true, force: true });
  fs.rmSync(process.env.GPU_TIME_FILE!, { force: true });
  S.saveLlmSettings({ primary: "off" });
});

describe("pipeline stages", () => {
  test("7 stages in order; config written; each stage maps to CLI steps", () => {
    assert.deepEqual([...P.PIPELINE_STAGES], ["research", "writing", "voice", "visuals", "avatar", "edit", "render"]);
    const cfg = P.saveConfig(PROJ, { topic: "best budget 9mm pistols", products: ["Taurus G3C", "Glock 43X", "Sig P365"], words: 1500, channel: "default" });
    assert.deepEqual(P.stageSteps("writing", PROJ, cfg)[0].slice(0, 6), ["script", "-p", PROJ, "-t", "best budget 9mm pistols", "--products"]);
    assert.deepEqual(P.stageSteps("render", PROJ, cfg).map((a) => a[0]), ["render", "qa", "shorts"]);
    assert.deepEqual(P.stageSteps("voice", PROJ, cfg).map((a) => a[0]), ["tts", "transcribe", "align"]);
    assert.deepEqual(P.stageSteps("writing", PROJ, { topic: "", products: [] }), [], "no topic: nothing to write");
  });

  test("a full run: status, duration and GPU time per stage", async () => {
    P.saveConfig(PROJ, { topic: "best budget 9mm pistols", products: ["A", "B"], channel: "default" });
    const f = fakeRunner();
    const st = await P.runPipeline(PROJ, "research", { runner: f.runner });
    for (const s of P.PIPELINE_STAGES) assert.equal(st.stages[s].status, "done", s);
    assert.equal(st.stages.writing.gpuMs, 4000);
    assert.equal(st.stages.visuals.gpuMs, 4000);
    assert.equal(st.stages.render.gpuMs, 0);
    assert.ok(st.stages.research.ms! >= 0 && st.stages.research.log!.some((l) => l.includes("research")));
    assert.deepEqual(f.calls.map((c) => c[0]), ["research", "titles", "script", "tts", "transcribe", "align", "plan", "assets", "visuals", "avatar", "timeline", "render", "qa", "shorts"]);
  });

  test("a failed step stops the run; the dashboard shows it", async () => {
    P.saveConfig(PROJ, { topic: "t", products: ["A"], channel: "default" });
    const st = await P.runPipeline(PROJ, "edit", { runner: fakeRunner({ fail: "render" }).runner });
    assert.equal(st.stages.edit.status, "done");
    assert.equal(st.stages.render.status, "failed");
    assert.match(st.stages.render.error!, /render exited with code 1/);
    const row = P.listProjects().find((p) => p.name === PROJ)!;
    assert.equal(row.current, "Render failed");
    assert.equal(row.stages.edit, "done");
  });

  test("API: config, run in the background, dashboard, models", async () => {
    const body = (b: unknown) => async () => JSON.stringify(b);
    const put = await pipelineRoute(["api", "pipeline", PROJ, "config"], "PUT", body({ topic: "budget knives", products: "Mora, Kabar", words: 900 }));
    assert.deepEqual((put!.body as { products: string[] }).products, ["Mora", "Kabar"]);
    const get = await pipelineRoute(["api", "pipeline", PROJ], "GET", body({}));
    assert.equal((get!.body as { stages: unknown[] }).stages.length, 7);
    const bad = await pipelineRoute(["api", "pipeline", PROJ, "run"], "POST", body({ stage: "nope" }));
    assert.equal(bad!.status, 400);
    const dash = await pipelineRoute(["api", "dashboard"], "GET", body({}));
    assert.ok((dash!.body as { projects: { name: string }[] }).projects.some((p) => p.name === PROJ));
    const models = await pipelineRoute(["api", "models"], "PUT", body({ stages: { script: { model: "deepseek-r1:8b", numCtx: 8192 } } }));
    const script = (models!.body as { stages: { id: string; text: { model: string } }[] }).stages.find((s) => s.id === "script")!;
    assert.equal(script.text.model, "deepseek-r1:8b");
  });
});

describe("chat orchestrator (rules, no model)", () => {
  test("create -> approve -> each stage proposed next and run only after approval", async () => {
    const f = fakeRunner();
    let s = A.loadSession(null);
    s = await A.chat(s, `create ${PROJ} topic: best budget 9mm pistols products: Taurus G3C, Glock 43X, Sig P365`);
    assert.equal(s.pending?.tool, "create_project");
    assert.equal(f.calls.length, 0, "nothing runs before approval");
    s = await A.approve(s, true, { runner: f.runner, wait: true });
    assert.equal(P.readConfig(PROJ)?.products.length, 3);
    assert.deepEqual([s.pending?.tool, s.pending?.args.stage], ["run_stage", "research"], "the next stage is proposed");
    s = await A.approve(s, true, { runner: f.runner, wait: true });
    assert.deepEqual(f.calls.map((c) => c[0]), ["research", "titles"]);
    assert.equal(s.pending?.args.stage, "writing");
    s = await A.approve(s, false, { runner: f.runner, wait: true });
    assert.equal(s.pending, null);
    assert.equal(f.calls.length, 2, "rejected: nothing ran");
    s = await A.chat(s, "next");
    assert.equal(s.pending?.args.stage, "writing");
    s = await A.chat(s, `status for ${PROJ}`);
    assert.match(s.messages.at(-1)!.content, /Research: done/);
  });

  test("bad arguments are asked about instead of run; read-only tools run at once", async () => {
    let s = A.loadSession(null);
    s = await A.chat(s, "create !!! topic: x products: a");
    assert.equal(s.pending, null);
    s = await A.chat(s, "list projects");
    assert.equal(s.messages.at(-1)!.role, "tool");
    assert.equal(A.checkArgs({ tool: "run_stage", args: { project: PROJ, stage: "dance" } })?.startsWith("Unknown stage"), true);
  });
});
