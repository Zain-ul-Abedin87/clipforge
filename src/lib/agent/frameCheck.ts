import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { run } from "../exec.js";
import { agentEnabled, agentModel } from "./footage.js";

/**
 * Final-picture check (QA): one frame from the middle of every scene of the rendered video is shown
 * to Claude together with what the narrator says at that moment (plus the sentences before it, so
 * "It weighs ten ounces" is known to be about the gun named earlier). Claude says whether the
 * picture fits. This judges the finished video, independent of how the footage was chosen.
 */

export type Verdict = "fits" | "generic_ok" | "wrong_product" | "wrong_meaning" | "unrelated" | "card";

export interface FrameVerdict {
  id: number;
  verdict: Verdict;
  shows: string;
  reason: string;
}

const Schema = z.object({
  frames: z.array(
    z.object({
      id: z.number().int(),
      verdict: z.enum(["fits", "generic_ok", "wrong_product", "wrong_meaning", "unrelated", "card"]),
      shows: z.string(),
      reason: z.string(),
    }),
  ),
});

const SYSTEM = `You review a finished YouTube video like a strict professional editor. For each frame you get the narration spoken while it is on screen, and the narration just before it (context: which product is being discussed).

Verdicts:
- fits: shows the exact product being discussed, or exactly what the sentence describes.
- generic_ok: a generic shot that suits the sentence and shows no other identifiable product (e.g. ammunition while ammo is discussed, hands at a range, a holster).
- wrong_product: shows a clearly different product/model or a different kind of item than the one discussed (e.g. a rifle while a pocket pistol is discussed, a revolver for a striker pistol, another brand's logo).
- wrong_meaning: matches a word but not its meaning (an oil drum for a gun "barrel", a zodiac sign for the brand "Taurus").
- unrelated: has nothing to do with the sentence.
- card: a text/graphic card (title, price); judge only that it names the right product and price.

"shows": what is visible, max 12 words. "reason": max 20 words. Return every frame id you were given.`;

/** Frames as small JPEGs (one per scene, at the scene's middle). */
async function grab(ff: string, video: string, t: number, out: string): Promise<boolean> {
  if (fs.existsSync(out)) return true;
  const r = await run(ff, ["-v", "error", "-y", "-ss", t.toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=512:-2", "-q:v", "5", out], { timeoutMs: 60_000 });
  return r.code === 0 && fs.existsSync(out);
}

export async function checkFrames(
  ff: string,
  video: string,
  scenes: { id: number; start: number; end: number; text: string }[],
  topic: string,
  outDir: string,
  log: (m: string) => void,
): Promise<FrameVerdict[] | null> {
  if (!agentEnabled()) return null;
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = fs.statSync(video).mtimeMs;
  const cacheFile = path.join(outDir, "frame_check.json");
  const cache: { key: string; verdicts: FrameVerdict[] } | null = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : null;
  const key = crypto.createHash("sha1").update(`${stamp}|${agentModel()}|v1`).digest("hex");
  if (cache?.key === key) return cache.verdicts;
  // New render: frames grabbed from the previous video must not be judged again.
  for (const f of fs.readdirSync(outDir)) if (/^frame_\d+\.jpg$/.test(f)) fs.rmSync(path.join(outDir, f), { force: true });

  const client = new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });
  const model = agentModel();
  const verdicts: FrameVerdict[] = [];
  const usage = { in: 0, out: 0 };
  for (let i = 0; i < scenes.length; i += 8) {
    const batch = scenes.slice(i, i + 8);
    const content: Anthropic.ContentBlockParam[] = [{ type: "text", text: `Video topic: ${topic}` }];
    for (const s of batch) {
      const k = scenes.indexOf(s);
      const before = scenes.slice(Math.max(0, k - 2), k).map((p) => p.text).join(" ");
      const file = path.join(outDir, `frame_${String(s.id).padStart(4, "0")}.jpg`);
      if (!(await grab(ff, video, (s.start + s.end) / 2, file))) continue;
      content.push({ type: "text", text: `Frame id ${s.id}. Narration before: "${before.slice(-400)}" Narration now: "${s.text}"` });
      content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: fs.readFileSync(file).toString("base64") } });
    }
    try {
      const res = await client.messages.parse({
        model,
        max_tokens: 4000,
        output_config: model.startsWith("claude-haiku") ? { format: zodOutputFormat(Schema) } : { effort: "low", format: zodOutputFormat(Schema) },
        system: SYSTEM,
        messages: [{ role: "user", content }],
      });
      usage.in += res.usage.input_tokens;
      usage.out += res.usage.output_tokens;
      verdicts.push(...(res.parsed_output?.frames ?? []).filter((f) => batch.some((b) => b.id === f.id)));
    } catch (err) {
      log(`[qa] frame check batch failed: ${String((err as Error).message ?? err).slice(0, 160)}`);
    }
  }
  log(`[qa] frame check: ${verdicts.length}/${scenes.length} frames judged (${model}, ${usage.in} in / ${usage.out} out tokens)`);
  fs.writeFileSync(cacheFile, JSON.stringify({ key, verdicts }, null, 1));
  return verdicts;
}
