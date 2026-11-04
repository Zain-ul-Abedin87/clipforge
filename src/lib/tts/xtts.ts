import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "../paths.js";
import { LineWorker, Spawn } from "./worker.js";

/**
 * XTTS-v2 voice cloning, OWN VOICE ONLY: the speaker sample must be a recording of you, kept in
 * channels/<channel>/voice/ (anything else is refused). Runs on the GPU (~2-3 GB): the LLM is
 * unloaded first. Licence: Coqui Public Model License (non-commercial unless you buy a licence).
 */

export interface XttsConfig {
  provider: "xtts";
  python: string;
  speakerWav: string;
  language: string;
}

/** The sample must live in a channel's own voice folder (channels/<id>/voice/). */
export function ownVoiceSample(file: string): { ok: boolean; reason?: string } {
  if (!file) return { ok: false, reason: "no speaker sample set (features.json tts.xttsSpeakerWav)" };
  const abs = path.resolve(paths.root, file);
  if (!fs.existsSync(abs)) return { ok: false, reason: `speaker sample not found: ${abs}` };
  const rel = path.relative(paths.channels, abs).split(path.sep);
  if (rel[0] === ".." || rel.length < 3 || rel[1] !== "voice") return { ok: false, reason: `XTTS is for your own voice only: put your recording in channels/<channel>/voice/ (got ${abs})` };
  return { ok: true };
}

let worker: { key: string; w: LineWorker } | null = null;
let spawnImpl: Spawn | undefined;
export const setXttsSpawn = (s: Spawn | undefined) => {
  spawnImpl = s;
  worker?.w.close();
  worker = null;
};

export async function xttsSpeak(c: XttsConfig, text: string): Promise<Buffer> {
  const key = `${c.python}|${c.speakerWav}|${c.language}`;
  if (worker?.key !== key) {
    worker?.w.close();
    worker = { key, w: new LineWorker(c.python, [path.join(paths.python, "xtts_tts.py"), path.resolve(paths.root, c.speakerWav), c.language], spawnImpl, 20 * 60_000) };
  }
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-xtts-")), "s.wav");
  try {
    await worker.w.request({ text, out });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

export const closeXtts = () => {
  worker?.w.close();
  worker = null;
};
