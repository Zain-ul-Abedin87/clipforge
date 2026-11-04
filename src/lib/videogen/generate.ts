import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import RunwayML from "@runwayml/sdk";
import { env } from "../env.js";
import { run } from "../exec.js";
import { ffmpegPath } from "../tools.js";
import { geminiKey, modelsOf, pickDuration, VideoProvider } from "./providers.js";

/**
 * Image-to-video for one scene: the reference image (a frame of the clip, or a real product photo)
 * is the FIRST frame, so the product on screen is the real one and the model only adds motion.
 * Writes an .mp4 to `outFile`. Paid providers are only called after the user confirmed in the editor.
 */

export interface GenerateOpts {
  provider: Exclude<VideoProvider, "flow">;
  model: string;
  prompt: string;
  /** JPEG / PNG used as the first frame. */
  image: string;
  /** Length the scene needs (the nearest accepted duration is asked for). */
  seconds: number;
  outFile: string;
  log?: (m: string) => void;
  /** Tests: fake SDK clients and download. */
  veo?: Pick<GoogleGenAI, "models" | "operations" | "files">;
  runway?: Pick<RunwayML, "imageToVideo">;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Give up after this long (default 12 minutes). */
  timeoutMs?: number;
}

const NEGATIVE = "redesigned product, different logo, changed text, extra parts, warped shapes, watermark, subtitles";

/** The reference image as a JPEG of at most 1280 px (Runway takes data URIs up to 5 MB). */
export async function referenceJpeg(image: string): Promise<{ bytes: Buffer; mime: string }> {
  const ff = ffmpegPath();
  if (ff) {
    const tmp = `${image}.ref.jpg`;
    const r = await run(ff, ["-v", "error", "-y", "-i", image, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", tmp], { timeoutMs: 60_000 });
    if (r.code === 0 && fs.existsSync(tmp)) {
      const bytes = fs.readFileSync(tmp);
      fs.rmSync(tmp, { force: true });
      return { bytes, mime: "image/jpeg" };
    }
  }
  return { bytes: fs.readFileSync(image), mime: /\.png$/i.test(image) ? "image/png" : "image/jpeg" };
}

export async function generateClip(o: GenerateOpts): Promise<{ file: string; seconds: number; model: string }> {
  const log = o.log ?? (() => {});
  const spec = modelsOf(o.provider).find((m) => m.id === o.model);
  if (!spec) throw new Error(`unknown ${o.provider} model "${o.model}"`);
  const seconds = pickDuration(spec, o.seconds);
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const deadline = Date.now() + (o.timeoutMs ?? 12 * 60_000);
  const ref = await referenceJpeg(o.image);
  fs.mkdirSync(path.dirname(o.outFile), { recursive: true });
  log(`[videogen] ${spec.label}: ${seconds} s from ${path.basename(o.image)} (paid API call)`);
  const t0 = Date.now();

  if (o.provider === "veo") {
    const key = geminiKey();
    if (!o.veo && !key) throw new Error("GEMINI_API_KEY is not set in .env");
    const ai = o.veo ?? new GoogleGenAI({ apiKey: key });
    let op = await ai.models.generateVideos({
      model: spec.id,
      source: { prompt: o.prompt, image: { imageBytes: ref.bytes.toString("base64"), mimeType: ref.mime } },
      config: { numberOfVideos: 1, aspectRatio: spec.landscape, durationSeconds: seconds, negativePrompt: NEGATIVE },
    });
    while (!op.done) {
      if (Date.now() > deadline) throw new Error("Veo did not finish in time (the job may still finish in Google AI Studio)");
      await sleep(10_000);
      op = await ai.operations.getVideosOperation({ operation: op });
    }
    if (op.error) throw new Error(`Veo: ${JSON.stringify(op.error).slice(0, 300)}`);
    const gen = op.response?.generatedVideos?.[0];
    if (!gen?.video) throw new Error("Veo returned no video (it may have been blocked by its safety filter: change the prompt)");
    if (gen.video.videoBytes) fs.writeFileSync(o.outFile, Buffer.from(gen.video.videoBytes, "base64"));
    else await ai.files.download({ file: gen, downloadPath: o.outFile });
  } else {
    const key = env("RUNWAYML_API_SECRET");
    if (!o.runway && !key) throw new Error("RUNWAYML_API_SECRET is not set in .env");
    const client = o.runway ?? new RunwayML({ apiKey: key });
    const body = {
      model: spec.id,
      promptImage: `data:${ref.mime};base64,${ref.bytes.toString("base64")}`,
      promptText: o.prompt.slice(0, 1000),
      ratio: spec.landscape,
      duration: seconds,
    } as unknown as Parameters<RunwayML["imageToVideo"]["create"]>[0];
    const task = await client.imageToVideo.create(body).waitForTaskOutput({ timeout: Math.max(60_000, deadline - Date.now()) });
    const url = task.output?.[0];
    if (!url) throw new Error("Runway returned no video");
    const res = await (o.fetchImpl ?? fetch)(url);
    if (!res.ok) throw new Error(`downloading the Runway video failed: HTTP ${res.status}`);
    fs.writeFileSync(o.outFile, Buffer.from(await res.arrayBuffer()));
  }
  if (!fs.existsSync(o.outFile) || fs.statSync(o.outFile).size < 1000) throw new Error("the generated video is missing or empty");
  log(`[videogen] ${spec.label}: done in ${((Date.now() - t0) / 1000).toFixed(0)} s -> ${path.basename(o.outFile)}`);
  return { file: o.outFile, seconds, model: spec.id };
}
