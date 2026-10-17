/**
 * The three authoritative input modes of a project:
 * - A: voiceover only. Whisper's transcript (after glossary fixes) is the text; the audio is the timing.
 * - B: script only. The approved script is the text; TTS (src/lib/tts.ts) makes the audio.
 * - C: script + voiceover. The uploaded voiceover is the timing source; the script is aligned to it
 *      and every difference is reported as a discrepancy (src/lib/align.ts findDiscrepancies).
 */
export type InputMode = "A" | "B" | "C";

export const INPUT_MODE_LABELS: Record<InputMode, string> = {
  A: "Mode A - voiceover only (transcript is the text)",
  B: "Mode B - script only (TTS narration)",
  C: "Mode C - script + voiceover (audio is the timing source)",
};

/** Mode from what the user supplied. A TTS file made from the script does not count as an upload. */
export function resolveInputMode(i: { hasUploadedAudio: boolean; hasScript: boolean }): InputMode | null {
  if (i.hasUploadedAudio && i.hasScript) return "C";
  if (i.hasUploadedAudio) return "A";
  if (i.hasScript) return "B";
  return null;
}

/** The older project.json voiceMode field ("voice" | "tts" | "both") mapped to a mode. */
export function modeFromVoiceMode(v: unknown): InputMode | null {
  return v === "voice" ? "A" : v === "tts" ? "B" : v === "both" ? "C" : null;
}
