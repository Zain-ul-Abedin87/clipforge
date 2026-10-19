import { env } from "./env.js";
import { run } from "./exec.js";

/**
 * Video encoder choice for scene segments. VIDEO_ENCODER:
 *   auto (default) / h264_nvenc  NVENC when this machine can actually use it, else libx264
 *   libx264                      always CPU
 * "Can use it" is one tiny real NVENC encode per process: `ffmpeg -encoders` also lists
 * h264_nvenc on machines without an NVIDIA GPU or driver (every stock Linux / Docker FFmpeg),
 * where each attempt fails. During a render, NVENC that starts failing (driver hiccups) is
 * dropped for the rest of the render after a few failures instead of being retried per segment.
 */

export type Encoder = "nvenc" | "x264";

let probe: Promise<{ ok: boolean; why: string }> | null = null;

/** One 3-frame NVENC encode to the null muxer; cached for the process. */
export function nvencUsable(ff: string, runner: typeof run = run): Promise<{ ok: boolean; why: string }> {
  probe ??= runner(ff, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x144:r=30:d=0.1", "-frames:v", "3", "-c:v", "h264_nvenc", "-f", "null", "-"], { timeoutMs: 30_000 })
    .then((r) => ({ ok: r.code === 0, why: r.code === 0 ? "" : r.stderr.trim().split(/\r?\n/).pop()?.slice(0, 160) ?? `exit ${r.code}` }))
    .catch((e) => ({ ok: false, why: String(e?.message ?? e).slice(0, 160) }));
  return probe;
}

/** Test hook: forget the cached probe. */
export const resetEncoderProbe = () => {
  probe = null;
};

/** The encoder this render starts with. */
export async function resolveEncoder(ff: string, log: (m: string) => void = () => {}, runner: typeof run = run): Promise<Encoder> {
  const want = env("VIDEO_ENCODER", "auto").toLowerCase();
  if (want === "libx264" || want === "x264" || want === "cpu") return "x264";
  const p = await nvencUsable(ff, runner);
  if (p.ok) return "nvenc";
  log(`[render] NVENC not usable on this machine (${p.why || "no GPU"}); encoding with libx264 (CPU)`);
  return "x264";
}

/**
 * Per-render circuit breaker: NVENC gets one retry per segment while it mostly works; after
 * `maxFailures` NVENC failures in this render every remaining segment goes straight to libx264.
 */
export class EncoderPicker {
  private failures = 0;
  private tripped = false;

  constructor(private start: Encoder, private log: (m: string) => void = () => {}, private maxFailures = 3) {}

  /** Encoders to try, in order, for the next segment. */
  tries(): Encoder[] {
    return this.start === "nvenc" && !this.tripped ? ["nvenc", "nvenc", "x264"] : ["x264"];
  }

  failed(enc: Encoder): void {
    if (enc !== "nvenc" || this.tripped) return;
    if (++this.failures >= this.maxFailures) {
      this.tripped = true;
      this.log(`[render] NVENC failed ${this.failures} times: the remaining segments use libx264`);
    }
  }
}
