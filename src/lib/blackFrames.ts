import { run } from "./exec.js";

/** Black stretches in a video (seconds), from FFmpeg blackdetect on a downscaled copy. */
export async function blackSpans(ff: string, file: string, minDur = 0.1): Promise<{ s: number; e: number }[]> {
  const r = await run(ff, ["-hide_banner", "-nostats", "-loglevel", "info", "-i", file, "-an", "-vf", `scale=160:-2,blackdetect=d=${minDur}:pix_th=0.10`, "-f", "null", "-"], { timeoutMs: 60_000 });
  return [...r.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+)/g)].map((m) => ({ s: +m[1], e: +m[2] }));
}

export const hitsBlack = (blacks: { s: number; e: number }[], from: number, len: number) => blacks.some((b) => b.e > from && b.s < from + len);

/** Longest stretch of [0, total) with no black (a little margin around each black part). */
export function longestClean(blacks: { s: number; e: number }[], total: number, margin = 0.05): { start: number; end: number } {
  let best = { start: 0, end: 0 };
  let at = 0;
  for (const b of [...blacks].sort((x, y) => x.s - y.s)) {
    const end = Math.max(at, b.s - margin);
    if (end - at > best.end - best.start) best = { start: at, end };
    at = Math.max(at, b.e + margin);
  }
  if (total - at > best.end - best.start) best = { start: at, end: total };
  return best;
}
