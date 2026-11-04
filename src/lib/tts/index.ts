import fs from "node:fs";
import { run } from "../exec.js";
import { ffmpegPath } from "../tools.js";
import { resolveTtsConfig, speakChunk, TtsConfig, TtsConfigError, TtsProvider } from "../tts.js";
import { closeKokoro } from "./kokoro.js";
import { closeXtts } from "./xtts.js";

/**
 * TTS engine interface. Local engines: kokoro (default, free, CPU), piper (free, CPU), xtts (own
 * voice only, GPU). Cloud engines (elevenlabs, openai) stay optional and off unless their keys are
 * set. Every engine speaks one sentence at a time (src/lib/ttsChunks.ts caches each sentence and
 * writes the timings that align.json is built from); the finished voiceover is loudness-normalised
 * with FFmpeg loudnorm.
 */

export interface TtsEngine {
  name: TtsProvider;
  local: boolean;
  speak(text: string): Promise<Buffer>;
  close(): void;
}

export const LOCAL_ENGINES: TtsProvider[] = ["kokoro", "piper", "xtts", "windows"];

export function engineFor(config: TtsConfig = resolveTtsConfig()): TtsEngine {
  return {
    name: config.provider,
    local: LOCAL_ENGINES.includes(config.provider),
    speak: (text) => speakChunk(config, text),
    close: () => {
      if (config.provider === "kokoro") closeKokoro();
      if (config.provider === "xtts") closeXtts();
    },
  };
}

/** Releases the Python workers (end of the tts step). */
export function closeEngines(): void {
  closeKokoro();
  closeXtts();
}

/**
 * EBU R128 loudness normalisation in place (default -14 LUFS, true peak -1.5 dB), sample rate and
 * length unchanged, so the sentence timings stay valid.
 */
export async function loudnorm(file: string, lufs = -14, log: (m: string) => void = () => {}): Promise<boolean> {
  const ff = ffmpegPath();
  if (!ff) throw new TtsConfigError("ffmpeg not found (needed for loudnorm)");
  const tmp = `${file}.loudnorm.wav`;
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-af", `loudnorm=I=${lufs}:TP=-1.5:LRA=11`, "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", tmp]);
  if (r.code !== 0 || !fs.existsSync(tmp)) {
    log(`[tts] loudnorm failed: ${r.stderr.slice(-200)}`);
    fs.rmSync(tmp, { force: true });
    return false;
  }
  fs.renameSync(tmp, file);
  log(`[tts] loudnorm: ${lufs} LUFS, true peak -1.5 dB`);
  return true;
}
