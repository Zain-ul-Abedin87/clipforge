import fs from "node:fs";
import { FPS_30, FrameRate, frameToSeconds, rat, Rational, toFixed } from "../../domain/rational.math.js";

/**
 * Fast stitching with FFmpeg's concat demuxer. Every entry carries an explicit `duration` computed
 * exactly from its frame count (rational math): without it the demuxer drops the last frame's
 * duration of each segment and the picture drifts ~1 frame per scene ahead of the voice (seconds
 * over a 20-minute video). Segments that share one encoder are stream-copied; mixed encoders
 * (NVENC + x264 fallbacks) are re-encoded once.
 */

export interface ConcatEntry {
  file: string;
  /** Frames of this segment at the timeline's frame rate. */
  frames: number | bigint;
}

const quote = (f: string) => `'${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`;

/** The concat list: `file '<path>'` + `duration <exact seconds>` per segment. */
export function concatList(entries: ConcatEntry[], fps: FrameRate | number = FPS_30): string {
  const rate = typeof fps === "number" ? rat(fps) : fps;
  return entries.map((e) => `file ${quote(e.file)}\nduration ${toFixed(frameToSeconds(BigInt(e.frames), rate), 6)}`).join("\n") + "\n";
}

/** Exact total length of the entries, in seconds. */
export function totalDuration(entries: ConcatEntry[], fps: FrameRate = FPS_30): Rational {
  const frames = entries.reduce((a, e) => a + BigInt(e.frames), 0n);
  return frameToSeconds(frames, fps);
}

export function writeConcatList(file: string, entries: ConcatEntry[], fps: FrameRate | number = FPS_30): string {
  fs.writeFileSync(file, concatList(entries, fps));
  return file;
}

/** Input arguments for a concat list, plus the video codec: copy when all segments match, else one re-encode. */
export function concatInput(listFile: string, mixedEncoders: boolean): { input: string[]; videoCodec: string[] } {
  return {
    input: ["-f", "concat", "-safe", "0", "-i", listFile],
    videoCodec: mixedEncoders ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-profile:v", "high", "-pix_fmt", "yuv420p"] : ["-c:v", "copy"],
  };
}

/** "-t" value for the final mux: the exact cut length, 6 decimals (never a rounded float sum). */
export const muxDuration = (d: Rational) => toFixed(d, 6);
