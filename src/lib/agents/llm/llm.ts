import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../env.js";
import { currentStage, modelLoader } from "../../models/loader.js";
import { DEFAULT_NUM_CTX, disableProvider, loadLlmSettings, providerOrder, ProviderName, qwenKey, recordUsage, stageModel } from "./settings.js";

/**
 * One AI client for every agent: `llm().messages.parse(...)` / `.create(...)` (and `.beta.messages.*`)
 * with the Anthropic request shape the agents already use.
 *
 *  - Claude: the request goes to Anthropic unchanged.
 *  - Qwen:   the request is translated to Qwen's OpenAI-compatible chat API (Alibaba Model Studio or
 *            Ollama on this PC): system + text + images; a structured-output schema becomes a JSON
 *            instruction and the answer is validated by the very same schema (one repair retry).
 *
 * Order: settings primary -> fallback, skipping providers that are not configured, disabled or out
 * of budget. Every call's tokens are priced and added to the provider's spend; a "credit balance
 * too low" / quota answer or a rejected key disables that provider and the same request moves on
 * to the next one. Failures are thrown as Anthropic.APIError, which every agent already handles by
 * falling back to its rule-based path.
 */

/** USD per 1M tokens [input, output] (Anthropic list prices). Unknown models count as Opus. */
const CLAUDE_PRICES: [RegExp, number, number][] = [
  [/^claude-(fable|mythos)/, 10, 50],
  [/^claude-opus-5-5/, 4, 20],
  [/^claude-opus/, 5, 25],
  [/^claude-sonnet-5/, 2, 10],
  [/^claude-sonnet/, 3, 15],
  [/^claude-haiku-5/, 0.1, 0.5],
  [/^claude-haiku/, 1, 5],
];
export function claudeCost(model: string, inTok: number, outTok: number): number {
  const [, pin, pout] = CLAUDE_PRICES.find(([re]) => re.test(model)) ?? [null, 5, 25];
  return (inTok * pin + outTok * pout) / 1e6;
}

type Params = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Kind = "parse" | "create";

/** What a request needs: images go to the vision model; server tools (web search) only exist on Claude. */
export function needsOf(params: Params): { vision: boolean; tools: boolean } {
  const blocks = (params.messages ?? []).flatMap((m: Params) => (Array.isArray(m.content) ? m.content : []));
  return { vision: blocks.some((b: Params) => b?.type === "image"), tools: Array.isArray(params.tools) && params.tools.length > 0 };
}

/** True when at least one usable provider can serve this kind of request. */
export function llmAvailable(need: { vision?: boolean; tools?: boolean } = {}): boolean {
  const s = loadLlmSettings();
  return providerOrder(s).some((p) => p === "claude" || (!need.tools && (!need.vision || !!s.qwen.visionModel)));
}

/** Name of the provider that would serve a text request now (for logs / UI), or null. */
export const activeProvider = (): ProviderName | null => providerOrder()[0] ?? null;

/**
 * How many items one request should carry. A local 7B model has an 8K context and writes
 * ~60 tokens/s, so big batches overflow or time out. `localSize` is what fits a local model
 * (default: a third of the Claude size, at least 8; image requests pass 1).
 */
export function batchSize(claudeSize: number, localSize = Math.max(8, Math.round(claudeSize / 3))): number {
  const override = Number(env("LLM_BATCH_SCENES", "0"));
  if (override > 0) return override;
  const s = loadLlmSettings();
  return activeProvider() === "qwen" && s.qwen.mode === "local" ? Math.max(1, Math.min(localSize, s.qwen.maxBatch || localSize)) : claudeSize;
}

/** A request the local model cannot take in one piece (413: over num_ctx; 422 from a big request: garbage). */
export const isTooBig = (err: unknown) => err instanceof Anthropic.APIError && (err.status === 413 || (err.status === 422 && /split/i.test(err.message)));

/**
 * Set while a request runs inside splitWhenTooBig with more than one item: a garbage answer from the
 * GPU then asks the caller to halve the request (still on the GPU) instead of going to the CPU.
 */
const splitScope = new AsyncLocalStorage<{ canSplit: boolean }>();

/**
 * For callers that split a batch themselves (planner labels): marks a request of `items` items as
 * splittable, so a garbage GPU answer comes back as "split it" (422) instead of going to the CPU.
 */
export const splittable = <T>(items: number, fn: () => Promise<T>): Promise<T> => splitScope.run({ canSplit: items > 1 }, fn);

/**
 * Runs `run` on all items; when the model says the request is too big (see isTooBig), runs each half
 * on its own, down to single items. Results come back in item order. Any other error is thrown.
 * A garbage / empty GPU answer to a multi-item request counts as too big: it is halved and retried
 * on the GPU, and only a single item that still fails may go to the CPU.
 */
export async function splitWhenTooBig<T, R>(items: T[], run: (part: T[]) => Promise<R[]>, log: (m: string) => void = () => {}): Promise<R[]> {
  try {
    return await splitScope.run({ canSplit: items.length > 1 }, () => run(items));
  } catch (err) {
    if (!isTooBig(err) || items.length <= 1) throw err;
    const mid = Math.ceil(items.length / 2);
    log(`[llm] request too big for the local model (${String((err as Error).message).slice(0, 120)}); splitting ${items.length} items into ${mid} + ${items.length - mid}`);
    return [...(await splitWhenTooBig(items.slice(0, mid), run, log)), ...(await splitWhenTooBig(items.slice(mid), run, log))];
  }
}

/** Images one request may carry: the local vision model's maxImages (default 2), Claude `claudeMax`. */
export function imagesPerRequest(claudeMax: number): number {
  const s = loadLlmSettings();
  return activeProvider() === "qwen" && s.qwen.mode === "local" ? Math.max(1, Math.min(claudeMax, s.qwen.maxImages || 2)) : claudeMax;
}

/**
 * Packs `units` into requests of at most `maxImages` images each (a unit with more images goes
 * alone; callers cap a unit's images at maxImages), then runs every pack through splitWhenTooBig, so a
 * pack the model refuses (413) or answers with garbage is halved, never skipped. A pack that fails
 * for another reason is logged and the rest still run. Results come back in unit order.
 */
export async function runImageBatches<T, R>(
  units: T[],
  imagesOf: (u: T) => number,
  maxImages: number,
  run: (part: T[]) => Promise<R[]>,
  log: (m: string) => void = () => {},
): Promise<{ results: R[]; failed: T[] }> {
  const packs: T[][] = [];
  let cur: T[] = [];
  let n = 0;
  for (const u of units) {
    const k = Math.max(1, imagesOf(u));
    if (cur.length && n + k > maxImages) {
      packs.push(cur);
      cur = [];
      n = 0;
    }
    cur.push(u);
    n += k;
  }
  if (cur.length) packs.push(cur);
  const results: R[] = [];
  const failed: T[] = [];
  for (const p of packs) {
    try {
      results.push(...(await splitWhenTooBig(p, run, log)));
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) throw err;
      failed.push(...p);
      log(`[llm] image request failed (${p.length} item(s)): ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  return { results, failed };
}

const apiError = (status: number, message: string) => new Anthropic.APIError(status, { type: "error", error: { type: "api_error", message } }, message, undefined);

const isCreditError = (err: unknown) => {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  return (err instanceof Anthropic.APIError && (err.status === 402 || ((err.status === 400 || err.status === 403) && /credit|billing|balance|quota|purchase/.test(msg)))) || /credit balance is too low/.test(msg);
};

// ---------------------------------------------------------------------------------------------
// Claude

async function callClaude(kind: Kind, beta: boolean, params: Params): Promise<unknown> {
  const client = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
  const api = beta ? client.beta.messages : client.messages;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = (await (api as any)[kind](params)) as { usage?: { input_tokens?: number; output_tokens?: number } };
  const inTok = res.usage?.input_tokens ?? 0;
  const outTok = res.usage?.output_tokens ?? 0;
  recordUsage("claude", String(params.model), inTok, outTok, claudeCost(String(params.model), inTok, outTok));
  return res;
}

// ---------------------------------------------------------------------------------------------
// Qwen (OpenAI-compatible chat completions)

type ChatPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
type ChatMessage = { role: "system" | "user" | "assistant"; content: string | ChatPart[] };

/** Anthropic content (string or blocks) -> OpenAI chat content. Tool / document blocks become text. */
export function toChatContent(content: unknown): string | ChatPart[] {
  if (typeof content === "string") return content;
  const parts: ChatPart[] = [];
  for (const b of (content ?? []) as Params[]) {
    if (b?.type === "text") parts.push({ type: "text", text: String(b.text) });
    else if (b?.type === "image" && b.source?.type === "base64") parts.push({ type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } });
    else if (b?.type === "image" && b.source?.type === "url") parts.push({ type: "image_url", image_url: { url: String(b.source.url) } });
    else if (b?.type === "tool_result") parts.push({ type: "text", text: typeof b.content === "string" ? b.content : JSON.stringify(b.content) });
  }
  return parts.every((p) => p.type === "text") ? parts.map((p) => (p as { text: string }).text).join("\n\n") : parts;
}

const systemText = (system: unknown): string => (typeof system === "string" ? system : Array.isArray(system) ? system.map((b: Params) => b?.text ?? "").join("\n\n") : "");

/** Anthropic request -> chat messages (system first; mid-conversation system messages kept in place). */
export function toChatMessages(params: Params, schema?: unknown): ChatMessage[] {
  let sys = systemText(params.system);
  if (schema) {
    sys += `${sys ? "\n\n" : ""}Answer with ONLY one JSON object (no prose, no code fences) that validates against this JSON Schema:\n${JSON.stringify(schema)}`;
  }
  const out: ChatMessage[] = sys ? [{ role: "system", content: sys }] : [];
  for (const m of params.messages ?? []) out.push({ role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", content: toChatContent(m.content) });
  return out;
}

const stripFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

/** Injectable for tests. */
export let qwenFetch: typeof fetch = (...a) => fetch(...a);
export const setQwenFetch = (f: typeof fetch) => (qwenFetch = f);

/**
 * `schema`: JSON Schema of the wanted answer (or true for any JSON object). A local model (Ollama)
 * gets it as a grammar (json_schema response format), so it can only write a valid object: small
 * models otherwise drift, loop ("token repeat limit") or stop mid-object.
 */
type ChatResult = { text: string; inTok: number; outTok: number; finish: string };

/** Ollama native message: plain text + base64 images (URL images are downloaded). */
async function toOllamaMessages(messages: ChatMessage[]): Promise<{ role: string; content: string; images?: string[] }[]> {
  const out: { role: string; content: string; images?: string[] }[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text: string[] = [];
    const images: string[] = [];
    for (const p of m.content) {
      if (p.type === "text") text.push(p.text);
      else {
        const url = p.image_url.url;
        if (url.startsWith("data:")) images.push(url.slice(url.indexOf(",") + 1));
        else {
          const r = await fetch(url, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
          if (r?.ok) images.push(Buffer.from(await r.arrayBuffer()).toString("base64"));
        }
      }
    }
    out.push({ role: m.role, content: text.join("\n\n"), ...(images.length ? { images } : {}) });
  }
  return out;
}

/**
 * A GPU that faults (NVIDIA Xid 13 "Graphics Exception") makes llama.cpp produce garbage: "@@@@",
 * "token repeat limit", "empty grammar stack ... @", CUDA errors. The same request on the CPU is fine.
 */
export const looksLikeGpuFault = (textOrError: string) => /@{6,}|repeat limit|grammar stack|CUDA|illegal memory|llama-server process has terminated|unspecified launch failure/i.test(textOrError);

/**
 * GPU faults in this process (auto mode). A faulting GPU often recovers for a while once Ollama
 * restarts its runner, and it is ~5x faster than the CPU, so it is tried again until it has faulted
 * QWEN_GPU_MAX_FAULTS times (default 2); after that every call goes straight to the CPU.
 */
let gpuFaults = 0;
/** Tests: forget earlier GPU faults of this process. */
export const resetGpuFaults = () => (gpuFaults = 0);
const gpuGivenUp = () => gpuFaults >= Math.max(1, Number(env("QWEN_GPU_MAX_FAULTS", "2")) || 2);

/** Rough prompt size: ~3.5 characters per token for text, ~1200 tokens per image (Qwen2.5-VL, 720p-ish). */
export function estimateTokens(messages: ChatMessage[]): number {
  let chars = 0;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else for (const p of m.content) p.type === "text" ? (chars += p.text.length) : images++;
    chars += 16; // role / template tokens
  }
  return Math.ceil(chars / 3.5) + images * 1200;
}

/** Tokens kept for the answer: what the caller asked, at most 30% of the context (and 8192). */
export const answerTokens = (maxTokens: number, numCtx: number) => Math.max(256, Math.min(maxTokens || 4096, 8192, Math.floor(numCtx * 0.3)));

/** An answer with nothing usable in it: empty, one symbol, or a run of "@" (truncated / faulting model). */
export const looksEmpty = (text: string) => /^\W{0,2}$/.test(text.trim());

type OllamaResult = ChatResult & { loadNs?: number; totalNs?: number };

async function ollamaChat(messages: ChatMessage[], model: string, maxTokens: number, json: boolean, cpu: boolean, numCtx: number): Promise<OllamaResult> {
  const s = loadLlmSettings();
  const base = s.qwen.baseUrl.replace(/\/v1\/?$/, "");
  const res = await qwenFetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: await toOllamaMessages(messages),
      stream: false,
      // Thinking models (qwen3, deepseek-r1): thinking off for JSON steps unless THINK=on; any
      // <think> block that still comes back is stripped below.
      ...(/qwen3|deepseek-r1/i.test(model) ? { think: env("THINK", "off").toLowerCase() === "on" } : {}),
      ...(json ? { format: "json" } : {}),
      // num_ctx on every request: without it Ollama uses 4096 and silently cuts longer prompts.
      options: { temperature: 0.2, num_ctx: numCtx, num_predict: answerTokens(maxTokens, numCtx), ...(cpu ? { num_gpu: 0 } : {}) },
    }),
    signal: AbortSignal.timeout(Number(env("QWEN_TIMEOUT_MS", "240000")) * (cpu ? 3 : 1)),
  }).catch((err: Error) => {
    throw apiError(503, `Qwen not reachable at ${base}: ${err.message} (is Ollama running? Start "Ollama" from the Start menu, and \`ollama pull ${model}\`)`);
  });
  const body = (await res.json().catch(() => ({}))) as Params;
  debugDump(model + (cpu ? "_cpu" : ""), messages, body);
  if (!res.ok || body.error) {
    const msg = String(body?.error?.message ?? body?.error ?? res.statusText);
    throw apiError(res.ok ? 500 : res.status, `Qwen ${res.ok ? 500 : res.status}: ${msg}`);
  }
  return {
    text: stripThink(String(body.message?.content ?? "")),
    inTok: body.prompt_eval_count ?? 0,
    outTok: body.eval_count ?? 0,
    finish: body.done_reason === "length" ? "length" : body.done ? "stop" : "aborted",
    loadNs: typeof body.load_duration === "number" ? body.load_duration : undefined,
    totalNs: typeof body.total_duration === "number" ? body.total_duration : undefined,
  };
}

/**
 * Smaller context for a GPU retry: half of num_ctx when the prompt + answer still fit (less VRAM, so
 * nothing spills to the CPU), else the smallest 1K step that fits, else the same size.
 */
export function retryCtx(numCtx: number, est: number, maxTokens: number): number {
  const half = Math.max(2048, Math.floor(numCtx / 2));
  if (half < numCtx && est + answerTokens(maxTokens, half) <= half) return half;
  for (let c = 2048; c < numCtx; c += 1024) if (est + answerTokens(maxTokens, c) <= c) return c;
  return numCtx;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * After a GPU fault Ollama restarts its runner, sometimes the whole app, and for a few seconds
 * every request fails with "not reachable". Waits (QWEN_RESTART_WAIT_MS, default 60 s) until it
 * answers again.
 */
async function waitForOllama(): Promise<boolean> {
  const base = loadLlmSettings().qwen.baseUrl.replace(/\/v1\/?$/, "");
  const until = Date.now() + Number(env("QWEN_RESTART_WAIT_MS", "60000"));
  const poll = Number(env("QWEN_RESTART_POLL_MS", "2000"));
  while (Date.now() < until) {
    await sleep(poll);
    try {
      if ((await qwenFetch(`${base}/api/version`, { signal: AbortSignal.timeout(3000) })).ok) return true;
    } catch {
      /* still down */
    }
  }
  return false;
}

/** One request, retried once when Ollama was down and came back. */
async function whenOllamaUp<T>(request: () => Promise<T>): Promise<T> {
  try {
    return await request();
  } catch (err) {
    if (!(err instanceof Anthropic.APIError) || err.status !== 503 || !(await waitForOllama())) throw err;
    return request();
  }
}

/**
 * Local model: GPU first. A garbage / empty answer never goes straight to the CPU:
 *  1. inside splitWhenTooBig with several items: "split it" (422), so the caller halves the request
 *     and runs both halves on the GPU;
 *  2. a single request: one more GPU try with a smaller context (retryCtx) on a fresh runner (the
 *     model is unloaded first; a new load clears a faulted CUDA context);
 *  3. only then the CPU (device "auto"; pictures only with VISION_CPU=on).
 */
async function localChat(messages: ChatMessage[], model: string, maxTokens: number, json: boolean, numCtxIn?: number): Promise<ChatResult> {
  const s = loadLlmSettings();
  const { device } = s.qwen;
  const numCtx = numCtxIn || s.qwen.numCtx || DEFAULT_NUM_CTX;
  const hasImages = messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === "image_url"));
  // Token budget: a prompt that does not fit is refused here (the caller splits it), never sent cut.
  const est = estimateTokens(messages);
  const answer = answerTokens(maxTokens, numCtx);
  const stage = currentStage() ?? (hasImages ? "vision" : "text");
  process.stderr.write(`[llm] ${model} (stage ${stage}): request ~${est} tokens + ${answer} for the answer (num_ctx ${numCtx})\n`);
  if (est + answer > numCtx) throw apiError(413, `prompt ~${est} tokens + ${answer} for the answer exceeds num_ctx ${numCtx}: split the request`);
  const loader = modelLoader(() => s.qwen.baseUrl.replace(/\/v1\/?$/, ""));
  const fallbackModel = hasImages ? s.qwen.visionModel : s.qwen.model;
  if (loader) model = await loader.ensure(model, stage, { fallback: fallbackModel, numCtx, minFreeMb: s.models.minFreeVramMb, oneModel: s.models.oneModelInVram });
  const chat = async (cpu: boolean, ctx = numCtx): Promise<ChatResult> => {
    // The vision model on the CPU needs 30+ minutes per request: a step that checks pictures would
    // stall for hours. It stops instead, and the agent falls back to its rules (VISION_CPU=on allows it).
    if (cpu && hasImages && env("VISION_CPU", "off").toLowerCase() !== "on") {
      throw apiError(500, "the vision model is too slow on the CPU (the GPU is not usable): skipping the picture check (VISION_CPU=on allows it)");
    }
    const t0 = Date.now();
    const r = await whenOllamaUp(() => ollamaChat(messages, model, maxTokens, json, cpu, ctx));
    loader?.record(model, stage, { loadNs: r.loadNs, totalNs: r.totalNs, wallMs: Date.now() - t0, cpu });
    return r;
  };
  if (device === "cpu" || (device === "auto" && gpuGivenUp())) return chat(true);
  /** One GPU attempt: the answer, or what was wrong with it. */
  const gpuTry = async (ctx: number): Promise<{ r?: ChatResult; problem?: string }> => {
    try {
      const r = await chat(false, ctx);
      if (!looksLikeGpuFault(r.text) && !looksEmpty(r.text) && r.finish !== "aborted") return { r };
      return { problem: r.text.slice(0, 80) || "empty answer" };
    } catch (err) {
      if (!(err instanceof Anthropic.APIError) || err.status === 503 || !looksLikeGpuFault(err.message)) throw err;
      return { problem: err.message.slice(0, 120) };
    }
  };
  const first = await gpuTry(numCtx);
  if (first.r) return first.r;
  let problem = first.problem!;
  // 1. Several items in this request: the caller halves it and stays on the GPU.
  if (splitScope.getStore()?.canSplit) {
    process.stderr.write(`[llm] garbage answer on the GPU (${problem}); halving the request, still on the GPU\n`);
    throw apiError(422, `garbage answer (${problem}) to a ~${est}-token request: split it into smaller ones`);
  }
  // 2. One more GPU try: smaller context, fresh runner.
  const ctx2 = retryCtx(numCtx, est, maxTokens);
  process.stderr.write(`[llm] garbage answer on the GPU (${problem}); retrying on the GPU with num_ctx ${ctx2}\n`);
  if (loader) {
    await loader.unload(model);
    await loader.ensure(model, stage, { numCtx: ctx2, oneModel: s.models.oneModelInVram });
  }
  const second = await gpuTry(ctx2);
  if (second.r) return second.r;
  problem = second.problem!;
  if (device === "gpu") throw apiError(500, `Qwen on the GPU returned garbage twice (${problem}) - the GPU is faulting; set Qwen device to Auto or CPU`);
  gpuFaults++;
  process.stderr.write(`[llm] GPU returned garbage twice (${problem}); this request runs on the CPU${gpuGivenUp() ? ", and so does the rest of this step (slower)" : ", the next one tries the GPU again"}\n`);
  return chat(true);
}

function debugDump(model: string, messages: ChatMessage[], body: unknown): void {
  // QWEN_DEBUG_DIR=<folder>: keep every request / answer (troubleshooting a local model).
  const dbg = env("QWEN_DEBUG_DIR", "");
  if (!dbg) return;
  fs.mkdirSync(dbg, { recursive: true });
  fs.writeFileSync(path.join(dbg, `${Date.now()}_${model.replace(/[^\w.-]/g, "_")}.json`), JSON.stringify({ model, messages, response: body }, null, 1));
}

async function qwenChat(messages: ChatMessage[], model: string, maxTokens: number, schema: unknown, numCtx?: number): Promise<ChatResult> {
  const s = loadLlmSettings();
  // Local (Ollama): native API, so each request can pick GPU or CPU. The schema is in the prompt.
  if (s.qwen.mode === "local") return localChat(messages, model, maxTokens, !!schema, numCtx);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (s.qwen.mode === "cloud") headers.Authorization = `Bearer ${qwenKey()}`;
  const res = await qwenFetch(`${s.qwen.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, max_tokens: Math.min(maxTokens || 4096, 8192), temperature: 0.2, ...(schema ? { response_format: responseFormat(schema, s.qwen.mode) } : {}) }),
    signal: AbortSignal.timeout(Number(env("QWEN_TIMEOUT_MS", "240000"))),
  }).catch((err: Error) => {
    throw apiError(503, `Qwen not reachable at ${s.qwen.baseUrl}: ${err.message}${s.qwen.mode === "local" ? " (is Ollama running? `ollama serve`, and `ollama pull " + model + "`)" : ""}`);
  });
  const body = (await res.json().catch(() => ({}))) as Params;
  if (!res.ok) {
    const msg = String(body?.error?.message ?? body?.message ?? res.statusText);
    throw apiError(res.status, `Qwen ${res.status}: ${msg}`);
  }
  const choice = body.choices?.[0] ?? {};
  debugDump(model, messages, body);
  return { text: String(choice.message?.content ?? ""), inTok: body.usage?.prompt_tokens ?? 0, outTok: body.usage?.completion_tokens ?? 0, finish: String(choice.finish_reason ?? "stop") };
}

/**
 * The Anthropic SDK rewrites a zod schema for Claude: constraints Claude's structured outputs do not
 * take (enum on a string, min / max) move into the description as text, e.g.
 * `"description": "{enum: [\"stock\",\"product\"]}"`. A grammar-constrained local model needs them
 * back as real keywords, or it writes values like "none" that then fail validation.
 */
export function restoreConstraints(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(restoreConstraints);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k] = k === "description" ? v : restoreConstraints(v);
  const d = typeof out.description === "string" ? out.description.trim() : "";
  if (d.startsWith("{") && d.endsWith("}")) {
    const keep: Record<string, unknown> = {};
    for (const m of d.slice(1, -1).matchAll(/(\$?\w+):\s*(\[[^\]]*\]|"[^"]*"|-?[\d.]+(?:e[+-]?\d+)?|true|false)/g)) {
      try {
        keep[m[1]] = JSON.parse(m[2]);
      } catch {}
    }
    if (Array.isArray(keep.enum)) out.enum = keep.enum;
    for (const k of ["minItems", "maxItems", "minLength", "maxLength"] as const) if (typeof keep[k] === "number") out[k] = keep[k];
    for (const k of ["minimum", "maximum"] as const) if (typeof keep[k] === "number" && Math.abs(keep[k] as number) < 1e15) out[k] = keep[k];
    delete out.description;
  }
  return out;
}

const responseFormat = (_schema: unknown, _mode: "cloud" | "local") => ({ type: "json_object" });

async function callQwen(kind: Kind, params: Params): Promise<unknown> {
  const s = loadLlmSettings();
  const need = needsOf(params);
  if (need.tools) throw apiError(400, "Qwen cannot run this step (it uses Claude's web search tool)");
  // Local: the current stage's model + context (llm_settings.json "stages"); cloud: qwen settings.
  const local = s.qwen.mode === "local" ? stageModel(currentStage(), need.vision, s) : null;
  const model = local?.model ?? (need.vision ? s.qwen.visionModel : s.qwen.model);
  const format = params.output_config?.format as { schema?: unknown; parse?: (t: string) => unknown } | undefined;
  const wantJson = !!format?.schema;
  const messages = toChatMessages(params, wantJson ? restoreConstraints(format!.schema) : undefined);
  const schema = wantJson ? restoreConstraints(format!.schema) : false;
  let r = await qwenChat(messages, model, params.max_tokens, schema, local?.numCtx);
  let inTok = r.inTok;
  let outTok = r.outTok;
  let parsed: unknown = null;
  if (kind === "parse" && format?.parse) {
    try {
      parsed = format.parse(stripFences(r.text));
    } catch (err) {
      // One repair round: show the model its answer and the validation error.
      const retry: ChatMessage[] = [...messages, { role: "assistant", content: r.text }, { role: "user", content: `That answer is not valid: ${String((err as Error).message).slice(0, 800)}\nReply with only the corrected JSON object.` }];
      r = await qwenChat(retry, model, params.max_tokens, schema || true, local?.numCtx);
      inTok += r.inTok;
      outTok += r.outTok;
      try {
        parsed = format.parse(stripFences(r.text));
      } catch (err2) {
        recordUsage("qwen", model, inTok, outTok, (inTok * s.qwen.priceIn + outTok * s.qwen.priceOut) / 1e6);
        throw apiError(422, `Qwen answer did not match the expected format: ${String((err2 as Error).message).slice(0, 300)}`);
      }
    }
  }
  recordUsage("qwen", model, inTok, outTok, (inTok * s.qwen.priceIn + outTok * s.qwen.priceOut) / 1e6);
  const text = wantJson ? stripFences(r.text) : r.text;
  return {
    id: `qwen_${Date.now().toString(36)}`,
    type: "message",
    role: "assistant",
    model,
    provider: "qwen",
    content: [{ type: "text", text, ...(kind === "parse" ? { parsed_output: parsed } : {}) }],
    ...(kind === "parse" ? { parsed_output: parsed } : {}),
    stop_reason: r.finish === "length" ? "max_tokens" : "end_turn",
    stop_details: null,
    usage: { input_tokens: inTok, output_tokens: outTok },
  };
}

// ---------------------------------------------------------------------------------------------

async function route(kind: Kind, beta: boolean, params: Params): Promise<unknown> {
  const stage = currentStage();
  const order = providerOrder(undefined, undefined, stage);
  if (!order.length) throw apiError(503, "no AI model is available (Settings -> AI model: all off, out of budget or missing keys)");
  const need = needsOf(params);
  let lastErr: unknown = null;
  for (const p of order) {
    if (p === "qwen" && need.tools) continue;
    try {
      // A stage may name its own Claude model (hybrid: the script on Sonnet, whatever LLM_MODEL says).
      const cm = stage ? (loadLlmSettings().stages as Record<string, { claudeModel?: string } | undefined>)[stage]?.claudeModel : undefined;
      return p === "claude" ? await callClaude(kind, beta, cm ? { ...params, model: cm } : params) : await callQwen(kind, params);
    } catch (err) {
      lastErr = err;
      if (isCreditError(err)) {
        disableProvider(p, `out of credit (${String((err as Error).message).slice(0, 120)})`);
        continue;
      }
      if (err instanceof Anthropic.AuthenticationError || (err instanceof Anthropic.APIError && (err.status === 401 || err.status === 403))) {
        disableProvider(p, `key rejected (${String((err as Error).message).slice(0, 120)})`);
        continue;
      }
      // Qwen not reachable (Ollama stopped / network): try the next provider, but do not disable.
      if (p === "qwen" && err instanceof Anthropic.APIError && err.status === 503) continue;
      throw err;
    }
  }
  throw lastErr instanceof Anthropic.APIError ? lastErr : apiError(503, `no AI model could serve this request: ${String((lastErr as Error)?.message ?? "unsupported by the available models")}`);
}

/**
 * Drop-in for `new Anthropic(...)` in the agents: only `messages.parse/create` and
 * `beta.messages.parse/create` are implemented (the methods the pipeline uses).
 */
export function llm(): Anthropic {
  const make = (beta: boolean) => ({ parse: (p: Params) => route("parse", beta, p), create: (p: Params) => route("create", beta, p) });
  return { messages: make(false), beta: { messages: make(true) } } as unknown as Anthropic;
}

/**
 * "Test" button: one tiny request straight to that provider (ignores the order / budget), so the
 * user sees whether the key, model and endpoint answer. Costs a few tokens.
 */
export async function testProvider(p: ProviderName): Promise<{ ok: boolean; model: string; ms: number; reply?: string; error?: string }> {
  const t0 = Date.now();
  const s = loadLlmSettings();
  const model = p === "claude" ? env("LLM_MODEL", "claude-haiku-4-5") : s.qwen.model;
  try {
    const res = (p === "claude"
      ? await callClaude("create", false, { model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }] })
      : await callQwen("create", { model, max_tokens: 16, messages: [{ role: "user", content: "Reply with the single word OK." }] })) as { content: { type: string; text?: string }[] };
    const reply = res.content.find((b) => b.type === "text")?.text?.trim().slice(0, 40);
    return { ok: true, model, ms: Date.now() - t0, reply };
  } catch (err) {
    if (isCreditError(err)) disableProvider(p, `out of credit (${String((err as Error).message).slice(0, 120)})`);
    return { ok: false, model, ms: Date.now() - t0, error: String((err as Error).message ?? err).slice(0, 300) };
  }
}

/** Removes <think>...</think> reasoning blocks (qwen3 / deepseek-r1) from an answer. */
export const stripThink = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();
