import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { voiceCleanupFilter } from "../../audio/voiceCleanup.js";
import { toNumber } from "../../domain/rational.math.js";
import { AudioClip, clipEnd, MultiTrackTimeline } from "../../domain/timeline.types.js";
import { run } from "../../lib/exec.js";
import { ffmpegPath } from "../../lib/tools.js";
import { EditError } from "../state/projectStore.js";

/**
 * A few seconds of the voiceover at the playhead, as the studio's before / after comparison for the
 * voice cleanup: "original" is the voice file as it is, "cleaned" runs the same filter chain the
 * render puts on the voice. Samples are small WAVs cached in <project>/cache/voice_samples.
 */

export const SAMPLE_SECONDS = { default: 8, max: 20 } as const;
export const sampleDir = (projectDir: string) => path.join(projectDir, "cache", "voice_samples");

export async function voiceSample(tl: MultiTrackTimeline, projectDir: string, o: { frame: number; seconds?: number; cleaned: boolean }): Promise<{ name: string; seconds: number }> {
  const ff = ffmpegPath();
  if (!ff) throw new EditError("FFmpeg not found");
  const filter = o.cleaned ? voiceCleanupFilter(tl.settings?.voice) : "";
  if (o.cleaned && !filter) throw new EditError("switch at least one cleanup option on first");
  const fps = toNumber(tl.fps);
  const at = o.frame / fps;
  const clips = tl.tracks.filter((t) => t.kind === "voiceover").flatMap((t) => t.clips).filter((c): c is AudioClip => c.kind === "audio");
  // The voice piece under the playhead (the voice is in pieces after cuts), else the first one.
  const clip = clips.find((c) => at >= toNumber(c.start) && at < toNumber(clipEnd(c))) ?? clips[0];
  if (!clip) throw new EditError("this timeline has no voiceover");
  if (!fs.existsSync(clip.media.path)) throw new EditError("the voiceover file is missing");
  const into = Math.max(0, Math.min(at - toNumber(clip.start), toNumber(clip.duration) - 1));
  const seconds = Math.max(1, Math.min(o.seconds ?? SAMPLE_SECONDS.default, SAMPLE_SECONDS.max, toNumber(clip.duration) - into));
  const start = toNumber(clip.media.sourceIn) + into;

  const dir = sampleDir(projectDir);
  fs.mkdirSync(dir, { recursive: true });
  const key = crypto.createHash("sha1").update(`${clip.media.path}|${fs.statSync(clip.media.path).mtimeMs}|${start.toFixed(2)}|${seconds.toFixed(2)}|${filter}`).digest("hex").slice(0, 16);
  const name = `${o.cleaned ? "cleaned" : "original"}_${key}.wav`;
  if (fs.existsSync(path.join(dir, name))) return { name, seconds };
  const chain = ["aresample=48000", "aformat=channel_layouts=stereo", ...(filter ? [filter] : [])].join(",");
  const r = await run(ff, ["-v", "error", "-y", "-ss", start.toFixed(3), "-t", seconds.toFixed(3), "-i", clip.media.path, "-af", chain, "-c:a", "pcm_s16le", path.join(dir, name)], { timeoutMs: 120_000 });
  if (r.code !== 0 || !fs.existsSync(path.join(dir, name))) throw new EditError(`could not make the sample: ${r.stderr.slice(-160)}`);
  return { name, seconds };
}

/** A sample file by name (plain file names only), or null. */
export function sampleFile(projectDir: string, name: string): string | null {
  const f = path.join(sampleDir(projectDir), path.basename(name));
  return path.basename(name) === name && fs.existsSync(f) ? f : null;
}
