import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env, hasKey } from "../env.js";
import { agentModel } from "./footage.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";

/**
 * Vision verify (assets step): for each scene the top CLIP candidates (default 3) are shown to
 * Claude as frames, together with the narration line. Claude answers yes/no per candidate: does it
 * fit? The best-scoring candidate that passes is picked. Results are cached per
 * model + narration + candidate in <project>/vision_verify.json, so re-runs cost nothing.
 * VISION_VERIFY=on|off (default: on when ANTHROPIC_API_KEY is set).
 */

export const visionVerifyEnabled = () => llmAvailable({ vision: true }) && env("VISION_VERIFY", "on").toLowerCase() !== "off";
export const visionTopN = () => Math.max(1, Number(env("VISION_VERIFY_TOP", "3")) || 3);

export interface VerifyItem {
  sceneId: number;
  text: string;
  before: string;
  /** candidate id -> up to 3 frame/thumbnail JPEG paths */
  cands: { id: string; frames: string[] }[];
}

const Schema = z.object({
  scenes: z.array(
    z.object({
      id: z.number().int(),
      candidates: z.array(z.object({ key: z.string(), fits: z.boolean(), reason: z.string() })),
    }),
  ),
});

const SYSTEM = `You are a strict video editor choosing B-roll for a faceless YouTube video. For each scene you get the narration line (plus the line before it for context) and several candidate clips, each shown as 1-3 frames. For every candidate answer fits=true only if the footage visibly suits what the narration says (a generic shot that suits the sentence is fine) AND passes every rule below.
REJECT (fits=false) if ANY frame shows:
- the underside of the product, the product disassembled, opened up, or with exposed internals, blades, wiring, circuit boards or mechanical parts;
- a garage, workshop, repair bench, cluttered tools, a mechanic or repair setting;
- any person pointing at, gesturing toward or explaining next to the product, even if they are not looking at the camera; a talking head, presenter or anyone looking at / speaking to the camera;
- a maintenance action: pouring oil or fluid, opening an engine or case, cleaning, repairing, replacing parts, unboxing mess;
- burned-in text, subtitles, watermarks or logos dominating the frame; a clearly different subject, a wrong meaning of a word, or anything unrelated.
ACCEPT ONLY: clean cinematic in-use action, clean outdoor / lifestyle shots, or professional studio / product b-roll.
When the item asks for a specific product, it must ALSO be that exact product/model (matching brand, model badge, shape, colour and design); a different brand or model or one you cannot identify = fits=false. When unsure = fits=false. reason: max 12 words. Return every scene id and every candidate key you were given.`;

const mime = (f: string) => (/\.png$/i.test(f) ? "image/png" : /\.webp$/i.test(f) ? "image/webp" : "image/jpeg");

/** Returns "sceneId|candId" -> fits. Missing keys = not checked (treat as unknown). */
export async function verifyCandidates(items: VerifyItem[], topic: string, cacheFile: string, log: (m: string) => void): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (!visionVerifyEnabled() || !items.length) return out;
  const model = agentModel();
  const cache: Record<string, { fits: boolean; reason: string }> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  const keyOf = (it: VerifyItem, cid: string) => crypto.createHash("sha1").update(`${model}|v3|${it.text}|${cid}`).digest("hex").slice(0, 20);
  const todo: VerifyItem[] = [];
  for (const it of items) {
    const missing = it.cands.filter((c) => !cache[keyOf(it, c.id)] && c.frames.some((f) => fs.existsSync(f)));
    for (const c of it.cands) if (cache[keyOf(it, c.id)]) out.set(`${it.sceneId}|${c.id}`, cache[keyOf(it, c.id)].fits);
    if (missing.length) todo.push({ ...it, cands: missing });
  }
  if (!todo.length) return out;
  const client = llm();
  const usage = { in: 0, out: 0 };
  let judged = 0;
  for (let i = 0; i < todo.length; i += 4) {
    const batch = todo.slice(i, i + 4);
    const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: `Video topic: ${topic}` }];
    const keyMap = new Map<string, { it: VerifyItem; cid: string }>();
    for (const it of batch) {
      content.push({ type: "text", text: `Scene id ${it.sceneId}. Narration before: "${it.before.slice(-300)}" Narration now: "${it.text}"` });
      it.cands.forEach((c, k) => {
        const key = `${it.sceneId}-${String.fromCharCode(65 + k)}`;
        keyMap.set(key, { it, cid: c.id });
        content.push({ type: "text", text: `Candidate key ${key}:` });
        for (const f of c.frames.filter((x) => fs.existsSync(x)).slice(0, 3))
          content.push({ type: "image", source: { type: "base64", media_type: mime(f), data: fs.readFileSync(f).toString("base64") } });
      });
    }
    try {
      const res = await client.messages.parse({
        model,
        max_tokens: 3000,
        output_config: model.startsWith("claude-haiku") ? { format: zodOutputFormat(Schema) } : { effort: "low", format: zodOutputFormat(Schema) },
        system: SYSTEM,
        messages: [{ role: "user", content }],
      });
      usage.in += res.usage.input_tokens;
      usage.out += res.usage.output_tokens;
      for (const s of res.parsed_output?.scenes ?? [])
        for (const c of s.candidates) {
          const m = keyMap.get(c.key);
          if (!m) continue;
          cache[keyOf(m.it, m.cid)] = { fits: c.fits, reason: c.reason };
          out.set(`${m.it.sceneId}|${m.cid}`, c.fits);
          judged++;
        }
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        log(`[vision] ANTHROPIC_API_KEY rejected; vision verify off for this run`);
        break;
      }
      log(`[vision] batch failed: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
  log(`[vision] verified ${judged} candidate(s) for ${todo.length} scene(s) (${model}, ${usage.in} in / ${usage.out} out tokens)`);
  return out;
}
