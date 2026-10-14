import { run } from "../lib/exec.js";

/**
 * Music ducking (repo study, prototype C): the voice drives a sidechain compressor on the music,
 * so the music drops ~14 dB under speech and comes back in the gaps. release=400 ms avoids pumping
 * between words. Only used when a music file is given; without one the voice is used as is.
 *
 *   [music] volume -> loop/trim -> fade in 2 s / out 3 s -> sidechaincompress(key = voice) -> amix
 */
export const DUCK = { threshold: 0.02, ratio: 10, attack: 20, release: 400 } as const;

export interface DuckGraphOpts {
  /** Filter chain that yields the voice (no output label), e.g. "[1:a]aresample=48000,...". */
  voiceChain: string;
  /** Input label of the music, e.g. "[2:a]". */
  musicIn: string;
  duration: number;
  /** Music level before ducking (dB). */
  volumeDb: number;
  /** Output label (without brackets). */
  out: string;
}

/** filter_complex fragment: voice + ducked music -> [out]. */
export function duckGraph(o: DuckGraphOpts): string {
  const D = o.duration.toFixed(3);
  return [
    `${o.voiceChain},asplit=2[dvo][dkey]`,
    `${o.musicIn}aresample=48000,aformat=channel_layouts=stereo,volume=${o.volumeDb}dB,atrim=0:${D},asetpts=PTS-STARTPTS,afade=t=in:d=2,afade=t=out:st=${Math.max(0, o.duration - 3).toFixed(3)}:d=3[dmb]`,
    `[dmb][dkey]sidechaincompress=threshold=${DUCK.threshold}:ratio=${DUCK.ratio}:attack=${DUCK.attack}:release=${DUCK.release}:makeup=1[dduck]`,
    `[dvo][dduck]amix=inputs=2:duration=first:normalize=0[${o.out}]`,
  ].join(";");
}

/** Standalone helper: voice + music file -> ducked mix (wav/m4a). Music is looped to the voice length. */
export async function duckFiles(ff: string, voice: string, music: string, out: string, duration: number, volumeDb = -9): Promise<boolean> {
  const g = duckGraph({ voiceChain: "[0:a]aresample=48000,aformat=channel_layouts=stereo", musicIn: "[1:a]", duration, volumeDb, out: "mix" });
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", voice, "-stream_loop", "-1", "-i", music, "-filter_complex", `${g};[mix]alimiter=limit=0.95[a]`, "-map", "[a]", "-t", duration.toFixed(3), out]);
  return r.code === 0;
}
