import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-hybrid-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.ANTHROPIC_API_KEY = "test-key";
process.env.LLM_MODEL = "claude-opus-5-5";

// A stand-in for the Claude API: records the model of every request.
const seen: string[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const j = JSON.parse(body || "{}") as { model?: string };
    seen.push(String(j.model));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: j.model, content: [{ type: "text", text: "from claude" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 1000 } }));
  });
});
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const S = await import("../src/lib/agents/llm/settings.js");
const E = await import("../src/lib/agents/llm/engine.js");
const { llm, setQwenFetch } = await import("../src/lib/agents/llm/llm.js");
const { withStage } = await import("../src/lib/models/loader.js");

let localCalls = 0;
setQwenFetch((async (url: string) => {
  if (/\/api\/(ps|tags|generate)/.test(String(url))) return new Response(JSON.stringify({ models: [] }));
  localCalls++;
  return new Response(JSON.stringify({ message: { content: "from local" }, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 }));
}) as unknown as typeof fetch);

const ask = (stage: "script" | "plan" | "titles") =>
  withStage(stage, () => llm().messages.create({ model: process.env.LLM_MODEL!, max_tokens: 50, messages: [{ role: "user", content: "hi" }] })) as Promise<{ content: { text: string }[] }>;

describe("hybrid engine", () => {
  test("hybrid = script on Claude Sonnet 5.5, everything else local; switching back clears it", () => {
    let s = E.setEngine("hybrid");
    assert.equal(E.currentEngine(s), "hybrid");
    assert.deepEqual(s.stages.script, { provider: "claude", claudeModel: "claude-sonnet-5-5" });
    assert.deepEqual([s.primary, s.fallback, s.qwen.mode], ["qwen", "none", "local"]);
    assert.deepEqual(S.providerOrder(s, undefined, "script"), ["claude", "qwen"], "the local model is the script's backup");
    assert.deepEqual(S.providerOrder(s, undefined, "plan"), ["qwen"], "no other stage can reach Claude");
    s = E.setEngine("local");
    assert.equal(E.currentEngine(s), "local");
    assert.equal(s.stages.script?.provider, undefined);
    assert.deepEqual(S.providerOrder(s, undefined, "script"), ["qwen"]);
  });

  test("real requests: the script stage goes to Claude as Sonnet (not LLM_MODEL); plan / titles go local", async () => {
    E.setEngine("hybrid");
    seen.length = 0;
    localCalls = 0;
    assert.equal((await ask("script")).content[0].text, "from claude");
    assert.equal((await ask("plan")).content[0].text, "from local");
    assert.equal((await ask("titles")).content[0].text, "from local");
    assert.deepEqual(seen, ["claude-sonnet-5-5"]);
    assert.equal(localCalls, 2);
    // Cost recorded at Sonnet 5.5's price ($2 in / $10 out per 1M): 1000 + 1000 tokens = $0.012.
    const u = JSON.parse(fs.readFileSync(process.env.LLM_USAGE_FILE!, "utf8"));
    assert.ok(Math.abs(u.claude.spentUsd - 0.012) < 1e-9, JSON.stringify(u.claude));
  });

  test("no Claude key: the script is written locally instead of failing", async () => {
    E.setEngine("hybrid");
    const key = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      seen.length = 0;
      assert.equal((await ask("script")).content[0].text, "from local");
      assert.deepEqual(seen, []);
    } finally {
      process.env.ANTHROPIC_API_KEY = key;
    }
  });

  test("stage provider settings are validated (an invalid value changes nothing)", () => {
    E.setEngine("local");
    const s = S.saveLlmSettings({ stages: { script: { provider: "openai", claudeModel: "gpt-5" }, plan: { provider: "claude", claudeModel: "claude-haiku-5-5" } } });
    assert.equal(s.stages.script?.provider, undefined);
    assert.equal(s.stages.script?.claudeModel, undefined);
    assert.equal(s.stages.plan?.provider, "claude");
    assert.equal(s.stages.plan?.claudeModel, "claude-haiku-5-5");
  });
});
