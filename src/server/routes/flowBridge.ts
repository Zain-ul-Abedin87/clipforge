import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { identityText } from "../../domain/product.types.js";
import { toNumber } from "../../domain/rational.math.js";
import { clipEnd, MultiTrackTimeline } from "../../domain/timeline.types.js";
import { run } from "../../lib/exec.js";
import { buildFlowPrompt, FLOW_ANGLES, FlowAngle, GENERATED_SOURCE } from "../../lib/flowPrompt.js";
import { env } from "../../lib/env.js";
import { ffmpegPath, ffprobePath } from "../../lib/tools.js";
import { EditError, EditOp, findClip } from "../state/projectStore.js";
import { readVault } from "../../lib/agents/youtube/ytExtractor.js";

/**
 * Google Flow round trip for one picture of the timeline (semi-automatic, no Flow automation):
 *   1. flowRequest: a reference frame of the clip (JPEG) + a ready prompt for the chosen camera angle;
 *   2. the user generates in Flow (opened in a side window) and downloads the video;
 *   3. the video comes back by drag-and-drop upload or from the Downloads folder, and replaces the
 *      clip's media, marked as AI-generated (QA then asks for YouTube's synthetic-content label).
 * Every file lives in workspace/<project>/flow/.
 */

export const FLOW_URL = "https://labs.google/fx/tools/flow";
const VIDEO_EXT = /\.(mp4|mov|webm|m4v)$/i;
const MAX_UPLOAD = 1024 * 1024 * 1024;

export const flowDir = (projectDir: string) => path.join(projectDir, "flow");
const safeName = (n: string) => path.basename(n).replace(/[^A-Za-z0-9._-]+/g, "_").slice(-100);
const stamp = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);

export interface FlowRequest {
  prompt: string;
  /** File name in the project's flow/ folder (served by GET /api/editor/flow-file). */
  frame: string;
  seconds: number;
  angle: FlowAngle;
  product: string | null;
  flowUrl: string;
}

/** Reference frame + prompt for regenerating `clipId` from a new camera angle. */
export async function flowRequest(tl: MultiTrackTimeline, projectDir: string, clipId: string, angle: FlowAngle, category: string | null, atFrame?: number): Promise<FlowRequest> {
  const { clip } = findClip(tl, clipId);
  if (clip.kind !== "video") throw new EditError("pick a picture (B-roll clip) to regenerate");
  if (!fs.existsSync(clip.media.path)) throw new EditError("the clip's media file is missing");
  const ff = ffmpegPath();
  if (!ff) throw new EditError("FFmpeg not found");
  const scene = tl.scenes.find((s) => s.id === clip.sceneId);
  const fps = toNumber(tl.fps);
  const start = toNumber(clip.start);
  const len = toNumber(clipEnd(clip)) - start;
  // The moment under the playhead when it is on this clip, else a little into the clip.
  const into = atFrame !== undefined && atFrame / fps >= start && atFrame / fps < start + len ? atFrame / fps - start : Math.min(0.4, len / 2);
  const dir = flowDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const frame = `ref_${safeName(clipId)}_${stamp()}.jpg`;
  const at = clip.media.kind === "video" ? toNumber(clip.media.sourceIn) + into : 0;
  const r = await run(ff, ["-v", "error", "-y", ...(clip.media.kind === "video" ? ["-ss", at.toFixed(2)] : []), "-i", clip.media.path, "-frames:v", "1", "-vf", "scale='min(1920,iw)':-2", "-q:v", "2", path.join(dir, frame)], { timeoutMs: 60_000 });
  if (r.code !== 0 || !fs.existsSync(path.join(dir, frame))) throw new EditError("could not extract a reference frame from the clip");
  // No subject on the scene: a vault clip still knows its exact model (workspace/models/<vault>/clips/...).
  const vault = !scene?.subject.product ? readVault(path.dirname(path.dirname(clip.media.path))) : null;
  const product = scene?.subject.product ? identityText(scene.subject.product) : vault ? `${vault.brand} ${vault.model}` : null;
  const prompt = buildFlowPrompt({ product, spec: scene?.subject.spec?.spec ?? null, category, sceneText: scene?.text ?? "", angle, seconds: len });
  const req: FlowRequest = { prompt, frame, seconds: Math.round(len * 10) / 10, angle, product, flowUrl: FLOW_URL };
  const log = path.join(dir, "requests.json");
  const prev = fs.existsSync(log) ? (JSON.parse(fs.readFileSync(log, "utf8")) as unknown[]) : [];
  fs.writeFileSync(log, JSON.stringify([...prev, { at: new Date().toISOString(), clipId, sceneId: clip.sceneId, ...req }].slice(-200), null, 1));
  return req;
}

/** Path of a file in the project's flow/ folder (frames, imported videos), or null. */
export function flowFile(projectDir: string, name: string): string | null {
  const f = path.join(flowDir(projectDir), path.basename(name));
  return path.basename(name) === name && fs.existsSync(f) ? f : null;
}

export const downloadsDir = () => env("FLOW_DOWNLOADS_DIR", "") || path.join(os.homedir(), "Downloads");

/** Recent videos in the Downloads folder (Flow saves there), newest first. */
export function recentDownloads(maxAgeHours = 12, dir = downloadsDir()): { name: string; mb: number; minutesAgo: number }[] {
  if (!fs.existsSync(dir)) return [];
  const now = Date.now();
  return fs
    .readdirSync(dir)
    .filter((n) => VIDEO_EXT.test(n) && !/\.(crdownload|part)$/i.test(n))
    .map((n) => ({ n, st: fs.statSync(path.join(dir, n)) }))
    .filter((x) => x.st.isFile() && now - x.st.mtimeMs < maxAgeHours * 3600_000)
    .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    .slice(0, 10)
    .map((x) => ({ name: x.n, mb: Math.round((x.st.size / 1048576) * 10) / 10, minutesAgo: Math.round((now - x.st.mtimeMs) / 60000) }));
}

/** Copies a video from the Downloads folder into flow/ (only plain file names from that folder). */
export function takeFromDownloads(projectDir: string, name: string, dir = downloadsDir()): string {
  // Either slash counts on every OS: "..\\x.mp4" is a plain (allowed) file name to Linux path.basename.
  if (/[\\/]/.test(name) || name.startsWith("..") || path.basename(name) !== name || !VIDEO_EXT.test(name)) throw new EditError("not a video file name from the Downloads folder");
  const src = path.join(dir, name);
  if (!fs.existsSync(src)) throw new EditError(`${name} is not in ${dir}`, "not_found");
  fs.mkdirSync(flowDir(projectDir), { recursive: true });
  const out = `gen_${stamp()}_${safeName(name)}`;
  fs.copyFileSync(src, path.join(flowDir(projectDir), out));
  return out;
}

/** Stores an uploaded (dragged-in) video in flow/; returns its file name. */
export async function saveFlowUpload(req: http.IncomingMessage, projectDir: string, filename: string): Promise<string> {
  if (!VIDEO_EXT.test(filename)) throw new EditError("drop a video file (mp4, mov, webm)");
  fs.mkdirSync(flowDir(projectDir), { recursive: true });
  const out = `gen_${stamp()}_${safeName(filename)}`;
  const dest = path.join(flowDir(projectDir), out);
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(`${dest}.part`);
    req.on("data", (d: Buffer) => {
      bytes += d.length;
      if (bytes > MAX_UPLOAD) {
        req.destroy();
        ws.destroy();
        reject(new EditError("file too large (max 1 GB)"));
      }
    });
    req.pipe(ws);
    ws.on("finish", () => resolve());
    ws.on("error", reject);
  });
  fs.renameSync(`${dest}.part`, dest);
  return out;
}

/**
 * The edit that puts an imported Flow video into the clip, plus a note when the video is shorter
 * than the clip (the renderer then loops it).
 */
export async function generatedReplaceOp(tl: MultiTrackTimeline, projectDir: string, clipId: string, file: string, prompt?: string): Promise<{ op: EditOp; note: string | null }> {
  const f = flowFile(projectDir, file);
  if (!f || !VIDEO_EXT.test(f)) throw new EditError("imported video not found", "not_found");
  const fp = ffprobePath();
  const probe = fp ? await run(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", f]) : null;
  const info = probe?.code === 0 ? (JSON.parse(probe.stdout) as { streams?: { width: number; height: number }[]; format?: { duration?: string } }) : null;
  if (fp && !info?.streams?.length) throw new EditError("the file has no readable video stream");
  const { clip } = findClip(tl, clipId);
  const need = toNumber(clipEnd(clip)) - toNumber(clip.start);
  const dur = Number(info?.format?.duration ?? 0);
  const w = info?.streams?.[0]?.width ?? 0;
  const h = info?.streams?.[0]?.height ?? 0;
  const notes: string[] = [];
  if (dur && dur + 0.05 < need) notes.push(`the video is ${dur.toFixed(1)} s, the clip needs ${need.toFixed(1)} s - it will loop; split the clip or generate a longer one`);
  if (w && h && w / h < 1.5) notes.push("the video is not 16:9 - it will be cropped to fill the frame");
  return {
    op: {
      op: "replaceMedia",
      clipId,
      media: { path: f, kind: "video", sourceIn: 0 },
      provenance: { source: GENERATED_SOURCE, url: FLOW_URL, author: "Google Flow (Veo)", license: `AI-generated with Google Flow (Veo) - disclose as altered or synthetic content on YouTube${prompt ? ` | prompt: ${prompt.slice(0, 300)}` : ""}` },
    },
    note: notes.length ? notes.join("; ") : null,
  };
}

export const flowAngles = () => Object.entries(FLOW_ANGLES).map(([id, a]) => ({ id, label: a.label }));
