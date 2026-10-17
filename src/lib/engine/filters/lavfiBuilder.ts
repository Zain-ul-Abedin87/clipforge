import type { Fit } from "../../../domain/timeline.types.js";
import { run } from "../../exec.js";

/**
 * FFmpeg filter graphs (lavfi) that fit any source into the 16:9 frame. The blur-pad graph is the
 * vertical-video technique popularised by Shorts tools such as OpenShorts, applied in reverse
 * (9:16 -> 16:9): the source, scaled to fill, blurred and darkened, is the background; the whole
 * source, scaled to fit, sits centred on top. Re-implemented here; no third-party code is copied.
 */

export interface Size {
  w: number;
  h: number;
}

export const LANDSCAPE: Size = { w: 1920, h: 1080 };

export const isVertical = (s: Size) => s.h > s.w;

/** cover when the aspect ratio is within 15 % of the output, otherwise blur_pad (Shorts, squares, ultra-wides). */
export function chooseFit(src: Size, out: Size = LANDSCAPE): Fit {
  if (!src.w || !src.h) return "cover";
  const ratio = src.w / src.h / (out.w / out.h);
  return ratio > 0.85 && ratio < 1.18 ? "cover" : "blur_pad";
}

export interface FitOpts {
  /** boxblur radius of the background (blur_pad). */
  blur?: number;
  /** Brightness offset of the background, -1..1 (blur_pad). */
  darken?: number;
  fps?: number;
}

/**
 * Filter graph from `inLabel` to `outLabel` (e.g. "[0:v]" -> "[vout]"). Output is exactly out.w x
 * out.h, square pixels, constant frame rate, yuv420p.
 */
export function fitGraph(fit: Fit, out: Size = LANDSCAPE, o: FitOpts = {}, inLabel = "[0:v]", outLabel = "[vout]"): string {
  const { w, h } = out;
  const tail = `setsar=1,fps=${o.fps ?? 30},format=yuv420p`;
  if (fit === "cover") return `${inLabel}scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},${tail}${outLabel}`;
  if (fit === "contain") return `${inLabel}scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,${tail}${outLabel}`;
  const blur = o.blur ?? 28;
  const darken = o.darken ?? -0.14;
  return [
    `${inLabel}split=2[lf_bg][lf_fg]`,
    // Background: fill the frame, blur hard, darken a little so the foreground reads.
    `[lf_bg]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=${blur}:2,eq=brightness=${darken}:saturation=0.85[lf_bgb]`,
    // Foreground: the whole source, scaled to fit (never cropped), even dimensions for x264.
    `[lf_fg]scale=${w}:${h}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2[lf_fgs]`,
    `[lf_bgb][lf_fgs]overlay=(W-w)/2:(H-h)/2,${tail}${outLabel}`,
  ].join(";");
}

/** FFmpeg arguments that re-encode `input` to a 16:9 (or `out`) H.264 file without audio. */
export function landscapeArgs(input: string, output: string, fit: Fit, out: Size = LANDSCAPE, o: FitOpts = {}): string[] {
  return [
    "-hide_banner", "-loglevel", "error", "-y", "-i", input,
    "-filter_complex", fitGraph(fit, out, o), "-map", "[vout]", "-an",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", output,
  ];
}

export async function probeSize(ffprobe: string, file: string): Promise<Size> {
  const r = await run(ffprobe, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { timeoutMs: 60_000 });
  const [w, h] = r.stdout.trim().split(",").map(Number);
  return { w: w || 0, h: h || 0 };
}

/**
 * Makes `input` landscape when it is not (Shorts, square clips): writes `output` and returns the fit
 * used, or null when the file was already 16:9-ish and was left alone.
 */
export async function ensureLandscape(ffmpeg: string, ffprobe: string, input: string, output: string, out: Size = LANDSCAPE): Promise<{ fit: Fit; src: Size } | null> {
  const src = await probeSize(ffprobe, input);
  const fit = chooseFit(src, out);
  if (fit === "cover") return null;
  const r = await run(ffmpeg, landscapeArgs(input, output, fit, out), { timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(`landscape conversion failed: ${r.stderr.slice(-200)}`);
  return { fit, src };
}
