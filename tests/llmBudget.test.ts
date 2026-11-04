import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";

// Never touch the user's real settings / spend files.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-llmbudget-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
const { answerTokens, batchSize, estimateTokens, imagesPerRequest, isTooBig, llm, looksEmpty, resetGpuFaults, retryCtx, runImageBatches, setQwenFetch, splitWhenTooBig } = await import("../src/lib/agents/llm/llm.js");
const S = await import("../src/lib/agents/llm/settings.js");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const Labels = z.object({ scenes: z.array(z.object({ id: z.number().int(), type: z.enum(["stock", "product"]) })) });
const req = (text: string) => ({ model: "x", max_tokens: 2000, system: "You label scenes.", output_config: { format: zodOutputFormat(Labels) }, messages: [{ role: "user" as const, content: text }] });

/** Fake Ollama /api/chat: records requests; `gpuText` answers on the GPU, the CPU answers properly. */
function fakeOllama(gpuText: string) {
  const seen: Record<string, any>[] = [];
  setQwenFetch((async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    seen.push(body);
    const text = body.options?.num_gpu === 0 ? '{"scenes":[{"id":0,"type":"product"}]}' : gpuText;
    return new Response(JSON.stringify({ message: { content: text }, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 5 }), { status: 200 });
  }) as unknown as typeof fetch);
  return seen;
}

beforeEach(() => {
  fs.rmSync(process.env.LLM_SETTINGS_FILE!, { force: true });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.LLM_BATCH_SCENES;
  resetGpuFaults();
  S.saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local", numCtx: 4096, maxBatch: 15 } });
});

describe("local model token budget", () => {
  test("every request carries num_ctx and an answer cap that fits inside it", async () => {
    const seen = fakeOllama('{"scenes":[{"id":0,"type":"stock"}]}');
    await llm().messages.parse(req("scene 0: the deck"));
    assert.equal(seen[0].options.num_ctx, 4096);
    assert.equal(seen[0].options.num_predict, answerTokens(2000, 4096));
    assert.ok(seen[0].options.num_predict <= 4096 * 0.3);
  });

  test("a prompt over num_ctx is refused before it is sent (413), never cut by Ollama", async () => {
    const seen = fakeOllama("{}");
    await assert.rejects(llm().messages.parse(req("word ".repeat(4000))), (e: unknown) => e instanceof Anthropic.APIError && e.status === 413 && isTooBig(e));
    assert.equal(seen.length, 0);
  });

  test("garbage to a multi-item request inside splitWhenTooBig -> 'split it' (422), halves stay on the GPU", async () => {
    const seen = fakeOllama("@");
    const items = ["scene 0: the deck", "scene 1: the blade"];
    const parts: number[] = [];
    // Every GPU answer is garbage: the pair is halved (GPU), each single item gets a smaller-context
    // GPU retry, and only then the CPU.
    const out = await splitWhenTooBig(items, async (part) => {
      parts.push(part.length);
      return [await llm().messages.parse(req(part.join("\n")))];
    });
    assert.equal(out.length, 2);
    assert.deepEqual(parts, [2, 1, 1]);
    assert.deepEqual(seen.map((b) => b.options.num_gpu ?? "gpu"), ["gpu", "gpu", "gpu", 0, "gpu", "gpu", 0]);
  });

  test("garbage from a single request: GPU retry with a smaller num_ctx first, the CPU only after that", async () => {
    const seen = fakeOllama("@");
    const res = await llm().messages.parse(req("scene 0: the deck"));
    assert.deepEqual(res.parsed_output, { scenes: [{ id: 0, type: "product" }] });
    assert.deepEqual(seen.map((b) => b.options.num_gpu ?? "gpu"), ["gpu", "gpu", 0]);
    assert.equal(seen[0].options.num_ctx, 4096);
    assert.equal(seen[1].options.num_ctx, 2048, "retry halves the context when the prompt still fits");
  });

  test("a GPU retry that answers properly never reaches the CPU", async () => {
    let n = 0;
    const seen: Record<string, any>[] = [];
    setQwenFetch((async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push(body);
      const text = n++ === 0 ? "@@@@@@@@" : '{"scenes":[{"id":0,"type":"stock"}]}';
      return new Response(JSON.stringify({ message: { content: text }, done: true, done_reason: "stop" }), { status: 200 });
    }) as unknown as typeof fetch);
    const res = await llm().messages.parse(req("scene 0: the deck"));
    assert.deepEqual(res.parsed_output, { scenes: [{ id: 0, type: "stock" }] });
    assert.deepEqual(seen.map((b) => b.options.num_gpu ?? "gpu"), ["gpu", "gpu"]);
  });

  test("retryCtx: half when it fits, else the smallest 1K step that fits, else unchanged", () => {
    assert.equal(retryCtx(8192, 500, 2000), 4096);
    assert.equal(retryCtx(8192, 3500, 2000), 5120);
    assert.equal(retryCtx(8192, 6000, 2000), 8192);
  });

  test("numCtx defaults to 8192 (16384 spilled a 7B model to the CPU on 8 GB)", () => {
    fs.rmSync(process.env.LLM_SETTINGS_FILE!, { force: true });
    assert.equal(S.loadLlmSettings().qwen.numCtx, 8192);
    assert.equal(S.loadLlmSettings().qwen.maxImages, 2);
  });

  test("estimates: ~3.5 chars per token, ~1200 per image; empty / one-symbol answers are garbage", () => {
    assert.equal(estimateTokens([{ role: "user", content: "x".repeat(684) }]), 200);
    assert.equal(estimateTokens([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:," } }] }]), 1200 + 5);
    for (const t of ["", "@", " } ", "@@"]) assert.ok(looksEmpty(t), JSON.stringify(t));
    assert.ok(!looksEmpty('{"a":1}'));
  });

  test("batch size of a local model is capped by maxBatch from llm_settings.json", () => {
    assert.equal(batchSize(60), 15);
    S.saveLlmSettings({ qwen: { maxBatch: 6 } });
    assert.equal(batchSize(60), 6);
  });
});

describe("splitWhenTooBig", () => {
  test("halves a job the model cannot take, down to what fits, results in order", async () => {
    const calls: number[][] = [];
    const tooBig = new Anthropic.APIError(413, { type: "error", error: { type: "api_error", message: "split" } }, "split the request", undefined);
    const out = await splitWhenTooBig([1, 2, 3, 4, 5], async (part) => {
      calls.push(part);
      if (part.length > 2) throw tooBig;
      return part.map((x) => x * 10);
    });
    assert.deepEqual(out, [10, 20, 30, 40, 50]);
    assert.deepEqual(calls, [[1, 2, 3, 4, 5], [1, 2, 3], [1, 2], [3], [4, 5]]);
  });

  test("other errors are not swallowed", async () => {
    await assert.rejects(splitWhenTooBig([1, 2], async () => { throw new Error("boom"); }), /boom/);
  });
});

describe("vision requests: 1-2 images per request, never skipped on 413", () => {
  test("a local vision model gets qwen.maxImages (default 2) per request; Claude its own size", () => {
    assert.equal(imagesPerRequest(36), 2);
    S.saveLlmSettings({ qwen: { maxImages: 1 } });
    assert.equal(imagesPerRequest(36), 1);
  });

  test("runImageBatches packs units by image count and halves a pack the model refuses", async () => {
    const tooBig = new Anthropic.APIError(413, { type: "error", error: { type: "api_error", message: "split" } }, "split the request", undefined);
    const calls: string[][] = [];
    const units = [{ id: "a", n: 1 }, { id: "b", n: 1 }, { id: "c", n: 2 }, { id: "d", n: 1 }];
    const { results, failed } = await runImageBatches(units, (u) => u.n, 2, async (part) => {
      calls.push(part.map((u) => u.id));
      if (part.length > 1 && part[0].id === "a") throw tooBig; // the first pack is refused once
      return part.map((u) => u.id.toUpperCase());
    });
    assert.deepEqual(results, ["A", "B", "C", "D"]);
    assert.deepEqual(failed, []);
    assert.deepEqual(calls, [["a", "b"], ["a"], ["b"], ["c"], ["d"]]);
  });

  test("a pack that fails for another reason is reported, the rest still run", async () => {
    const { results, failed } = await runImageBatches([1, 2, 3], () => 1, 1, async (part) => {
      if (part[0] === 2) throw new Error("boom");
      return part;
    });
    assert.deepEqual(results, [1, 3]);
    assert.deepEqual(failed, [2]);
  });
});
