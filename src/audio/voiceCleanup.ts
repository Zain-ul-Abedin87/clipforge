/**
 * Voice cleanup for the voiceover: rumble filter, noise reduction, evening out the level and
 * normalizing the voice's loudness. Off by default; chosen per video in the studio (timeline
 * settings.voice). The result is one FFmpeg filter chain that the render puts on the voice before it
 * is mixed with the music and effects, and that the studio's voice sample plays for comparison.
 */

export type Denoise = "off" | "light" | "strong";

export interface VoiceCleanup {
  denoise: Denoise;
  /** High-pass at 80 Hz: removes rumble, desk thumps and mains hum. */
  rumble: boolean;
  /** Gentle compression: quiet and loud words end up closer in level. */
  even: boolean;
  /** Normalize the voice to about -16 LUFS before mixing (the final video is still set to -14 LUFS). */
  loudness: boolean;
}

export const NO_CLEANUP: VoiceCleanup = { denoise: "off", rumble: false, even: false, loudness: false };

export const DENOISE_LEVELS: readonly Denoise[] = ["off", "light", "strong"];

/** Validates a client's settings; anything unknown keeps the value of `base` (default: all off). */
export function parseVoiceCleanup(raw: unknown, base: VoiceCleanup = NO_CLEANUP): VoiceCleanup {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    denoise: DENOISE_LEVELS.includes(r.denoise as Denoise) ? (r.denoise as Denoise) : base.denoise,
    rumble: typeof r.rumble === "boolean" ? r.rumble : base.rumble,
    even: typeof r.even === "boolean" ? r.even : base.even,
    loudness: typeof r.loudness === "boolean" ? r.loudness : base.loudness,
  };
}

/** The FFmpeg audio filter chain for these settings; "" when nothing is switched on. */
export function voiceCleanupFilter(c: Partial<VoiceCleanup> | null | undefined): string {
  if (!c) return "";
  const chain: string[] = [];
  if (c.rumble) chain.push("highpass=f=80");
  if (c.denoise === "light") chain.push("afftdn=nr=10:nf=-40:tn=1");
  if (c.denoise === "strong") chain.push("afftdn=nr=20:nf=-35:tn=1");
  if (c.even) chain.push("acompressor=threshold=-21dB:ratio=3:attack=15:release=200:makeup=3");
  if (c.loudness) chain.push("loudnorm=I=-16:TP=-1.5:LRA=9");
  return chain.join(",");
}
