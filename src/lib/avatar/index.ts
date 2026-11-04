import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { ffmpegPath } from "../tools.js";
import { loadLlmSettings } from "../agents/llm/settings.js";
import { modelLoader } from "../models/loader.js";
import type { FeatureSettings } from "../settings/features.js";
import { AvatarEngineName, buildArgv, ENGINES, museTalkYaml } from "./engines.js";

/**
 * AI avatar (Phase 7): one fixed photo per channel (channels/<id>/avatar.png) speaks short parts of
 * the voiceover (intro, outro, bridges between products), as picture-in-picture or full frame.
 * Clips render ONE AT A TIME, each in its own engine process (the model leaves VRAM when the clip is
 * done); local LLMs are unloaded first. Clips are tagged source "own-avatar" so the talking-head QA
 * check never flags them.
 */

export type Placement = "intro" | "outro" | "bridge";
export interface AvatarClip {
  kind: Placement;
  start: number;
  end: number;
  /** Timeline scene ids the clip covers (whole scenes). */
  sceneIds: number[];
  file?: string;
  ms?: number;
  error?: string;
}

export interface AvatarPlan {
  engine: AvatarEngineName;
  layout: "pip" | "full";
  image: string;
  clips: AvatarClip[];
}

/** channels/<id>/avatar.png (or .jpg): the channel's own fixed avatar photo. */
export function channelAvatar(channel: string): string | null {
  for (const ext of ["png", "jpg", "jpeg", "webp"]) {
    const f = path.join(paths.channels, channel, `avatar.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

interface SceneLike {
  id: number;
  start: number;
  end: number;
  type?: string;
  product_name?: string;
}
interface SectionLike {
  kind: string;
  start: number;
  end: number;
  hookEnd?: number;
}

/**
 * Where the avatar speaks: whole scenes only (the clip replaces / overlays complete scenes), each
 * clip at most `maxSec` long (at least 2 s).
 *  - intro: the intro's scenes after the hook teaser;
 *  - outro: the outro's first scenes;
 *  - bridge: the first scene of every product chapter (the line that introduces the product).
 */
export function planClips(scenes: SceneLike[], sections: SectionLike[], placements: Placement[], maxSec: number): AvatarClip[] {
  const clips: AvatarClip[] = [];
  const take = (kind: Placement, from: number, until: number) => {
    const list = scenes.filter((s) => s.start >= from - 0.05 && s.end <= until + 0.05 && s.type !== "graphic");
    const picked: SceneLike[] = [];
    for (const s of list) {
      if (picked.length && (s.end - picked[0].start > maxSec || s.start - picked[picked.length - 1].end > 0.1)) break;
      if (!picked.length && s.end - s.start > maxSec) continue;
      picked.push(s);
    }
    if (picked.length && picked[picked.length - 1].end - picked[0].start >= 2) clips.push({ kind, start: picked[0].start, end: picked[picked.length - 1].end, sceneIds: picked.map((s) => s.id) });
  };
  const intro = sections.find((s) => s.kind === "intro");
  const outro = sections.find((s) => s.kind === "outro");
  if (placements.includes("intro") && intro) take("intro", Math.max(intro.start, intro.hookEnd ?? sections[0]?.hookEnd ?? intro.start), intro.end);
  if (placements.includes("bridge")) {
    const seen = new Set<string>();
    for (const s of scenes) {
      if (s.type !== "product" || !s.product_name || seen.has(s.product_name)) continue;
      seen.add(s.product_name);
      if (s.end - s.start >= 2 && s.end - s.start <= maxSec) clips.push({ kind: "bridge", start: s.start, end: s.end, sceneIds: [s.id] });
    }
  }
  if (placements.includes("outro") && outro) take("outro", outro.start, outro.end);
  return clips.sort((a, b) => a.start - b.start);
}

/** Runs one engine process; resolves with exit code and the stderr tail. */
function runEngine(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err = (err + String(d)).slice(-3000)));
    child.stdout.on("data", () => {});
    const t = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", (e) => (clearTimeout(t), resolve({ code: -1, err: e.message })));
    child.on("close", (code) => (clearTimeout(t), resolve({ code: code ?? -1, err })));
  });
}

const newestMp4 = (dir: string): string | null => {
  const all: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.mp4$/i.test(e.name)) all.push(f);
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null;
};

/**
 * Renders every planned clip, one at a time. `voice`: the voiceover file (clip audio is cut from
 * it). Output: <dir>/avatar/clip_<n>.mp4 with the clip's audio.
 */
export async function renderClips(plan: AvatarPlan, voice: string, dir: string, cfg: FeatureSettings["avatar"], log: (m: string) => void): Promise<AvatarClip[]> {
  const ff = ffmpegPath();
  if (!ff) throw new Error("ffmpeg not found");
  const spec = ENGINES[plan.engine];
  const outRoot = path.join(dir, "avatar");
  fs.mkdirSync(outRoot, { recursive: true });
  // Free the GPU: unload every local LLM before the first clip.
  const s = loadLlmSettings();
  const loader = modelLoader(() => s.qwen.baseUrl.replace(/\/v1\/?$/, ""));
  if (loader) for (const m of await loader.loaded()) await loader.unload(m);
  if (spec.slow) log(`[avatar] ${plan.engine} is a slow engine on 8 GB (minutes per second of video)`);
  for (const [n, c] of plan.clips.entries()) {
    const t0 = Date.now();
    const work = path.join(outRoot, `clip_${n}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    const audio = path.join(work, "audio.wav");
    const out = path.join(outRoot, `clip_${n}.mp4`);
    await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-ss", c.start.toFixed(3), "-t", (c.end - c.start).toFixed(3), "-i", voice, "-ac", "1", "-ar", "16000", audio]);
    let faceVideo = "";
    if (spec.needsFaceVideo) {
      faceVideo = path.join(work, "face.mp4");
      await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-i", plan.image, "-t", (c.end - c.start + 0.5).toFixed(3), "-r", "25", "-vf", "scale=512:-2,format=yuv420p", "-c:v", "libx264", faceVideo]);
    }
    if (plan.engine === "musetalk") fs.writeFileSync(path.join(work, "task.yaml"), museTalkYaml(plan.image, audio));
    const raw = path.join(work, "raw.mp4");
    const argv = buildArgv(cfg.command || spec.command, { python: cfg.pythonCmd || "python", image: plan.image, audio, out: raw, outdir: work, face_video: faceVideo, driving: cfg.drivingVideo ?? "", fps: "25", ffmpeg: ff });
    log(`[avatar] clip ${n + 1}/${plan.clips.length} (${c.kind}, ${(c.end - c.start).toFixed(1)} s) with ${plan.engine}`);
    const r = await runEngine(argv[0], argv.slice(1), cfg.engineDir || process.cwd(), 30 * 60_000);
    const made = spec.output === "out" || cfg.command?.includes("{out}") ? (fs.existsSync(raw) ? raw : null) : newestMp4(work);
    if (r.code !== 0 || !made) {
      c.error = `engine exit ${r.code}: ${r.err.slice(-240)}`;
      log(`[avatar] clip ${n + 1} failed: ${c.error}`);
      continue;
    }
    // Exactly the clip's length, 30 fps, with the clip's own audio (some engines drop or resample it).
    const mux = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", made, "-i", audio, "-map", "0:v:0", "-map", "1:a:0", "-r", "30", "-t", (c.end - c.start).toFixed(3), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", out]);
    if (mux.code !== 0) {
      c.error = `mux failed: ${mux.stderr.slice(-200)}`;
      continue;
    }
    c.file = out;
    c.ms = Date.now() - t0;
    loader?.record(plan.engine, "avatar", { wallMs: c.ms, cpu: false });
    log(`[avatar] clip ${n + 1} done in ${(c.ms / 1000).toFixed(1)} s (${plan.engine} process ended: its model left VRAM)`);
  }
  return plan.clips;
}

/**
 * Picture-in-picture layer for one scene: the avatar piece [inSec, inSec + dur) scaled to
 * `scale` of the frame width in a corner with a white border, on a transparent 1920x1080 canvas
 * (ProRes 4444 with alpha, like the Remotion cards, so the renderer overlays it unchanged).
 */
export async function pipLayer(src: string, inSec: number, dur: number, out: string, o: { scale: number; corner: "br" | "bl" | "tr" | "tl" }): Promise<boolean> {
  const ff = ffmpegPath();
  if (!ff) return false;
  const w = Math.round((1920 * o.scale) / 2) * 2;
  const m = 48;
  const x = o.corner.endsWith("l") ? `${m}` : `W-w-${m}`;
  const y = o.corner.startsWith("t") ? `${m}` : `H-h-${m + 110}`;
  const graph = `color=c=black@0.0:s=1920x1080:r=30:d=${dur.toFixed(3)},format=yuva444p[bg];[0:v]trim=start=${inSec.toFixed(3)}:duration=${dur.toFixed(3)},setpts=PTS-STARTPTS,scale=${w - 12}:-2,pad=iw+12:ih+12:6:6:white,format=yuva444p[av];[bg][av]overlay=x=${x}:y=${y}:format=auto:shortest=1,format=yuva444p10le[v]`;
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-filter_complex", graph, "-map", "[v]", "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", "-an", out]);
  return r.code === 0 && fs.existsSync(out);
}

/** Talking-head QA findings minus the avatar's own time ranges (source "own-avatar"). */
export function withoutAvatar<T extends { start: number; end: number }>(talking: T[], avatarRanges: { start: number; end: number }[]): T[] {
  return talking.filter((t) => !avatarRanges.some((a) => t.start < a.end - 0.05 && t.end > a.start + 0.05));
}
