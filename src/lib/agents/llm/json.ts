import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { env } from "../../env.js";
import { withStage } from "../../models/loader.js";
import { llm, llmAvailable } from "./llm.js";
import { stageModel, Stage } from "./settings.js";

/**
 * Every model answer that feeds code goes through here: a JSON schema (zod), a validation of the
 * content (ids in range, word limits...), up to 2 retries that tell the model what was wrong, and
 * a deterministic fallback when the model is off, fails, or keeps answering wrong. The prompt is
 * checked against the stage's context (8K by default) before it is sent: callers must chunk long
 * input (map -> reduce), and an oversized prompt goes to the fallback instead of being cut.
 */

/** Rough token count for English text (about 3.5 characters per token; deliberately on the safe side). */
export const approxTokens = (s: string) => Math.ceil(s.length / 3.5);

/** Room for the prompt when `answer` tokens are kept free for the reply (plus a margin for the chat template). */
export const promptBudget = (stage: Stage, answer: number) => stageModel(stage, false).numCtx - answer - 400;

export const fitsContext = (stage: Stage, system: string, user: string, answer: number) => approxTokens(system) + approxTokens(user) <= promptBudget(stage, answer);

/** Splits items into consecutive groups whose rendered text stays under `maxTokens`. */
export function chunkByTokens<T>(items: T[], render: (x: T) => string, maxTokens: number): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let size = 0;
  for (const x of items) {
    const t = approxTokens(render(x)) + 1;
    if (cur.length && size + t > maxTokens) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(x);
    size += t;
  }
  if (cur.length) out.push(cur);
  return out;
}

export interface JsonResult<T> {
  value: T;
  source: "model" | "fallback";
  attempts: number;
  /** Why answers were refused (schema / validation / errors), for the report. */
  problems: string[];
}

/** Test hook: replaces the model call (system, user) -> raw object. */
export type RawAsk = (system: string, user: string, stage: Stage, maxTokens: number) => Promise<unknown>;
let rawAsk: RawAsk | null = null;
export const setJsonAsk = (f: RawAsk | null) => (rawAsk = f);

export async function askJson<S extends z.ZodType>(c: {
  stage: Stage;
  schema: S;
  system: string;
  user: string;
  label: string;
  fallback: () => z.infer<S>;
  /** Content check after the schema: an error message, or null when fine. */
  validate?: (v: z.infer<S>) => string | null;
  maxTokens?: number;
  retries?: number;
  log?: (m: string) => void;
}): Promise<JsonResult<z.infer<S>>> {
  const log = c.log ?? (() => {});
  const maxTokens = c.maxTokens ?? 2000;
  const problems: string[] = [];
  const fallback = (why: string): JsonResult<z.infer<S>> => {
    log(`[${c.label}] ${why}: rule-based result`);
    return { value: c.fallback(), source: "fallback", attempts: problems.length, problems };
  };
  if (!rawAsk && !llmAvailable()) return fallback("no model available");
  if (!fitsContext(c.stage, c.system, c.user, maxTokens)) {
    problems.push(`prompt too big: about ${approxTokens(c.system) + approxTokens(c.user)} tokens for a ${stageModel(c.stage, false).numCtx}-token context`);
    return fallback(problems[0]);
  }
  let user = c.user;
  const tries = 1 + (c.retries ?? 2);
  for (let attempt = 1; attempt <= tries; attempt++) {
    let raw: unknown;
    try {
      raw = rawAsk
        ? await rawAsk(c.system, user, c.stage, maxTokens)
        : (
            await withStage(c.stage, () =>
              llm().messages.parse({ model: env("LLM_MODEL", "claude-haiku-4-5"), max_tokens: maxTokens, output_config: { format: zodOutputFormat(c.schema) }, system: c.system, messages: [{ role: "user", content: user }] }),
            )
          ).parsed_output;
    } catch (err) {
      problems.push(`attempt ${attempt}: ${String((err as Error).message).slice(0, 160)}`);
      continue;
    }
    const parsed = c.schema.safeParse(raw);
    let why = parsed.success ? (c.validate?.(parsed.data) ?? null) : parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    if (parsed.success && !why) return { value: parsed.data, source: "model", attempts: attempt, problems };
    why = why || "invalid answer";
    problems.push(`attempt ${attempt}: ${why}`);
    log(`[${c.label}] answer refused (${why.slice(0, 160)})${attempt < tries ? ", asking again" : ""}`);
    // The retry says what was wrong; the prompt grows by one short line only.
    user = `${c.user}\n\nYour previous answer was refused: ${why.slice(0, 300)}. Answer again with valid JSON that fixes this.`;
  }
  return fallback(`no valid answer after ${tries} attempts`);
}
