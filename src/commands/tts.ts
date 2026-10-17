import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { fingerprint, projectDir, readJson, writeJson } from "../lib/project.js";
import { resolveTtsConfig, synthesize, ttsExtension, TtsConfigError } from "../lib/tts.js";

export interface TtsOpts {
  project: string;
  script?: string;
  glossary?: string;
  force?: boolean;
}

/**
 * Mode B: script -> narration with the configured TTS provider. Writes workspace/<project>/voiceover_tts.*,
 * tts_payload.txt (what the engine read) and tts.json, and points project.json at the new audio.
 * The script file itself is only read.
 */
export async function tts(opts: TtsOpts, log: (m: string) => void = console.log): Promise<number> {
  const dir = projectDir(opts.project);
  const scriptFile = opts.script ? path.resolve(opts.script) : path.join(dir, "script.txt");
  if (!fs.existsSync(scriptFile)) {
    log(`[tts] ${scriptFile} missing. Mode B needs a script.`);
    return 1;
  }
  let config;
  try {
    config = resolveTtsConfig();
  } catch (err) {
    if (err instanceof TtsConfigError) {
      log(`[tts] CONFIGURATION ERROR: ${err.message}`);
      return 2;
    }
    throw err;
  }
  const glossaryFile = opts.glossary ? path.resolve(opts.glossary) : path.join(paths.inputs, "glossary.txt");
  const script = fs.readFileSync(scriptFile, "utf8");
  const scriptHash = crypto.createHash("sha256").update(script).digest("hex");
  const out = path.join(dir, `voiceover_tts${ttsExtension(config.provider)}`);
  const metaFile = path.join(dir, "tts.json");
  const voice = config.provider === "elevenlabs" ? config.voiceId : config.provider === "openai" ? config.voice : config.provider === "piper" ? config.model : `rate ${config.rate}`;
  const key = { provider: config.provider, scriptHash, glossary: fingerprint(glossaryFile), voice };
  if (config.provider === "windows") log("[tts] using the computer's built-in voice (set TTS_PROVIDER for a natural voice)");
  if (!opts.force && fs.existsSync(out) && fs.existsSync(metaFile)) {
    const prev = readJson<{ key?: unknown }>(metaFile);
    if (JSON.stringify(prev.key) === JSON.stringify(key)) {
      log(`[tts] cached -> ${out} (use --force to redo)`);
      setProjectAudio(dir, out);
      return 0;
    }
  }
  const r = await synthesize({ script, outFile: out, glossaryFile, config, log });
  fs.writeFileSync(path.join(dir, "tts_payload.txt"), r.payload);
  writeJson(metaFile, { key, provider: r.provider, chunks: r.chunks, overridesApplied: r.overridesApplied, scriptFile, createdAt: new Date().toISOString() });
  setProjectAudio(dir, out);
  log(`[tts] ${r.provider}: ${r.chunks} chunk(s), ${r.overridesApplied} pronunciation override(s) -> ${out}`);
  return 0;
}

function setProjectAudio(dir: string, audio: string): void {
  const file = path.join(dir, "project.json");
  const cur = fs.existsSync(file) ? readJson<Record<string, unknown>>(file) : { name: path.basename(dir) };
  fs.writeFileSync(file, JSON.stringify({ ...cur, audio, originalFilename: path.basename(audio), voiceMode: "tts", inputMode: "B" }, null, 2));
}
