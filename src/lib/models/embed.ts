import { env } from "../env.js";
import { loadLlmSettings, stageModel } from "../agents/llm/settings.js";
import { modelLoader } from "./loader.js";

/**
 * Text embeddings from a local Ollama model (default nomic-embed-text, stage "embed"), for the
 * originality guard. Returns null when Ollama / the model is not there: callers then use the
 * lexical scores only. Injectable fetch for tests.
 */

export let embedFetch: typeof fetch = (...a) => fetch(...a);
export const setEmbedFetch = (f: typeof fetch) => (embedFetch = f);

export async function embed(texts: string[], log: (m: string) => void = () => {}): Promise<number[][] | null> {
  if (!texts.length) return [];
  if (env("EMBEDDINGS", "on").toLowerCase() === "off") return null;
  const s = loadLlmSettings();
  const base = (s.qwen.mode === "local" ? s.qwen.baseUrl : "http://localhost:11434/v1").replace(/\/v1\/?$/, "");
  let model = stageModel("embed", false, s).model;
  const loader = modelLoader(() => base);
  if (loader) model = await loader.ensure(model, "embed", { oneModel: s.models.oneModelInVram });
  const out: number[][] = [];
  try {
    // nomic-embed-text wants a task prefix; 32 texts per request keeps requests small.
    for (let i = 0; i < texts.length; i += 32) {
      const t0 = Date.now();
      const res = await embedFetch(`${base}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: texts.slice(i, i + 32).map((t) => `clustering: ${t.slice(0, 6000)}`) }),
        signal: AbortSignal.timeout(120_000),
      });
      if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 120)}`);
      const body = (await res.json()) as { embeddings?: number[][]; total_duration?: number; load_duration?: number };
      if (!body.embeddings?.length) throw new Error("no embeddings in the answer");
      out.push(...body.embeddings);
      loader?.record(model, "embed", { loadNs: body.load_duration, totalNs: body.total_duration, wallMs: Date.now() - t0, cpu: false });
    }
    return out;
  } catch (err) {
    log(`[embed] ${model} not available (${String((err as Error).message).slice(0, 120)}); originality uses n-gram / word overlap only (ollama pull ${model})`);
    return null;
  }
}
