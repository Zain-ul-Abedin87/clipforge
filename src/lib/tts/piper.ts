import fs from "node:fs";

/**
 * Piper (MIT, local, CPU): a .onnx voice + the piper program. The engine itself lives in
 * src/lib/tts.ts (piperChunk, one process per sentence: piper starts in well under a second).
 * This module only answers "is it set up?" for the engine picker and the Tools page.
 */
export function piperInstalled(get: (n: string, f?: string) => string, onPath: (bin: string) => string | null): { ok: boolean; detail: string } {
  const model = get("PIPER_MODEL");
  const bin = get("PIPER_PATH") || onPath("piper");
  if (!model) return { ok: false, detail: "PIPER_MODEL (a .onnx voice) is not set in .env" };
  if (!fs.existsSync(model)) return { ok: false, detail: `PIPER_MODEL does not exist: ${model}` };
  if (!bin) return { ok: false, detail: "piper is not on PATH (set PIPER_PATH)" };
  return { ok: true, detail: `piper ${model}` };
}
