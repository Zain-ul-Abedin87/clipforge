import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GenAIClient, genAIClient } from "../videogen/sdk.js";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env } from "../env.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";
import { withStage } from "../models/loader.js";
import { paths } from "../paths.js";
import { readJson, writeJson } from "../project.js";
import { loadFeatures } from "../settings/features.js";
import { geminiKey } from "../videogen/providers.js";
import { comfyFetch, isFlux, modelLicense } from "./imagegen.js";
import { writeLicenseSidecar } from "./stock/license.js";
import type { Assets } from "./types.js";
import type { Scene } from "../scenes.js";
import { writeLedger } from "./licenseLedger.js";
import { writeLicenseLog } from "./review.js";
import { CardStyle, renderGraphic } from "./graphics.js";
import { loadStyle } from "../style.js";

/**
 * "AI image style": every footage scene becomes an AI picture in ONE fixed look (the format of
 * history / story / explainer channels). Consistency comes from code, not from the model's mood:
 *  - the channel's style (channels/<ch>/ai_style/style.json): a look, things to avoid, up to 5
 *    reference pictures, up to 4 characters with a fixed description (and their own picture);
 *  - the AI only writes WHAT each scene shows; the look, the avoid-list and every named character's
 *    description are added to every prompt by code, word for word;
 *  - engines: ComfyUI on this PC (free; reference pictures through IP-Adapter, node names from
 *    cubiq/ComfyUI_IPAdapter_plus: IPAdapterUnifiedLoader + IPAdapter, weight_type "style transfer")
 *    or the Gemini API (paid; the reference pictures go with every request).
 * Pictures are cached by prompt + style, logged as AI-generated in the licence ledger, and QA asks
 * for YouTube's synthetic-content label.
 */

export interface Character {
  name: string;
  /** Other words the narration uses for them ("the captain"). */
  aliases?: string[];
  /** Fixed visual description, added whenever they are in a scene. */
  look: string;
  /** Their reference picture (file name in the style folder). */
  ref?: string;
}

export interface AiStyle {
  name: string;
  /** The look, added to every prompt ("oil painting, warm candle light, visible brush strokes"). */
  look: string;
  /** Never in the pictures. */
  avoid: string;
  /** Reference pictures (file names in the style folder), at most 5. */
  refs: string[];
  characters: Character[];
}

export const STYLE_PRESETS: AiStyle[] = [
  { name: "Cinematic realistic", look: "photorealistic cinematic still, dramatic natural light, shallow depth of field, film grain", avoid: "text, letters, watermark, logo, extra fingers, deformed hands", refs: [], characters: [] },
  { name: "Oil painting (history)", look: "classical oil painting, rich warm colours, visible brush strokes, dramatic chiaroscuro lighting", avoid: "text, letters, watermark, modern objects, photo", refs: [], characters: [] },
  { name: "Dark documentary", look: "moody desaturated illustration, low-key lighting, fog, high contrast, cinematic composition", avoid: "text, letters, watermark, bright cartoon colours", refs: [], characters: [] },
  { name: "Flat 2D cartoon", look: "flat 2D vector cartoon, bold clean outlines, simple shapes, bright limited palette, plain background", avoid: "text, letters, watermark, photo, realistic skin, 3D render", refs: [], characters: [] },
  { name: "Pencil sketch", look: "detailed pencil sketch on cream paper, cross-hatching, graphite shading", avoid: "text, letters, watermark, colour, photo", refs: [], characters: [] },
  { name: "3D render", look: "stylised 3D render, soft global illumination, clay-like materials, studio lighting", avoid: "text, letters, watermark, photo, flat 2D", refs: [], characters: [] },
];

export const styleDir = (channel: string) => path.join(paths.channels, channel, "ai_style");
const styleFile = (channel: string) => path.join(styleDir(channel), "style.json");
const safeFile = (n: string) => path.basename(n).replace(/[^A-Za-z0-9._-]+/g, "_").slice(-80);

export function loadAiStyle(channel: string): AiStyle {
  const f = styleFile(channel);
  return fs.existsSync(f) ? cleanStyle(readJson<AiStyle>(f), channel) : { ...STYLE_PRESETS[0] };
}

/** Validated: short texts, existing reference files only, at most 5 refs and 4 characters. */
export function cleanStyle(s: Partial<AiStyle>, channel: string): AiStyle {
  const dir = styleDir(channel);
  const exists = (f?: string) => !!f && fs.existsSync(path.join(dir, safeFile(f)));
  const txt = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
  return {
    name: txt(s.name, 60) || "My style",
    look: txt(s.look, 400),
    avoid: txt(s.avoid, 300),
    refs: (s.refs ?? []).map(safeFile).filter((f) => exists(f)).slice(0, 5),
    characters: (s.characters ?? [])
      .map((c) => ({ name: txt(c.name, 40), aliases: (c.aliases ?? []).map((a) => txt(a, 40)).filter(Boolean).slice(0, 5), look: txt(c.look, 300), ...(exists(c.ref) ? { ref: safeFile(c.ref!) } : {}) }))
      .filter((c) => c.name && c.look)
      .slice(0, 4),
  };
}

export function saveAiStyle(channel: string, s: Partial<AiStyle>): AiStyle {
  const clean = cleanStyle(s, channel);
  if (!clean.look) throw new Error("Describe the look (or pick a preset).");
  fs.mkdirSync(styleDir(channel), { recursive: true });
  writeJson(styleFile(channel), clean);
  return clean;
}

/** Characters named in a scene (name or alias, whole words, any case). */
export function charactersIn(text: string, chars: Character[]): Character[] {
  const t = ` ${text.toLowerCase()} `;
  return chars.filter((c) => [c.name, ...(c.aliases ?? [])].some((n) => n && new RegExp(`[^\\p{L}\\p{N}]${n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\p{L}\\p{N}]`, "u").test(t)));
}

/** The final prompt: the AI's scene description + every character's fixed look + the style, by code. */
export function composePrompt(scene: string, style: AiStyle, chars: Character[]): string {
  const who = chars.map((c) => `${c.name}: ${c.look}`).join("; ");
  return [scene.replace(/\s+/g, " ").trim().replace(/\.$/, ""), who && `Characters: ${who}`, style.look && `Style: ${style.look}`, "16:9 composition, no text, no captions, no watermark"].filter(Boolean).join(". ") + ".";
}

export type Ask = (system: string, user: string) => Promise<{ scenes: { id: number; shows: string }[] }>;
const Shows = z.object({ scenes: z.array(z.object({ id: z.number().int(), shows: z.string() })) });
const modelAsk: Ask = async (system, user) => {
  const res = await withStage("assets", () =>
    llm().messages.parse({ model: env("LLM_MODEL", "claude-haiku-4-5"), max_tokens: 4000, output_config: { format: zodOutputFormat(Shows) }, system, messages: [{ role: "user", content: user }] }),
  );
  return res.parsed_output ?? { scenes: [] };
};

export const SHOWS_RULES = [
  "You plan the pictures of a narrated video: one picture per scene.",
  "For each scene write what the picture SHOWS in one sentence: the subject, what happens, the place and era, the camera (wide shot, close-up, aerial ...).",
  "Show the moment the narration describes, concretely. No text, signs, captions or logos in the picture.",
  "When a named character is in the scene, use their name; their look is added for you, do not describe it.",
  "Do not show real, living people's faces; show places, objects, crowds, hands, silhouettes instead.",
  "Do not write the art style: it is added for you. Every scene gets a different picture.",
].join("\n");

/** One "shows" sentence per scene: the AI in batches of 25, else the narration's own words. */
export async function writeShows(scenes: { id: number; text: string }[], style: AiStyle, o: { ask?: Ask | null; log?: (m: string) => void } = {}): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ask = o.ask === null ? null : o.ask ?? (llmAvailable() ? modelAsk : null);
  for (let i = 0; ask && i < scenes.length; i += 25) {
    const part = scenes.slice(i, i + 25);
    try {
      const r = await ask(SHOWS_RULES, `Characters: ${style.characters.map((c) => c.name).join(", ") || "none"}\nScenes:\n${part.map((s) => `${s.id}: ${s.text}`).join("\n")}`);
      for (const x of r.scenes) if (part.some((s) => s.id === x.id) && x.shows.trim()) out.set(x.id, x.shows.trim());
    } catch (err) {
      o.log?.(`[aistyle] scene descriptions failed for scenes ${part[0].id}-${part[part.length - 1].id}: ${String((err as Error).message).slice(0, 120)}`);
    }
  }
  // No AI (or a scene it skipped): the narration itself describes the picture.
  for (const s of scenes) if (!out.has(s.id)) out.set(s.id, `A scene showing: ${s.text.replace(/\s+/g, " ").slice(0, 200)}`);
  return out;
}

// ---------------------------------------------------------------------------------------------- engines

export interface Gen {
  file: string;
  engine: string;
  model: string;
}

export type Generator = (prompt: string, o: { refs: string[]; seed: number; outFile: string; avoid: string }) => Promise<Gen>;

/** ComfyUI API workflow: SDXL (+ IP-Adapter "style transfer" from the first reference) or Flux. */
export function comfyWorkflow(prompt: string, avoid: string, ckpt: string, seed: number, refUploaded: string | null, o: { preset: string; weight: number }): Record<string, unknown> {
  const w = 1344;
  const h = 768;
  // Flux (GGUF): no IP-Adapter in this pack for it; the style text carries the look.
  if (isFlux(ckpt)) {
    return {
      "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: ckpt } },
      "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: "t5xxl_fp8_e4m3fn.safetensors", clip_name2: "clip_l.safetensors", type: "flux" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
      "4": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["2", 0] } },
      "5": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
      "6": { class_type: "EmptyLatentImage", inputs: { width: w, height: h, batch_size: 1 } },
      "7": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["4", 0], negative: ["5", 0], latent_image: ["6", 0], seed, steps: 4, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1 } },
      "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
      "9": { class_type: "SaveImage", inputs: { images: ["8", 0], filename_prefix: "clipforge_style" } },
    };
  }
  // SDXL: the avoid-list as the negative prompt; IP-Adapter only when a reference picture is given.
  const nodes: Record<string, unknown> = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: ckpt } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: avoid, clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: w, height: h, batch_size: 1 } },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "clipforge_style" } },
  };
  let model: [string, number] = ["1", 0];
  if (refUploaded) {
    nodes["10"] = { class_type: "LoadImage", inputs: { image: refUploaded } };
    nodes["11"] = { class_type: "IPAdapterUnifiedLoader", inputs: { model: ["1", 0], preset: o.preset } };
    nodes["12"] = { class_type: "IPAdapter", inputs: { model: ["11", 0], ipadapter: ["11", 1], image: ["10", 0], weight: o.weight, start_at: 0, end_at: 1, weight_type: "style transfer" } };
    model = ["12", 0];
  }
  nodes["5"] = { class_type: "KSampler", inputs: { model, positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0], seed, steps: refUploaded ? 8 : 4, cfg: refUploaded ? 2 : 1, sampler_name: "euler_ancestral", scheduler: "normal", denoise: 1 } };
  return nodes;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function comfyGenerator(o: { url: string; ckpt: string; ipadapter: boolean; preset: string; weight: number; fetchImpl?: typeof fetch; pollMs?: number }): Generator {
  const base = o.url.replace(/\/+$/, "");
  const raw = o.fetchImpl ?? comfyFetch;
  // A refused connection means ComfyUI is not running: say so instead of "fetch failed".
  const f: typeof fetch = async (...a) => {
    try {
      return await raw(...a);
    } catch (err) {
      throw new Error(`ComfyUI is not running at ${base} (${(err as Error).message}). Start ComfyUI, or choose "Gemini API" under Made by.`);
    }
  };
  const uploaded = new Map<string, string>();
  const upload = async (file: string): Promise<string> => {
    if (uploaded.has(file)) return uploaded.get(file)!;
    const form = new FormData();
    form.append("image", new Blob([fs.readFileSync(file)]), `clipforge_ref_${safeFile(file)}`);
    form.append("overwrite", "true");
    const r = await f(`${base}/upload/image`, { method: "POST", body: form });
    if (!r.ok) throw new Error(`ComfyUI upload ${r.status}`);
    const j = (await r.json().catch(() => ({}))) as { name?: string };
    const name = j.name ?? `clipforge_ref_${safeFile(file)}`;
    uploaded.set(file, name);
    return name;
  };
  return async (prompt, g) => {
    const ref = o.ipadapter && !isFlux(o.ckpt) && g.refs.length ? await upload(g.refs[0]) : null;
    const res = await f(`${base}/prompt`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: comfyWorkflow(prompt, g.avoid, o.ckpt, g.seed, ref, { preset: o.preset, weight: o.weight }), client_id: "clipforge" }) });
    if (!res.ok) throw new Error(`ComfyUI ${res.status}: ${(await res.text()).slice(0, 200)} (is ComfyUI running at ${base}${ref ? ", with the IPAdapter_plus nodes and models" : ""}?)`);
    const { prompt_id } = (await res.json()) as { prompt_id: string };
    const until = Date.now() + 300_000;
    while (Date.now() < until) {
      await sleep(o.pollMs ?? 1000);
      const h = (await (await f(`${base}/history/${prompt_id}`)).json()) as Record<string, { outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }> }>;
      const img = Object.values(h[prompt_id]?.outputs ?? {}).flatMap((x) => x.images ?? [])[0];
      if (!img) continue;
      const view = await f(`${base}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder)}&type=${encodeURIComponent(img.type)}`);
      fs.writeFileSync(g.outFile, Buffer.from(await view.arrayBuffer()));
      return { file: g.outFile, engine: "comfyui", model: o.ckpt };
    }
    throw new Error("ComfyUI did not finish within 5 minutes");
  };
}

/** Gemini image model: the reference pictures go with the prompt (that is what keeps the look). */
export function geminiGenerator(o: { model: string; client?: Pick<GenAIClient, "models"> }): Generator {
  return async (prompt, g) => {
    const key = geminiKey();
    if (!o.client && !key) throw new Error("GEMINI_API_KEY is not set in .env");
    const ai = o.client ?? (await genAIClient(key!));
    const parts = [
      ...g.refs.slice(0, 5).map((f) => ({ inlineData: { data: fs.readFileSync(f).toString("base64"), mimeType: /\.png$/i.test(f) ? "image/png" : /\.webp$/i.test(f) ? "image/webp" : "image/jpeg" } })),
      { text: `${g.refs.length ? "Use the attached pictures as the reference for the art style and the characters. " : ""}Make one 16:9 picture: ${prompt} Avoid: ${g.avoid}.` },
    ];
    const r = await ai.models.generateContent({ model: o.model, contents: [{ role: "user", parts }] });
    const img = r.candidates?.[0]?.content?.parts?.find((p: { inlineData?: { data?: string } }) => p.inlineData?.data)?.inlineData;
    if (!img?.data) throw new Error("Gemini returned no picture (it may have been blocked by its safety filter: change the scene)");
    fs.writeFileSync(g.outFile, Buffer.from(img.data, "base64"));
    return { file: g.outFile, engine: "gemini", model: o.model };
  };
}

// ---------------------------------------------------------------------------------------------- the step

export interface AiStyleReport {
  style: string;
  engine: string;
  scenes: number;
  made: number;
  reused: number;
  failed: { id: number; error: string }[];
}

/** Every footage scene of scenes.json -> one picture in the channel's style -> assets.json. */
/** Card scenes keep their card (the same renderer and channel colours as the assets step). */
async function channelCard(scene: Scene, channel: string, dir: string): Promise<string> {
  const st = loadStyle(channel) as Record<string, unknown>;
  const colors = (st.colors ?? {}) as Record<string, string>;
  const fonts = (st.fonts ?? {}) as Record<string, string>;
  const cs: CardStyle = { primary: colors.primary ?? "#E8A317", secondary: colors.secondary ?? "#1C1C1C", text: colors.text ?? "#FFFFFF", accent: colors.accent ?? "#C0392B", titleFont: fonts.title, bodyFont: fonts.body };
  return renderGraphic(scene.graphic!, cs, path.join(dir, "graphics"));
}

export async function runAiStyle(dir: string, o: { channel: string; ask?: Ask | null; generator?: Generator; card?: (scene: Scene) => Promise<string>; log?: (m: string) => void }): Promise<AiStyleReport> {
  const log = o.log ?? console.log;
  const cfg = loadFeatures().aistyle;
  const style = loadAiStyle(o.channel);
  const scenes = readJson<Scene[]>(path.join(dir, "scenes.json"));
  // A card scene with a card spec stays a card; everything else becomes a picture.
  const cards = scenes.filter((s) => s.type === "graphic" && s.graphic);
  const footage = scenes.filter((s) => !(s.type === "graphic" && s.graphic)).slice(0, cfg.maxImages);
  const sd = styleDir(o.channel);
  const shows = await writeShows(footage.map((s) => ({ id: s.id, text: s.text })), style, { ask: o.ask, log });
  const gen = o.generator ?? (cfg.engine === "gemini" ? geminiGenerator({ model: cfg.geminiModel }) : comfyGenerator({ url: loadFeatures().stock.comfyUrl, ckpt: loadFeatures().stock.comfyCheckpoint, ipadapter: cfg.ipadapter, preset: cfg.ipadapterPreset, weight: cfg.refWeight }));
  const engine = cfg.engine === "gemini" ? `Gemini ${cfg.geminiModel}` : `ComfyUI ${loadFeatures().stock.comfyCheckpoint}`;
  const outDir = path.join(dir, "ai_images");
  fs.mkdirSync(outDir, { recursive: true });
  const assetsFile = path.join(dir, "assets.json");
  const assets: Assets = fs.existsSync(assetsFile) ? readJson<Assets>(assetsFile) : {};
  const prompts: { id: number; text: string; prompt: string; file?: string }[] = [];
  const rep: AiStyleReport = { style: style.name, engine, scenes: footage.length, made: 0, reused: 0, failed: [] };
  const styleHash = crypto.createHash("sha1").update(JSON.stringify({ style, engine })).digest("hex").slice(0, 8);
  for (const s of footage) {
    const chars = charactersIn(s.text, style.characters);
    const prompt = composePrompt(shows.get(s.id)!, style, chars);
    const key = crypto.createHash("sha1").update(`${styleHash}|${prompt}`).digest("hex").slice(0, 16);
    const outFile = path.join(outDir, `scene_${s.id}_${key}.png`);
    // A character's own picture comes first, so it steers that scene most.
    const refs = [...chars.map((c) => c.ref).filter((r): r is string => !!r), ...style.refs].map((r) => path.join(sd, r)).filter((f) => fs.existsSync(f));
    try {
      if (fs.existsSync(outFile)) rep.reused++;
      else {
        await gen(prompt, { refs, seed: parseInt(key.slice(0, 8), 16), outFile, avoid: style.avoid });
        rep.made++;
        log(`[aistyle] #${s.id} ${chars.length ? `(${chars.map((c) => c.name).join(", ")}) ` : ""}"${prompt.slice(0, 90)}"`);
      }
      const license = `AI-generated picture (${engine}, style "${style.name}")${cfg.engine === "comfyui" ? `; model licence: ${modelLicense(loadFeatures().stock.comfyCheckpoint)}` : "; Google's terms for generated content apply"}`;
      writeLicenseSidecar(outFile, { source: "imagegen", id: key, pageUrl: "", license, attributionRequired: false, fetchedAt: new Date().toISOString(), model: engine, prompt });
      assets[String(s.id)] = { path: outFile, source: "imagegen", license, url: "", kind: "image", query: shows.get(s.id), note: `AI image style "${style.name}"` };
      prompts.push({ id: s.id, text: s.text, prompt, file: path.basename(outFile) });
    } catch (err) {
      rep.failed.push({ id: s.id, error: String((err as Error).message).slice(0, 200) });
      prompts.push({ id: s.id, text: s.text, prompt });
      log(`[aistyle] #${s.id} failed: ${String((err as Error).message).slice(0, 160)}`);
    }
  }
  for (const s of cards) {
    try {
      const file = await (o.card ?? ((x: Scene) => channelCard(x, o.channel, dir)))(s);
      assets[String(s.id)] = { path: file, source: "graphic", license: "Generated by ClipForge (own work)", url: "", kind: "image", width: 1920, height: 1080, query: s.graphic?.kind };
    } catch (err) {
      log(`[aistyle] card #${s.id} failed: ${String((err as Error).message).slice(0, 120)}`);
    }
  }
  // Only scenes with a picture or card go to the logs (a failed one shows in ai_style_plan.json).
  const covered = scenes.filter((s) => assets[String(s.id)]);
  writeJson(assetsFile, assets);
  writeLedger(dir, covered, assets);
  writeLicenseLog(dir, covered, assets);
  writeJson(path.join(dir, "ai_style_plan.json"), { at: new Date().toISOString(), ...rep, prompts });
  log(`[aistyle] style "${style.name}" with ${engine}: ${rep.made} new, ${rep.reused} reused, ${rep.failed.length} failed of ${rep.scenes} scene(s)`);
  if (rep.failed.length === rep.scenes && rep.scenes) throw new Error(`no picture could be made: ${rep.failed[0].error}`);
  return rep;
}

// ---------------------------------------------------------------------------------------------- learn / preview

const Learned = z.object({ look: z.string(), avoid: z.string() });
export type See = (images: { data: string; mime: string }[], instruction: string) => Promise<{ look: string; avoid: string }>;
const modelSee: See = async (images, instruction) => {
  const res = await withStage("vision", () =>
    llm().messages.parse({
      model: env("LLM_MODEL", "claude-haiku-4-5"),
      max_tokens: 600,
      output_config: { format: zodOutputFormat(Learned) },
      messages: [{ role: "user", content: [...images.map((i) => ({ type: "image" as const, source: { type: "base64" as const, media_type: i.mime as "image/png" | "image/jpeg" | "image/webp", data: i.data } })), { type: "text" as const, text: instruction }] }],
    }),
  );
  return res.parsed_output ?? { look: "", avoid: "" };
};

/** The look shared by the reference pictures, as prompt words (what YtHunter calls a style "skill"). */
export async function learnStyle(channel: string, o: { see?: See } = {}): Promise<{ look: string; avoid: string }> {
  const style = loadAiStyle(channel);
  if (!style.refs.length) throw new Error("Add 1 to 5 reference pictures first.");
  const see = o.see ?? (llmAvailable({ vision: true }) ? modelSee : null);
  if (!see) throw new Error("No AI model that can see pictures is set up (a vision model in Ollama, or an API key).");
  const imgs = style.refs.map((r) => {
    const f = path.join(styleDir(channel), r);
    return { data: fs.readFileSync(f).toString("base64"), mime: /\.png$/i.test(f) ? "image/png" : /\.webp$/i.test(f) ? "image/webp" : "image/jpeg" };
  });
  const r = await see(imgs, "These pictures share one visual style. Describe ONLY that style as comma-separated prompt words for an image generator (medium, rendering, colours, light, lines, texture, mood), in under 40 words. Never name an artist, studio, brand or franchise. Then list what the style never has (avoid), e.g. text, photo, 3D. Do not describe the subjects.");
  const clean = (x: string) => x.replace(/\s+/g, " ").replace(/\b(in the style of|by)\s+[A-Z][\w-]+(\s+[A-Z][\w-]+)?/g, "").trim().slice(0, 400);
  return { look: clean(r.look), avoid: clean(r.avoid) || style.avoid };
}

/** One test picture of a scene in the current style (channels/<ch>/ai_style/previews/). */
export async function previewStyle(channel: string, scene: string, o: { generator?: Generator } = {}): Promise<{ file: string; prompt: string }> {
  const cfg = loadFeatures().aistyle;
  const style = loadAiStyle(channel);
  const chars = charactersIn(scene, style.characters);
  const prompt = composePrompt(scene, style, chars);
  const dir = path.join(styleDir(channel), "previews");
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash("sha1").update(`${JSON.stringify(style)}|${cfg.engine}|${prompt}`).digest("hex").slice(0, 12);
  const outFile = path.join(dir, `preview_${key}.png`);
  const gen = o.generator ?? (cfg.engine === "gemini" ? geminiGenerator({ model: cfg.geminiModel }) : comfyGenerator({ url: loadFeatures().stock.comfyUrl, ckpt: loadFeatures().stock.comfyCheckpoint, ipadapter: cfg.ipadapter, preset: cfg.ipadapterPreset, weight: cfg.refWeight }));
  const refs = [...chars.map((c) => c.ref).filter((r): r is string => !!r), ...style.refs].map((r) => path.join(styleDir(channel), r)).filter((f) => fs.existsSync(f));
  if (!fs.existsSync(outFile)) await gen(prompt, { refs, seed: parseInt(key.slice(0, 8), 16), outFile, avoid: style.avoid });
  return { file: path.basename(outFile), prompt };
}

/** A reference picture saved into the style folder (png / jpg / webp). */
export function saveRef(channel: string, name: string, data: Buffer): string {
  if (!/\.(png|jpe?g|webp)$/i.test(name)) throw new Error("A reference must be a PNG, JPG or WebP picture.");
  if (data.length > 15 * 1024 * 1024) throw new Error("The picture is larger than 15 MB.");
  fs.mkdirSync(styleDir(channel), { recursive: true });
  const file = `ref_${Date.now().toString(36)}_${safeFile(name)}`;
  fs.writeFileSync(path.join(styleDir(channel), file), data);
  return file;
}

/** A file of the style folder (refs, previews) for the page, or null. */
export function styleFileOf(channel: string, name: string): string | null {
  const base = path.basename(name);
  for (const f of [path.join(styleDir(channel), base), path.join(styleDir(channel), "previews", base)]) if (base === name && fs.existsSync(f)) return f;
  return null;
}
