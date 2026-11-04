import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { fingerprint, projectDir, readJson, writeJson } from "../lib/project.js";
import { resolveTtsConfigFor, TtsConfigError } from "../lib/tts.js";
import { languageSpec } from "../lib/localize/languages.js";
import { alignedFromChunks, synthesizeUnits } from "../lib/ttsChunks.js";
import { applyWordEdits } from "../lib/wordEdits.js";
import { closeEngines, loudnorm } from "../lib/tts/index.js";
import { loadFeatures } from "../lib/settings/features.js";

export interface TtsOpts {
  project: string;
  script?: string;
  glossary?: string;
  force?: boolean;
}

/**
 * Mode B: script -> narration with the configured TTS provider, one cached request per sentence
 * (lib/ttsChunks.ts). Writes workspace/<project>/voiceover_tts.wav, tts_chunks.json (every
 * sentence's time on the track), aligned.json + words.json from those times (Whisper is not
 * needed), tts_payload.txt and tts.json, and points project.json at the new audio.
 * The script file itself is only read.
 */
export async function tts(opts: TtsOpts, log: (m: string) => void = console.log): Promise<number> {
  const dir = projectDir(opts.project);
  const scriptFile = opts.script ? path.resolve(opts.script) : path.join(dir, "script.txt");
  if (!fs.existsSync(scriptFile)) {
    log(`[tts] ${scriptFile} missing. Mode B needs a script.`);
    return 1;
  }
  // A language version speaks its own language with its own voice (resolveTtsConfigFor).
  const pjFile = path.join(dir, "project.json");
  const lang = languageSpec(fs.existsSync(pjFile) ? readJson<{ language?: string }>(pjFile).language : "en");
  let config;
  try {
    config = resolveTtsConfigFor(lang.code);
  } catch (err) {
    if (err instanceof TtsConfigError) {
      log(`[tts] CONFIGURATION ERROR: ${err.message}`);
      return 2;
    }
    throw err;
  }
  // Pronunciations are per language: English spoken forms must not end up in a German voiceover.
  const glossaryFile = opts.glossary ? path.resolve(opts.glossary) : path.join(paths.inputs, lang.code === "en" ? "glossary.txt" : `glossary.${lang.code}.txt`);
  if (lang.code !== "en") log(`[tts] ${lang.name} voice (${config.provider}); pronunciations from ${path.basename(glossaryFile)}${fs.existsSync(glossaryFile) ? "" : " (none yet)"}`);
  const script = fs.readFileSync(scriptFile, "utf8");
  const scriptHash = crypto.createHash("sha256").update(script).digest("hex");
  const out = path.join(dir, "voiceover_tts.wav");
  if (config.provider === "windows") log("[tts] using the computer's built-in voice (set TTS_PROVIDER for a natural voice)");
  // --force re-synthesises every sentence of this script (its shared cache entries are replaced).
  const t0 = Date.now();
  let m;
  try {
    m = await synthesizeUnits({ script, outFile: out, config, glossaryFile, cacheDir: path.join(paths.root, "cache", "tts"), force: opts.force, log });
  } finally {
    closeEngines(); // the Kokoro / XTTS Python workers keep their model loaded until here
  }
  const secs = (Date.now() - t0) / 1000;
  log(`[tts] ${config.provider}: ${(m.duration / 60).toFixed(1)} min of voice in ${(secs / 60).toFixed(1)} min (${(m.duration / Math.max(secs, 0.001)).toFixed(1)}x real time)`);
  // Loudness: the whole voiceover to features.json tts.lufs (default -14 LUFS); timings unchanged.
  await loudnorm(out, loadFeatures().tts.lufs, log);
  const { synthesized, reused, ...manifest } = m;
  writeJson(path.join(dir, "tts_chunks.json"), manifest);
  writeModeBTimings(dir, manifest);
  fs.writeFileSync(path.join(dir, "tts_payload.txt"), m.units.map((u) => u.payload).join("\n"));
  writeJson(path.join(dir, "tts.json"), { key: { provider: config.provider, scriptHash, glossary: fingerprint(glossaryFile) }, provider: config.provider, sentences: m.units.length, synthesized, reused, duration: m.duration, scriptFile, createdAt: new Date().toISOString() });
  setProjectAudio(dir, out);
  log(`[tts] ${config.provider}: ${m.units.length} sentence(s), ${reused} reused, ${synthesized} new, ${m.duration.toFixed(1)} s -> ${out}`);
  return 0;
}

/** aligned.json + words.json from the sentence times (hand word corrections from the review page kept). */
export function writeModeBTimings(dir: string, manifest: Parameters<typeof alignedFromChunks>[0]): void {
  const aligned = alignedFromChunks(manifest);
  if (applyWordEdits(dir, aligned.words)) {
    for (const st of aligned.sentences) st.text = aligned.words.slice(st.firstWord, st.lastWord + 1).map((w) => w.word).join(" ");
  }
  writeJson(path.join(dir, "aligned.json"), aligned);
  writeJson(path.join(dir, "words.json"), aligned.words.map((w) => ({ word: w.word, start: w.start, end: w.end, prob: 1 })));
  fs.rmSync(path.join(dir, "discrepancies.json"), { force: true });
}

function setProjectAudio(dir: string, audio: string): void {
  const file = path.join(dir, "project.json");
  const cur = fs.existsSync(file) ? readJson<Record<string, unknown>>(file) : { name: path.basename(dir) };
  fs.writeFileSync(file, JSON.stringify({ ...cur, audio, originalFilename: path.basename(audio), voiceMode: "tts", inputMode: "B" }, null, 2));
}
