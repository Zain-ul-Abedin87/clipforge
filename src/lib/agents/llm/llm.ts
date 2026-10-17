import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { env } from "../../env.js";
import { disableProvider, loadLlmSettings, providerOrder, ProviderName, qwenKey, recordUsage } from "./settings.js";

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
 * ~60 tokens/s, so big batches overflow or time out: they get a quarter of the Claude size.
 */
export function batchSize(claudeSize: number): number {
  const override = Number(env("LLM_BATCH_SCENES", "0"));
  if (override > 0) return override;
  return activeProvider() === "qwen" && loadLlmSettings().qwen.mode === "local" ? Math.max(8, Math.round(claudeSize / 3)) : claudeSize;
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
async function qwenChat(messages: ChatMessage[], model: string, maxTokens: number, schema: unknown): Promise<{ text: string; inTok: number; outTok: number; finish: string }> {
  const s = loadLlmSettings();
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
  // QWEN_DEBUG_DIR=<folder>: keep every request / answer (troubleshooting a local model).
  const dbg = env("QWEN_DEBUG_DIR", "");
  if (dbg) {
    fs.mkdirSync(dbg, { recursive: true });
    fs.writeFileSync(path.join(dbg, `${Date.now()}_${model.replace(/[^\w.-]/g, "_")}.json`), JSON.stringify({ model, messages, response: body }, null, 1));
  }
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

const responseFormat = (schema: unknown, mode: "cloud" | "local") =>
  mode === "local" && schema && typeof schema === "object" ? { type: "json_schema", json_schema: { name: "answer", strict: true, schema } } : { type: "json_object" };

async function callQwen(kind: Kind, params: Params): Promise<unknown> {
  const s = loadLlmSettings();
  const need = needsOf(params);
  if (need.tools) throw apiError(400, "Qwen cannot run this step (it uses Claude's web search tool)");
  const model = need.vision ? s.qwen.visionModel : s.qwen.model;
  const format = params.output_config?.format as { schema?: unknown; parse?: (t: string) => unknown } | undefined;
  const wantJson = !!format?.schema;
  const messages = toChatMessages(params, wantJson ? restoreConstraints(format!.schema) : undefined);
  const schema = wantJson ? restoreConstraints(format!.schema) : false;
  let r = await qwenChat(messages, model, params.max_tokens, schema);
  let inTok = r.inTok;
  let outTok = r.outTok;
  let parsed: unknown = null;
  if (kind === "parse" && format?.parse) {
    try {
      parsed = format.parse(stripFences(r.text));
    } catch (err) {
      // One repair round: show the model its answer and the validation error.
      const retry: ChatMessage[] = [...messages, { role: "assistant", content: r.text }, { role: "user", content: `That answer is not valid: ${String((err as Error).message).slice(0, 800)}\nReply with only the corrected JSON object.` }];
      r = await qwenChat(retry, model, params.max_tokens, schema || true);
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
  const order = providerOrder();
  if (!order.length) throw apiError(503, "no AI model is available (Settings -> AI model: all off, out of budget or missing keys)");
  const need = needsOf(params);
  let lastErr: unknown = null;
  for (const p of order) {
    if (p === "qwen" && need.tools) continue;
    try {
      return p === "claude" ? await callClaude(kind, beta, params) : await callQwen(kind, params);
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
