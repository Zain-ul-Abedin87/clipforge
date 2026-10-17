import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

// Never touch the user's real settings / spend files.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-llm-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
const { claudeCost, llm, llmAvailable, needsOf, setQwenFetch, toChatMessages } = await import("../src/lib/agents/llm/llm.js");
const S = await import("../src/lib/agents/llm/settings.js");

const savedEnv = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL, qwen: process.env.QWEN_API_KEY };
after(() => {
  for (const [k, v] of [["ANTHROPIC_API_KEY", savedEnv.key], ["ANTHROPIC_BASE_URL", savedEnv.base], ["QWEN_API_KEY", savedEnv.qwen]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const Labels = z.object({ scenes: z.array(z.object({ id: z.number().int(), type: z.enum(["stock", "product"]) })) });
const req = (extra: Record<string, unknown> = {}) => ({
  model: "claude-haiku-5-5",
  max_tokens: 2000,
  system: "You label scenes.",
  output_config: { format: zodOutputFormat(Labels) },
  messages: [{ role: "user" as const, content: "scene 0: the mower deck" }],
  ...extra,
});

/** Fake Qwen endpoint: returns the queued answers in order and records the requests. */
function fakeQwen(answers: { text?: string; status?: number; usage?: [number, number] }[]) {
  const seen: Record<string, unknown>[] = [];
  setQwenFetch((async (_url: string, init: RequestInit) => {
    seen.push(JSON.parse(String(init.body)));
    const a = answers.shift() ?? { text: "{}" };
    if (a.status && a.status >= 400) return new Response(JSON.stringify({ error: { message: "quota exceeded, Arrearage" } }), { status: a.status });
    return new Response(JSON.stringify({ choices: [{ message: { content: a.text }, finish_reason: "stop" }], usage: { prompt_tokens: a.usage?.[0] ?? 1000, completion_tokens: a.usage?.[1] ?? 200 } }), { status: 200 });
  }) as unknown as typeof fetch);
  return seen;
}

beforeEach(() => {
  fs.rmSync(process.env.LLM_SETTINGS_FILE!, { force: true });
  fs.rmSync(process.env.LLM_USAGE_FILE!, { force: true });
  process.env.QWEN_API_KEY = "test-qwen";
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_BASE_URL;
});

describe("request translation (Anthropic shape -> Qwen chat)", () => {
  test("system + JSON-schema instruction, images as data URIs, tool results as text", () => {
    const msgs = toChatMessages(
      {
        system: [{ type: "text", text: "Be brief." }],
        messages: [
          { role: "user", content: [{ type: "text", text: "Which fits?" }, { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "AAAA" } }] },
          { role: "assistant", content: "ok" },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "42" }] },
        ],
      },
      { type: "object" },
    );
    assert.equal(msgs[0].role, "system");
    assert.match(String(msgs[0].content), /Be brief\.[\s\S]*ONLY one JSON object[\s\S]*\{"type":"object"\}/);
    assert.deepEqual(msgs[1].content, [{ type: "text", text: "Which fits?" }, { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } }]);
    assert.deepEqual([msgs[2].role, msgs[2].content], ["assistant", "ok"]);
    assert.equal(msgs[3].content, "42");
    assert.deepEqual(needsOf({ messages: [{ role: "user", content: [{ type: "image" }] }], tools: [{ name: "web_search" }] }), { vision: true, tools: true });
  });

  test("Claude prices per model", () => {
    assert.equal(claudeCost("claude-haiku-5-5", 1_000_000, 1_000_000), 0.6);
    assert.equal(claudeCost("claude-haiku-4-5", 1_000_000, 0), 1);
    assert.equal(claudeCost("claude-opus-5-5", 0, 1_000_000), 20);
  });
});

describe("Qwen as the active model", () => {
  test("structured output is validated with the same zod schema; one repair round; spend counted", async () => {
    S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { priceIn: 0.4, priceOut: 1.2 } });
    const seen = fakeQwen([{ text: '```json\n{"scenes":[{"id":0,"type":"mower"}]}\n```' }, { text: '{"scenes":[{"id":0,"type":"product"}]}' }]);
    const res = await llm().messages.parse(req());
    assert.deepEqual(res.parsed_output, { scenes: [{ id: 0, type: "product" }] });
    assert.equal(seen.length, 2, "first answer failed validation -> one repair request");
    assert.equal((seen[0] as { model: string }).model, "qwen-plus");
    assert.deepEqual((seen[0] as { response_format: unknown }).response_format, { type: "json_object" });
    assert.match(JSON.stringify((seen[1] as { messages: unknown[] }).messages.at(-1)), /not valid/);
    const u = S.readUsage();
    assert.equal(u.qwen.calls, 1);
    assert.equal(u.qwen.inputTokens, 2000);
    assert.equal(u.qwen.spentUsd, (2000 * 0.4 + 400 * 1.2) / 1e6);
  });

  test("images go to the vision model; web-search steps are never sent to Qwen", async () => {
    S.saveLlmSettings({ primary: "qwen", fallback: "none" });
    const seen = fakeQwen([{ text: '{"scenes":[]}' }]);
    await llm().messages.parse(req({ messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }, { type: "text", text: "?" }] }] }));
    assert.equal((seen[0] as { model: string }).model, "qwen-vl-plus");
    assert.equal(llmAvailable({ tools: true }), false);
    await assert.rejects(llm().beta.messages.create({ model: "x", max_tokens: 10, tools: [{ type: "web_search_20260209", name: "web_search" }], messages: [{ role: "user", content: "hi" }] } as never), Anthropic.APIError);
  });

  test("a quota / credit answer from Qwen disables it; errors are Anthropic.APIError (agents fall back)", async () => {
    S.saveLlmSettings({ primary: "qwen", fallback: "none" });
    fakeQwen([{ status: 402 }]);
    await assert.rejects(llm().messages.parse(req()), (e) => e instanceof Anthropic.APIError);
    assert.match(S.providerStatus("qwen").blocked ?? "", /out of credit/);
    assert.equal(llmAvailable(), false);
    S.enableProvider("qwen");
    assert.equal(llmAvailable(), true, "Re-enable button");
  });

  test("Off = no AI: llmAvailable is false and calls fail cleanly", async () => {
    S.saveLlmSettings({ primary: "off" });
    assert.equal(llmAvailable(), false);
    await assert.rejects(llm().messages.parse(req()), /no AI model is available/);
  });
});

describe("budget and auto-disable", () => {
  test("spend counted against the credit you entered; below 'stop below' the model is skipped", () => {
    S.saveLlmSettings({ primary: "qwen", fallback: "none", budget: { qwen: { creditUsd: 1, stopBelowUsd: 0.5 } } });
    assert.equal(S.providerStatus("qwen").remainingUsd, 1);
    S.recordUsage("qwen", "qwen-plus", 100, 100, 0.3);
    assert.equal(S.providerStatus("qwen").blocked, null);
    S.recordUsage("qwen", "qwen-plus", 100, 100, 0.25);
    assert.match(S.providerStatus("qwen").blocked ?? "", /budget reached: about \$0\.45 left/);
    assert.deepEqual(S.providerOrder(), []);
    // Entering a new credit amount (after a top-up) restarts the count.
    S.saveLlmSettings({ budget: { qwen: { creditUsd: 5, stopBelowUsd: 0.5 } } });
    assert.equal(S.providerStatus("qwen").spentUsd, 0);
    assert.deepEqual(S.providerOrder(), ["qwen"]);
  });

  test("settings are validated; switching Qwen to local loads the Ollama preset", () => {
    const s = S.saveLlmSettings({ primary: "bogus", qwen: { mode: "local", baseUrl: "javascript:alert(1)" }, budget: { claude: { creditUsd: -5 } } });
    assert.equal(s.primary, "claude");
    assert.equal(s.qwen.baseUrl, "http://localhost:11434/v1");
    assert.equal(s.qwen.model, "qwen2.5:7b");
    assert.equal(s.budget.claude.creditUsd, null);
    assert.equal(S.providerStatus("qwen").configured, true, "local needs no key");
  });
});

describe("Claude out of credit -> auto-disable -> same request finishes on Qwen", () => {
  let server: http.Server;
  let hits = 0;
  before(async () => {
    // Plays the Anthropic API: every request is answered like an account with no credit left.
    server = http.createServer((_req, res) => {
      hits++;
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  });
  after(() => server.close());

  test("real SDK call, credit error, Claude disabled, Qwen answers", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    S.saveLlmSettings({ primary: "claude", fallback: "qwen" });
    fakeQwen([{ text: '{"scenes":[{"id":3,"type":"stock"}]}' }]);
    const res = await llm().messages.parse(req());
    assert.equal(hits, 1);
    assert.deepEqual(res.parsed_output, { scenes: [{ id: 3, type: "stock" }] });
    assert.match(S.providerStatus("claude").blocked ?? "", /out of credit/);
    // The next call goes straight to Qwen (Claude is not even tried).
    fakeQwen([{ text: '{"scenes":[]}' }]);
    await llm().messages.parse(req());
    assert.equal(hits, 1);
  });
});
