import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { estimateVramMb, ModelLoader, parseNvidiaSmi, readGpuTimes, stageForCommand, withStage, currentStage, setDefaultStage } from "../src/lib/models/loader.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-models-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
const S = await import("../src/lib/agents/llm/settings.js");

/** Fake Ollama: /api/ps lists `resident`, /api/generate keep_alive 0 unloads, /api/tags lists `pulled`. */
function fakeOllama(resident: string[], pulled: string[]) {
  const calls: string[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const u = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (u.endsWith("/api/ps")) return new Response(JSON.stringify({ models: resident.map((name) => ({ name })) }));
    if (u.endsWith("/api/tags")) return new Response(JSON.stringify({ models: pulled.map((name) => ({ name })) }));
    if (u.endsWith("/api/generate") && body?.keep_alive === 0) {
      calls.push(`unload ${body.model}`);
      resident.splice(resident.indexOf(body.model), 1);
      return new Response("{}");
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls, resident };
}

function loader(f: typeof fetch, vram: { freeMb: number; totalMb: number } | null, statsFile: string | null = null) {
  const logs: string[] = [];
  const l = new ModelLoader({ baseUrl: () => "http://ollama", fetch: f, vram: async () => vram, log: (m) => logs.push(m), sleep: async () => {}, now: () => 0, statsFile });
  return { l, logs };
}

describe("model loader: one model in VRAM", () => {
  test("switching stage unloads every other resident model (keep_alive 0)", async () => {
    const o = fakeOllama(["qwen2.5:7b", "qwen2.5vl:7b"], ["qwen2.5:7b", "qwen2.5vl:7b"]);
    const { l, logs } = loader(o.f, { freeMb: 7000, totalMb: 8192 });
    const used = await l.ensure("qwen2.5vl:7b", "vision");
    assert.equal(used, "qwen2.5vl:7b");
    assert.deepEqual(o.calls, ["unload qwen2.5:7b"]);
    assert.ok(logs.some((m) => /VRAM guard ok/.test(m)));
    // Same model again: nothing unloaded.
    await l.ensure("qwen2.5vl:7b", "qa");
    assert.deepEqual(o.calls, ["unload qwen2.5:7b"]);
  });

  test("VRAM guard warns when free VRAM stays below what the model needs", async () => {
    const o = fakeOllama([], ["qwen3:8b"]);
    const { l, logs } = loader(o.f, { freeMb: 1200, totalMb: 8192 });
    await l.ensure("qwen3:8b", "script");
    assert.ok(logs.some((m) => /VRAM guard: 1200 MB free/.test(m)), logs.join("\n"));
  });

  test("a stage model that is not pulled falls back (logged)", async () => {
    const o = fakeOllama([], ["qwen2.5:7b"]);
    const { l, logs } = loader(o.f, null);
    assert.equal(await l.ensure("qwen3:8b", "titles", { fallback: "qwen2.5:7b" }), "qwen2.5:7b");
    assert.ok(logs.some((m) => /qwen3:8b is not pulled/.test(m)));
  });

  test("GPU time per stage is logged and summed into the stats file across processes", () => {
    const f = path.join(tmp, "gpu_time.json");
    const a = loader(fakeOllama([], []).f, null, f);
    a.l.record("qwen2.5:7b", "plan", { loadNs: 2e9, totalNs: 5e9, wallMs: 5000, cpu: false });
    a.l.record("qwen2.5:7b", "plan", { totalNs: 1e9, wallMs: 1000, cpu: false });
    assert.ok(a.logs.some((m) => /stage=plan model=qwen2.5:7b gpu load=2000 ms gpu_time=3000 ms/.test(m)), a.logs.join("\n"));
    const b = loader(fakeOllama([], []).f, null, f);
    b.l.record("qwen2.5:7b", "plan", { totalNs: 1e9, wallMs: 1000, cpu: true });
    const t = readGpuTimes(f).find((x) => x.stage === "plan")!;
    assert.deepEqual([t.requests, t.gpuMs, t.cpuMs, t.loadMs], [3, 4000, 1000, 2000]);
  });

  test("helpers: nvidia-smi parsing, VRAM estimate, stage of a command, stage scope", async () => {
    assert.deepEqual(parseNvidiaSmi("6123, 8192\n"), { freeMb: 6123, totalMb: 8192 });
    assert.equal(parseNvidiaSmi("No devices"), null);
    assert.ok(estimateVramMb("qwen2.5:7b") > estimateVramMb("qwen2.5vl:3b"));
    assert.equal(stageForCommand("plan"), "plan");
    assert.equal(stageForCommand("render"), undefined);
    setDefaultStage("plan");
    assert.equal(currentStage(), "plan");
    assert.equal(await withStage("vision", async () => currentStage()), "vision");
    setDefaultStage(undefined);
  });
});

describe("per-stage models in llm_settings.json", () => {
  test("defaults: qwen3:8b for niche/titles/script, the user's qwen model for plan, numCtx 8192", () => {
    fs.rmSync(process.env.LLM_SETTINGS_FILE!, { force: true });
    S.saveLlmSettings({ qwen: { mode: "local", model: "qwen2.5-cf:7b", visionModel: "qwen2.5vl:3b" } });
    const s = S.loadLlmSettings();
    assert.deepEqual(S.stageModel("script", false, s), { model: "qwen3:8b", numCtx: 8192 });
    assert.deepEqual(S.stageModel("plan", false, s), { model: "qwen2.5-cf:7b", numCtx: 8192 });
    assert.deepEqual(S.stageModel("plan", true, s), { model: "qwen2.5vl:3b", numCtx: 8192 });
    assert.deepEqual(S.stageModel(undefined, false, s), { model: "qwen2.5-cf:7b", numCtx: 8192 });
  });

  test("a stage entry overrides model and context; empty model clears it", () => {
    S.saveLlmSettings({ stages: { script: { model: "deepseek-r1:8b", numCtx: 6144 }, vision: { model: "gemma3:4b" } } });
    const s = S.loadLlmSettings();
    assert.deepEqual(S.stageModel("script", false, s), { model: "deepseek-r1:8b", numCtx: 6144 });
    assert.equal(S.stageModel("qa", true, s).model, "gemma3:4b");
    S.saveLlmSettings({ stages: { script: { model: "" } } });
    assert.equal(S.stageModel("script", false, S.loadLlmSettings()).model, "qwen3:8b");
  });
});
