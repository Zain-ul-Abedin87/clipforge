import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { paths } from "../paths.js";
import { LineWorker, Spawn } from "./worker.js";

/**
 * Kokoro-82M (Apache-2.0), the default local voice: fast on the CPU (~20-50x real time), so it
 * never competes with the LLM for VRAM. Two ways to run it:
 *  - KOKORO_URL: a Kokoro-FastAPI server (OpenAI-compatible POST /v1/audio/speech);
 *  - else python/kokoro_tts.py with kokoro-onnx (models/kokoro/kokoro-v1.0.onnx + voices-v1.0.bin).
 */

export interface KokoroConfig {
  provider: "kokoro";
  url?: string;
  python: string;
  model: string;
  voices: string;
  voice: string;
  speed: number;
  /** kokoro-onnx language code for a language version (es, fr-fr, it, pt-br, hi); unset = English. */
  lang?: string;
}

export const KOKORO_DEFAULTS = {
  model: path.join(paths.root, "models", "kokoro", "kokoro-v1.0.onnx"),
  voices: path.join(paths.root, "models", "kokoro", "voices-v1.0.bin"),
};

/** Kokoro is usable when a server URL is set or both model files are on disk. */
export const kokoroInstalled = (get: (n: string, f?: string) => string) => !!get("KOKORO_URL") || (fs.existsSync(get("KOKORO_MODEL") || KOKORO_DEFAULTS.model) && fs.existsSync(get("KOKORO_VOICES") || KOKORO_DEFAULTS.voices));

let worker: { key: string; w: LineWorker } | null = null;
let spawnImpl: Spawn | undefined;
/** Tests: replace the python process. */
export const setKokoroSpawn = (s: Spawn | undefined) => {
  spawnImpl = s;
  worker?.w.close();
  worker = null;
};

export async function kokoroSpeak(c: KokoroConfig, text: string, fetchImpl: typeof fetch = fetch): Promise<Buffer> {
  if (c.url) {
    const res = await fetchImpl(`${c.url.replace(/\/+$/, "")}/v1/audio/speech`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "kokoro", input: text, voice: c.voice, speed: c.speed, response_format: "wav" }),
    });
    if (!res.ok) throw new Error(`Kokoro server ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return Buffer.from(await res.arrayBuffer());
  }
  const key = `${c.python}|${c.model}|${c.voices}`;
  if (worker?.key !== key) {
    worker?.w.close();
    worker = { key, w: new LineWorker(c.python, [path.join(paths.python, "kokoro_tts.py"), c.model, c.voices], spawnImpl) };
  }
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-kokoro-")), "s.wav");
  try {
    await worker.w.request({ text, out, voice: c.voice, speed: c.speed, ...(c.lang ? { lang: c.lang } : {}) });
    return fs.readFileSync(out);
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
}

export const closeKokoro = () => {
  worker?.w.close();
  worker = null;
};
