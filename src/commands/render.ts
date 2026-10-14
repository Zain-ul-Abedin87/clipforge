import crypto from "node:crypto";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { env } from "../lib/env.js";
import { run } from "../lib/exec.js";
import { paths } from "../lib/paths.js";
import { projectDir, readJson, writeJson } from "../lib/project.js";
import { AlignedWord } from "./align.js";
import { buildAss, captionLines, CaptionLine } from "../lib/render/captions.js";
import { ffmpegPath, ffprobePath } from "../lib/tools.js";
import { ensureSfx } from "../lib/render/sfx.js";
import { duckGraph } from "../audio/duck.js";
import type { Layer } from "../lib/assets/graphics.js";
import type { Timeline, TimelineScene } from "./timeline.js";

export interface RenderOpts {
  project: string;
  /** Render only the first N seconds (quick preview). */
  limitSeconds?: number;
  force?: boolean;
}

const W = 1920;
const H = 1080;
const FADE = 0.25;

const fpath = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

/** Gentle Ken Burns on stills via zoompan over an upscaled frame (upscaling avoids zoompan jitter). */
function motionFilter(s: TimelineScene, frames: number): string {
  if (s.motion === "none") return `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`;
  // Mild moves (channel study: still motion mostly static / slow zoom).
  const Z = s.asset.source === "graphic" ? 1.03 : 1.06;
  const n = Math.max(1, frames - 1);
  const center = `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'`;
  const expr = {
    zoom_in: `z='1+${Z - 1}*on/${n}':${center}`,
    zoom_out: `z='${Z}-${Z - 1}*on/${n}':${center}`,
    pan_right: `z='${Z}':x='(iw-iw/zoom)*on/${n}':y='ih/2-(ih/zoom/2)'`,
    pan_left: `z='${Z}':x='(iw-iw/zoom)*(1-on/${n})':y='ih/2-(ih/zoom/2)'`,
  }[s.motion];
  return `scale=${W * 1.5}:${H * 1.5}:force_original_aspect_ratio=increase,crop=${W * 1.5}:${H * 1.5},zoompan=${expr}:d=1:s=${W}x${H}:fps=30`;
}

/** Baked once per photo: backdrop (slightly larger than the frame, for drift) + photo with shadow. */
export interface Showcase {
  bg: string;
  fg: string;
  /** Spec chips on the right: the product sits left of centre. */
  left: boolean;
}

/**
 * Still images (overlay layers, logo, showcase stills) are read once and repeated inside the
 * filter graph. With `-loop 1` inputs FFmpeg 7 decodes them in their own threads far ahead of a
 * slow graph; six chip layers on a showcase ran out of memory that way.
 */
const HOLD = "loop=loop=-1:size=1:start=0,setpts=N/30/TB";

const BG_PAD_X = 120;
const BG_PAD_Y = 68;

/**
 * Product-photo showcase (2.5D parallax). The backdrop drifts one way, the whole photo (never
 * cropped, so a wide shotgun or a tall phone stays whole) grows slowly and drifts the other way.
 * Inputs: [0:v] backdrop, [1:v] photo with shadow. Output label [pv].
 */
function showcaseGraph(s: TimelineScene, frames: number, sc: Showcase): string[] {
  const D = Math.max(1, frames - 1) / 30;
  const p = `min(1,t/${D.toFixed(3)})`;
  const grow = s.motion === "zoom_out" ? `(1.06-0.06*${p})` : `(1+0.06*${p})`;
  const dir = s.motion === "pan_left" ? -1 : s.motion === "pan_right" ? 1 : s.id % 2 ? 1 : -1;
  const bgX = dir > 0 ? `${BG_PAD_X}*${p}` : `${BG_PAD_X}*(1-${p})`;
  const cx = sc.left ? Math.round(W * 0.33) : W / 2;
  const dx = `${-dir * 30}*(${p}-0.5)`;
  return [
    `[0:v]${HOLD},crop=${W}:${H}:x='${bgX}':y=${BG_PAD_Y / 2},format=rgba[pbg]`,
    `[1:v]${HOLD},format=rgba,scale=w='trunc(iw*${grow}/2)*2':h=-2:eval=frame[pfg]`,
    `[pbg][pfg]overlay=x='${cx}-w/2+${dx}':y='${H / 2 - 10}-h/2':eval=frame,format=yuv420p[pv]`,
  ];
}

/**
 * Bakes the showcase stills. Cut-out photos (with transparency, common on maker sites) get a
 * neutral studio gradient; ordinary photos get a blurred, darkened copy of themselves.
 */
export async function prepareShowcase(ff: string, fp: string, src: string, outDir: string, left: boolean): Promise<Showcase | null> {
  const key = crypto.createHash("sha1").update(`${src}|${left}|sc2`).digest("hex").slice(0, 12);
  const bg = path.join(outDir, `scbg_${key}.png`);
  const fg = path.join(outDir, `scfg_${key}.png`);
  if (fs.existsSync(bg) && fs.existsSync(fg)) return { bg, fg, left };
  const pix = (await run(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "csv=p=0", src])).stdout.trim();
  const alpha = /a|^pal8$/.test(pix.replace(/^gray$/, ""));
  const BW = W + BG_PAD_X;
  const BH = H + BG_PAD_Y;
  const glow = (base: number, add: number) => `'${base}+${add}*pow(max(0,1-hypot((X-W/2)/(W*0.62),(Y-H*0.42)/(H*0.8))),1.5)'`;
  const bgArgs = alpha
    ? ["-f", "lavfi", "-i", `color=c=black:s=${BW}x${BH},format=rgb24,geq=r=${glow(16, 48)}:g=${glow(17, 51)}:b=${glow(20, 58)}`]
    : ["-i", src, "-vf", `scale=${BW}:${BH}:force_original_aspect_ratio=increase,crop=${BW}:${BH},boxblur=36:3,eq=brightness=-0.24:saturation=0.85`];
  const r1 = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", ...bgArgs, "-frames:v", "1", bg]);
  // Photo inside its box, a soft offset shadow under it, on a transparent canvas.
  const box = left ? `${Math.round(W * 0.48)}:${H - 300}` : `${W - 420}:${H - 280}`;
  const graph =
    `[0:v]format=rgba,scale=${box}:force_original_aspect_ratio=decrease,split=2[ph][sh];` +
    `[sh]colorchannelmixer=rr=0:gg=0:bb=0:aa=0.55,pad=iw+120:ih+120:74:84:color=black@0,boxblur=22:2[shb];` +
    `[shb][ph]overlay=60:60`;
  const r2 = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-filter_complex", graph, "-frames:v", "1", fg]);
  return r1.code === 0 && r2.code === 0 ? { bg, fg, left } : null;
}

export interface SegmentJob {
  logo?: Timeline["logo"];
  /** Non-16:9 product photo: parallax showcase instead of a baked blurred-background still. */
  showcase?: Showcase;
  scene: TimelineScene;
  frames: number;
  startSec: number;
  fadeIn: boolean;
  fadeOut: boolean;
  out: string;
  assFile: string | null;
}

/** Ease-out cubic progress 0..1 of an animation that starts at d and lasts len seconds. */
const ease = (d: number, len: number) => `pow(1-min(1,max(0,(t-${d.toFixed(3)})/${len})),3)`;

/** Position expressions for a layer's entrance; the fade filter supplies the opacity. */
function layerPosition(l: Layer): string {
  if (l.anim === "slide_up") return `x=0:y='70*${ease(l.delay, 0.4)}'`;
  if (l.anim === "slide_left") return `x='-760*${ease(l.delay, 0.45)}':y=0`;
  if (l.anim === "slide_right") return `x='820*${ease(l.delay, 0.4)}':y=0`;
  return "x=0:y=0";
}

export function segmentArgs(job: SegmentJob, encoder: "nvenc" | "x264"): string[] {
  const { scene, frames } = job;
  const dur = frames / 30;
  const sc = job.showcase;
  // Sub-shots (pacing engine): one input per sub-shot, scaled, trimmed and concatenated in the graph.
  const subs = !sc && scene.asset.shots && scene.asset.shots.length ? scene.asset.shots : null;
  const input = subs
    ? subs.flatMap((x) => (x.kind === "video" ? ["-ss", String(x.in ?? 0), "-stream_loop", "-1", "-i", x.path] : ["-loop", "1", "-framerate", "30", "-i", x.path]))
    : sc
    ? ["-i", sc.bg, "-i", sc.fg]
    : scene.asset.kind === "video"
      ? ["-ss", String(scene.asset.in ?? 0), "-stream_loop", "-1", "-i", scene.asset.path]
      : ["-loop", "1", "-framerate", "30", "-i", scene.asset.path];
  // Overlay inputs follow the footage input(s).
  const first = subs ? subs.length : sc ? 2 : 1;
  const layers = (scene.overlays ?? []).filter((l) => l.delay < dur && (!l.video || fs.existsSync(l.path)));
  // Remotion cards are ProRes 4444 clips with alpha (l.video); PNG layers are stills.
  const layerInputs = layers.flatMap((l) => ["-i", l.path]);
  const logo = job.logo;
  if (logo) layerInputs.push("-i", logo.path);

  const base = sc ? ["fps=30", "setsar=1"] : [motionFilter(scene, frames), "fps=30", "setsar=1"];
  // Card over footage: blur and darken the picture so the text reads.
  if (scene.backdrop === "blur") base.push("boxblur=22:2", "eq=brightness=-0.28:saturation=0.8");
  if (job.fadeIn) base.push(scene.transition === "flash" ? `fade=t=in:st=0:d=0.3:color=white` : `fade=t=in:st=0:d=${FADE}`);
  if (job.fadeOut) base.push(`fade=t=out:st=${Math.max(0, dur - FADE).toFixed(3)}:d=${FADE}`);
  const graph: string[] = subs
    ? [
        ...subs.map((x, k) =>
          x.kind === "image"
            ? `[${k}:v]scale=${W * 1.5}:${H * 1.5}:force_original_aspect_ratio=increase,crop=${W * 1.5}:${H * 1.5},zoompan=z='1+0.05*on/${Math.max(1, x.frames - 1)}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=30,setsar=1,trim=end_frame=${x.frames},setpts=PTS-STARTPTS[ss${k}]`
            : `[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,setsar=1,trim=end_frame=${x.frames},setpts=PTS-STARTPTS[ss${k}]`,
        ),
        `${subs.map((_, k) => `[ss${k}]`).join("")}concat=n=${subs.length}:v=1:a=0[cat]`,
        `[cat]${["fps=30", "setsar=1", ...base.slice(subs ? 3 : 0)].join(",")}[v0]`,
      ]
    : sc
      ? [...showcaseGraph(scene, frames, sc), `[pv]${base.join(",")}[v0]`]
      : [`[0:v]${base.join(",")}[v0]`];
  let cur = "v0";
  layers.forEach((l, k) => {
    if (l.video) {
      // The card animates itself (spring in, fade out); shift it to its start time and let the
      // footage pass through once it ends.
      graph.push(`[${k + first}:v]format=yuva444p,setpts=PTS-STARTPTS+${l.delay.toFixed(3)}/TB[l${k}]`);
      graph.push(`[${cur}][l${k}]overlay=x=0:y=0:eof_action=pass:format=auto[v${k + 1}]`);
      cur = `v${k + 1}`;
      return;
    }
    const fades = [`fade=t=in:st=${l.delay.toFixed(3)}:d=0.3:alpha=1`];
    if (l.out !== undefined && l.out < dur) fades.push(`fade=t=out:st=${l.out.toFixed(3)}:d=0.3:alpha=1`);
    graph.push(`[${k + first}:v]${HOLD},format=rgba,${fades.join(",")}[l${k}]`);
    graph.push(`[${cur}][l${k}]overlay=${layerPosition(l)}:eval=frame[v${k + 1}]`);
    cur = `v${k + 1}`;
  });
  if (logo) {
    // Corner logo, ~170 px wide, at the channel's opacity; drawn under the captions.
    const k = layers.length + first;
    const pos: Record<string, string> = {
      "top-right": "x=W-w-48:y=40",
      "top-left": "x=48:y=40",
      "bottom-right": "x=W-w-48:y=H-h-150",
      "bottom-left": "x=48:y=H-h-150",
    };
    graph.push(`[${k}:v]${HOLD},scale=170:-1,format=rgba,colorchannelmixer=aa=${logo.opacity}[logo]`);
    graph.push(`[${cur}][logo]overlay=${pos[logo.position] ?? pos["top-right"]}[vlogo]`);
    cur = "vlogo";
  }
  const tail: string[] = [];
  if (job.assFile) {
    // Shift to absolute time so the subtitles filter picks this segment's lines, then shift back.
    tail.push(
      `setpts=PTS+${job.startSec.toFixed(4)}/TB`,
      `subtitles='${fpath(job.assFile)}':fontsdir='${fpath("C:/Windows/Fonts")}'`,
      "setpts=PTS-STARTPTS",
    );
  }
  tail.push("format=yuv420p");
  graph.push(`[${cur}]${tail.join(",")}[vout]`);

  const enc =
    encoder === "nvenc"
      ? ["-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "22", "-b:v", "0", "-maxrate", "10M", "-bufsize", "20M", "-profile:v", "high", "-g", "60"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-crf", "21", "-profile:v", "high", "-g", "60"];
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    ...input, ...layerInputs,
    "-filter_complex", graph.join(";"),
    "-map", "[vout]",
    "-frames:v", String(frames), "-an", ...enc, "-video_track_timescale", "15360", job.out,
  ];
}

/**
 * Product photos are rarely 16:9 (a shotgun shot is ~2:1 or wider); cropping would cut off the
 * barrel or stock. Compose the whole photo centred over a blurred, darkened copy of itself.
 */
async function fitToFrame(ff: string, src: string, outDir: string): Promise<string> {
  const key = crypto.createHash("sha1").update(src).digest("hex").slice(0, 12);
  const out = path.join(outDir, `fit_${key}.png`);
  if (fs.existsSync(out)) return out;
  const graph =
    `[0:v]split=2[a][b];` +
    `[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=40:3,eq=brightness=-0.18[bg];` +
    `[b]scale=${W - 160}:${H - 120}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`;
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-filter_complex", graph, "-frames:v", "1", out]);
  return r.code === 0 ? out : src;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

export async function render(opts: RenderOpts, log: (m: string) => void = console.log): Promise<number> {
  const dir = projectDir(opts.project);
  const tlFile = path.join(dir, "timeline.json");
  if (!fs.existsSync(tlFile)) {
    log(`[render] ${tlFile} missing. Run \`clipforge timeline\` first.`);
    return 1;
  }
  const ff = ffmpegPath();
  const fp = ffprobePath();
  if (!ff || !fp) {
    log("[render] ffmpeg not found");
    return 1;
  }
  const t0 = Date.now();
  // RAM watch: free system memory sampled every second; peak use = baseline free - lowest free.
  const gb = (b: number) => Math.round((b / 1024 ** 3) * 100) / 100;
  const baselineFree = os.freemem();
  let minFree = baselineFree;
  const ramTimer = setInterval(() => (minFree = Math.min(minFree, os.freemem())), 1000);
  const tl = readJson<Timeline>(tlFile);
  const limitFrames = opts.limitSeconds ? Math.round(opts.limitSeconds * 30) : Infinity;
  const scenes = tl.scenes.filter((s) => s.startFrame < limitFrames);
  const totalFrames = Math.min(scenes[scenes.length - 1].endFrame, limitFrames);
  const duration = totalFrames / 30;

  const segDir = path.join(dir, "render");
  fs.mkdirSync(segDir, { recursive: true });

  // Captions: one ASS for the whole video; each segment burns only its own time range.
  let assFile: string | null = null;
  let lines: CaptionLine[] = [];
  if (tl.captions.enabled && fs.existsSync(path.join(dir, "aligned.json"))) {
    const words = readJson<{ words: AlignedWord[] }>(path.join(dir, "aligned.json")).words;
    lines = captionLines(words, tl.captions.maxWordsPerLine);
    assFile = path.join(segDir, "captions.ass");
    fs.writeFileSync(assFile, buildAss(lines, tl.captions), "utf8");
  }

  // Non-16:9 product stills (press kit, official, Wikimedia, own photos) get the parallax showcase;
  // PRODUCT_PARALLAX=off falls back to one baked blurred-background still with a Ken Burns move.
  const parallaxOn = env("PRODUCT_PARALLAX", "on").toLowerCase() !== "off";
  const showcases = new Map<number, Showcase>();
  for (const s of scenes) {
    const a = s.asset;
    if (a.kind !== "image" || a.source === "graphic" || a.shots?.length) continue;
    const probe = await run(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", a.path]);
    const [w, h] = probe.stdout.trim().split(",").map(Number);
    if (!w || !h || Math.abs(w / h - 16 / 9) <= 0.15) continue;
    const chips = (s.overlays ?? []).some((l) => l.anim === "slide_right");
    const sc = parallaxOn && s.motion !== "none" ? await prepareShowcase(ff, fp, a.path, segDir, chips) : null;
    if (sc) showcases.set(s.id, sc);
    else s.asset = { ...a, path: await fitToFrame(ff, a.path, segDir) };
  }

  // Segment jobs. A segment's file name hashes everything that affects its pixels, so an edited
  // scene (or swapped asset) re-renders only that segment; unchanged ones are reused.
  const jobs: SegmentJob[] = scenes.map((s, i) => {
    const endFrame = Math.min(s.endFrame, limitFrames);
    const frames = endFrame - s.startFrame;
    const startSec = s.startFrame / 30;
    const fadeIn = s.transition === "fade" || s.transition === "flash";
    const fadeOut = scenes[i + 1]?.transition === "fade";
    const segLines = lines.filter((l) => l.end > startSec && l.start < endFrame / 30);
    const showcase = showcases.get(s.id);
    const key = crypto
      .createHash("sha1")
      .update(JSON.stringify({ a: s.asset, m: s.motion, tr: s.transition, ov: s.overlays ?? [], lg: tl.logo ?? null, f: frames, st: s.startFrame, fadeIn, fadeOut, segLines, cap: assFile ? tl.captions : null, v: 4, bd: s.backdrop ?? null, ...(showcase ? { sc: showcase } : {}) }))
      .digest("hex")
      .slice(0, 12);
    return { logo: tl.logo ?? null, showcase, scene: s, frames, startSec, fadeIn, fadeOut, out: path.join(segDir, `seg_${String(s.id).padStart(4, "0")}_${key}.mp4`), assFile: segLines.length ? assFile : null };
  });

  if (opts.force) for (const j of jobs) for (const f of [j.out, `${j.out}.enc`]) fs.rmSync(f, { force: true });
  const todo = jobs.filter((j) => !fs.existsSync(j.out));
  log(`[render] ${jobs.length} segments (${jobs.length - todo.length} reused from cache), ${(duration / 60).toFixed(1)} min`);

  // The GPU on this laptop throws sporadic CUDA errors: retry NVENC once, then fall back to x264.
  const encoders = new Map<string, "nvenc" | "x264">();
  let done = 0;
  let fallbacks = 0;
  const preferred = env("VIDEO_ENCODER", "h264_nvenc") === "libx264" ? "x264" : "nvenc";
  // RAM-careful: two parallel segments only when there is headroom (a 25-min test dipped to 0.3 GB
  // free with 2 at a time and ~3 GB free at start). RENDER_CONCURRENCY in .env overrides.
  const parallel = Number(env("RENDER_CONCURRENCY", "")) || (os.freemem() > 4.5 * 1024 ** 3 ? 2 : 1);
  log(`[render] ${parallel} segment(s) at a time (${gb(os.freemem())} GB RAM free)`);
  await pool(todo, parallel, async (job) => {
    const tries: ("nvenc" | "x264")[] = preferred === "nvenc" ? ["nvenc", "nvenc", "x264"] : ["x264"];
    for (const enc of tries) {
      const tmp = job.out.replace(/\.mp4$/, ".part.mp4");
      const r = await run(ff, segmentArgs({ ...job, out: tmp }, enc));
      if (r.code === 0 && fs.existsSync(tmp)) {
        fs.renameSync(tmp, job.out);
        fs.writeFileSync(`${job.out}.enc`, enc); // remembered for later runs that reuse this segment
        encoders.set(job.out, enc);
        if (enc === "x264" && preferred === "nvenc") fallbacks++;
        break;
      }
      fs.rmSync(tmp, { force: true });
      log(`[render] scene ${job.scene.id} ${enc} failed: ${r.stderr.trim().split("\n").pop()?.slice(0, 160)}`);
    }
    done++;
    if (done % 10 === 0 || done === todo.length) log(`[render] segments ${done}/${todo.length}`);
  });
  const missing = jobs.filter((j) => !fs.existsSync(j.out));
  if (missing.length) {
    log(`[render] FAILED: could not render scenes ${missing.map((j) => j.scene.id).join(", ")}`);
    return 1;
  }

  // Concat. Cached segments from earlier runs may have used another encoder; mixed H.264 streams
  // are re-encoded once at the end instead of stream-copied, so the file is always clean.
  const list = path.join(segDir, "concat.txt");
  // Explicit per-file durations: without them the concat demuxer drops the last frame's duration of
  // every segment, so the video drifts ~30 ms ahead of the voice per scene (seconds over 20 minutes).
  fs.writeFileSync(
    list,
    jobs.map((j) => `file '${j.out.replace(/\\/g, "/").replace(/'/g, "'\\''")}'\nduration ${(j.frames / 30).toFixed(6)}`).join("\n") + "\n",
  );
  const encOf = (out: string) => encoders.get(out) ?? (fs.existsSync(`${out}.enc`) ? fs.readFileSync(`${out}.enc`, "utf8").trim() : "nvenc");
  const segEncoders = new Set(jobs.map((j) => encOf(j.out)));
  const mixed = fallbacks > 0 || segEncoders.size > 1;

  // Music bed: concatenate the channel's tracks once, then loop it under the voice.
  let bed: string | null = null;
  if (tl.music.files.length) {
    bed = path.join(segDir, "music_bed.wav");
    const inputs = tl.music.files.flatMap((f) => ["-i", f]);
    const n = tl.music.files.length;
    const filt = `${Array.from({ length: n }, (_, i) => `[${i}:a]aresample=48000,aformat=channel_layouts=stereo[m${i}]`).join(";")};${Array.from({ length: n }, (_, i) => `[m${i}]`).join("")}concat=n=${n}:v=0:a=1[out]`;
    const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", ...inputs, "-filter_complex", filt, "-map", "[out]", bed]);
    if (r.code !== 0) {
      log(`[render] music bed failed, continuing without music: ${r.stderr.slice(-200)}`);
      bed = null;
    }
  }

  const D = duration.toFixed(3);

  // Sound effects: one input per kind, split and delayed to every event time.
  const sfxOn = tl.motion?.sfx !== false;
  const events = sfxOn
    ? scenes.flatMap((s) => (s.sfx ?? []).map((e) => ({ kind: e.kind, at: s.startFrame / 30 + e.at }))).filter((e) => e.at < duration - 0.2)
    : [];
  const sfxFiles = events.length ? await ensureSfx(ff) : null;
  const sfxKinds = [...new Set(events.map((e) => e.kind))];
  const firstSfxInput = 2 + (bed ? 1 : 0);
  const sfxInputs = sfxKinds.flatMap((k) => ["-i", sfxFiles![k]]);
  const sfxGraph: string[] = [];
  const sfxLabels: string[] = [];
  sfxKinds.forEach((k, ki) => {
    const evs = events.filter((e) => e.kind === k);
    const outs = evs.map((_, j) => `[${k}${j}]`).join("");
    sfxGraph.push(`[${firstSfxInput + ki}:a]aresample=48000,aformat=channel_layouts=stereo,asplit=${evs.length}${outs}`);
    evs.forEach((e, j) => {
      const ms = Math.round(e.at * 1000);
      sfxGraph.push(`[${k}${j}]adelay=${ms}|${ms},volume=${tl.motion?.sfxDb ?? -14}dB[e${k}${j}]`);
      sfxLabels.push(`[e${k}${j}]`);
    });
  });
  if (sfxLabels.length) sfxGraph.push(`${sfxLabels.join("")}amix=inputs=${sfxLabels.length}:duration=longest:normalize=0,atrim=0:${D}[sfx]`);
  const voiceChain = `[1:a]aresample=48000,aformat=channel_layouts=stereo,atrim=0:${D},asetpts=PTS-STARTPTS`;
  const filter = bed
    ? duckGraph({ voiceChain, musicIn: "[2:a]", duration, volumeDb: tl.music.volumeDb, out: "pre" })
    : `${voiceChain}[pre]`;
  const finalAudio = sfxLabels.length
    ? `${sfxGraph.join(";")};[pre][sfx]amix=inputs=2:duration=first:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11[aout]`
    : `[pre]loudnorm=I=-14:TP=-1.5:LRA=11[aout]`;

  fs.mkdirSync(paths.output, { recursive: true });
  const outFile = path.join(paths.output, `${opts.project}${opts.limitSeconds ? `_first${opts.limitSeconds}s` : ""}.mp4`);
  const videoCodec = mixed
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-profile:v", "high", "-pix_fmt", "yuv420p"]
    : ["-c:v", "copy"];
  log(`[render] muxing${bed ? " voice + ducked music" : " voice"}${mixed ? " (re-encoding mixed segments)" : ""} ...`);
  const mux = await run(ff, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "concat", "-safe", "0", "-i", list,
    "-i", tl.voice,
    ...(bed ? ["-stream_loop", "-1", "-i", bed] : []),
    ...sfxInputs,
    "-filter_complex", `${filter};${finalAudio}`,
    "-map", "0:v", "-map", "[aout]",
    ...videoCodec,
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-t", D,
    "-movflags", "+faststart",
    outFile,
  ]);
  if (mux.code !== 0) {
    log(`[render] FAILED at mux: ${mux.stderr.slice(-500)}`);
    return 1;
  }

  // QA: stream durations must match each other and the timeline (A/V sync).
  const probe = await run(fp, ["-v", "error", "-show_entries", "stream=codec_type,duration,nb_frames:format=duration,size", "-of", "json", outFile]);
  const info = JSON.parse(probe.stdout);
  const v = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const a = info.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  const vDur = Number(v?.duration);
  const aDur = Number(a?.duration);
  const report = {
    output: outFile,
    durationTimeline: Number(D),
    durationVideo: vDur,
    durationAudio: aDur,
    avDiff: Math.round(Math.abs(vDur - aDur) * 1000) / 1000,
    frames: Number(v?.nb_frames),
    framesExpected: totalFrames,
    segments: jobs.length,
    segmentsRendered: todo.length,
    x264Fallbacks: fallbacks,
    music: !!bed,
    soundEffects: events.length,
    captions: !!assFile,
    sizeMB: Math.round(Number(info.format.size) / 1024 / 1024),
    renderSeconds: Math.round((Date.now() - t0) / 1000),
    sync: Math.abs(vDur - aDur) < 0.1 && Math.abs(vDur - Number(D)) < 0.1,
    ramTotalGB: gb(os.totalmem()),
    ramFreeAtStartGB: gb(baselineFree),
    ramLowestFreeGB: gb(minFree),
    ramPeakUsedByRenderGB: gb(Math.max(0, baselineFree - minFree)),
  };
  clearInterval(ramTimer);
  writeJson(path.join(dir, "render_report.json"), report);
  log(`[render] video ${vDur.toFixed(2)}s / audio ${aDur.toFixed(2)}s / timeline ${D}s -> A/V diff ${report.avDiff}s`);
  log(`[render] frames ${report.frames}/${totalFrames}, ${report.sizeMB} MB, ${report.renderSeconds}s, x264 fallbacks ${fallbacks}`);
  log(`[render] RAM: ${report.ramFreeAtStartGB} GB free at start, lowest ${report.ramLowestFreeGB} GB -> render used ~${report.ramPeakUsedByRenderGB} GB`);
  log(`[render] ${report.sync ? "A/V in sync" : "A/V MISMATCH"} -> ${outFile}`);
  return report.sync ? 0 : 1;
}
