import { ENGINES } from "./engines.js";

/**
 * LivePortrait: natural head motion and expressions from a DRIVING VIDEO (features.json
 * avatar.drivingVideo), ~4 GB VRAM. It does not read the audio, so the lips only match when the
 * driving clip says the same words; for lip-sync to the voiceover use MuseTalk (default), or run
 * Wav2Lip on LivePortrait's output (avatar.command can chain both).
 * Setup: git clone https://github.com/KwaiVGI/LivePortrait into avatar.engineDir + its weights.
 */
export const LIVEPORTRAIT = ENGINES.liveportrait;
