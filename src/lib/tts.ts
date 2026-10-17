import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { env } from "./env.js";
import { run } from "./exec.js";
import { applyPronunciations, loadPronunciations } from "./glossary.js";
import { ffmpegPath } from "./tools.js";

/**
 * Mode B (script only): the approved script is read by a real TTS engine. The script text is never
 * changed; glossary pronunciations ("Name = spoken form") are applied only to the payload sent to
 * the engine. Without a configured provider this throws TtsConfigError instead of faking a voice.
 */

/** "windows" = the computer's built-in voice (System.Speech): the default when TTS_PROVIDER is empty. */
export const TTS_PROVIDERS = ["elevenlabs", "openai", "piper", "windows"] as const;
export type TtsProvider = (typeof TTS_PROVIDERS)[number];

export class TtsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtsConfigError";
  }
}

export type TtsConfig =
  | { provider: "elevenlabs"; apiKey: string; voiceId: string; model: string }
  | { provider: "openai"; apiKey: string; voice: string; model: string; instructions?: string }
  | { provider: "piper"; binary: string; model: string }
  | { provider: "windows"; rate: number };

type EnvGet = (name: string, fallback?: string) => string;

/** Reads TTS_PROVIDER and that provider's settings; throws TtsConfigError when anything is missing. */
export function resolveTtsConfig(get: EnvGet = env): TtsConfig {
  // Nothing set: the computer's own voice, as before (robotic, fine for tests and drafts).
  const provider = get("TTS_PROVIDER").toLowerCase() || "windows";
  if (provider === "windows") {
    if (process.platform !== "win32") throw new TtsConfigError("The default computer voice needs Windows; set TTS_PROVIDER to elevenlabs, openai or piper.");
    const rate = Number(get("WINDOWS_TTS_RATE", "1"));
    return { provider, rate: Number.isFinite(rate) ? Math.max(-10, Math.min(10, Math.round(rate))) : 1 };
  }
  if (!(TTS_PROVIDERS as readonly string[]).includes(provider)) {
    throw new TtsConfigError(`Unknown TTS_PROVIDER "${provider}". Use one of: ${TTS_PROVIDERS.join(", ")}.`);
  }
  const need = (name: string, why: string) => {
    const v = get(name);
    if (!v) throw new TtsConfigError(`TTS_PROVIDER=${provider} needs ${name} in .env (${why}).`);
    return v;
  };
  if (provider === "elevenlabs") {
    return {
      provider,
      apiKey: need("ELEVENLABS_API_KEY", "API key from elevenlabs.io"),
      voiceId: need("ELEVENLABS_VOICE_ID", "the voice to read the script"),
      model: get("ELEVENLABS_MODEL", "eleven_multilingual_v2"),
    };
  }
  if (provider === "openai") {
    return {
      provider,
      apiKey: need("OPENAI_API_KEY", "API key from platform.openai.com"),
      voice: get("OPENAI_TTS_VOICE", "alloy"),
      model: get("OPENAI_TTS_MODEL", "gpt-4o-mini-tts"),
      instructions: get("OPENAI_TTS_INSTRUCTIONS") || undefined,
    };
  }
  const binary = need("PIPER_PATH", "path to the piper executable");
  const model = need("PIPER_MODEL", "path to a piper .onnx voice");
  if (!fs.existsSync(binary)) throw new TtsConfigError(`PIPER_PATH does not exist: ${binary}`);
  if (!fs.existsSync(model)) throw new TtsConfigError(`PIPER_MODEL does not exist: ${model}`);
  return { provider: "piper", binary, model };
}

/** Status for the UI / doctor, without throwing. */
export function ttsStatus(get: EnvGet = env): { configured: boolean; provider: string | null; detail: string } {
  try {
    const c = resolveTtsConfig(get);
    return { configured: true, provider: c.provider, detail: c.provider };
  } catch (err) {
    return { configured: false, provider: get("TTS_PROVIDER") || null, detail: (err as Error).message };
  }
}

/** Per-request character limits (with margin) of each engine. */
const CHUNK_CHARS: Record<TtsProvider, number> = { elevenlabs: 2400, openai: 3800, piper: 20000, windows: 20000 };

/** Splits text into chunks at sentence (then word) boundaries, each at most `max` characters. */
export function chunkText(text: string, max: number): string[] {
  const sentences = text.replace(/\r/g, "").split(/(?<=[.!?])\s+|\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const chunks: string[] = [];
  let cur = "";
  const push = () => {
    if (cur.trim()) chunks.push(cur.trim());
    cur = "";
  };
  for (const s of sentences) {
    if (s.length > max) {
      push();
      let part = "";
      for (const w of s.split(/\s+/)) {
        if ((part + " " + w).trim().length > max) {
          chunks.push(part.trim());
          part = "";
        }
        part += " " + w;
      }
      cur = part;
      continue;
    }
    if ((cur + " " + s).trim().length > max) push();
    cur += (cur ? " " : "") + s;
  }
  push();
  return chunks;
}

export interface SynthesizeOpts {
  /** The approved script, exactly as the user wrote it. */
  script: string;
  /** Output audio file (.mp3 for elevenlabs, .wav for openai / piper; see `ttsExtension`). */
  outFile: string;
  glossaryFile?: string | null;
  config?: TtsConfig;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  log?: (m: string) => void;
}

export interface SynthesizeResult {
  file: string;
  provider: TtsProvider;
  chunks: number;
  /** The text actually spoken (script with pronunciation overrides). */
  payload: string;
  overridesApplied: number;
}

export const ttsExtension = (p: TtsProvider) => (p === "elevenlabs" ? ".mp3" : ".wav");

export async function synthesize(opts: SynthesizeOpts): Promise<SynthesizeResult> {
  const config = opts.config ?? resolveTtsConfig();
  const log = opts.log ?? (() => {});
  const fetchImpl = opts.fetchImpl ?? fetch;
  const overrides = loadPronunciations(opts.glossaryFile);
  const payload = applyPronunciations(opts.script, overrides);
  const overridesApplied = Object.keys(overrides).filter((k) => applyPronunciations(opts.script, { [k]: overrides[k] }) !== opts.script).length;
  const chunks = chunkText(payload, CHUNK_CHARS[config.provider]);
  if (!chunks.length) throw new Error("script is empty - nothing to read");

  const tmpDir = `${opts.outFile}.parts`;
  fs.mkdirSync(tmpDir, { recursive: true });
  const ext = ttsExtension(config.provider);
  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const part = path.join(tmpDir, `part_${String(i).padStart(3, "0")}${ext}`);
    log(`[tts] ${config.provider}: chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    fs.writeFileSync(part, await speakChunk(config, chunks[i], fetchImpl));
    parts.push(part);
  }
  if (parts.length === 1) fs.copyFileSync(parts[0], opts.outFile);
  else await concatAudio(parts, opts.outFile);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  return { file: opts.outFile, provider: config.provider, chunks: chunks.length, payload, overridesApplied };
}

async function speakChunk(c: TtsConfig, text: string, fetchImpl: typeof fetch): Promise<Buffer> {
  if (c.provider === "piper") return piperChunk(c, text);
  if (c.provider === "windows") return windowsChunk(c, text);
  const req: { url: string; headers: Record<string, string>; body: Record<string, unknown> } =
    c.provider === "elevenlabs"
      ? {
          url: `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(c.voiceId)}?output_format=mp3_44100_128`,
          headers: { "xi-api-key": c.apiKey, "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: { text, model_id: c.model },
        }
      : {
          url: "https://api.openai.com/v1/audio/speech",
          headers: { Authorization: `Bearer ${c.apiKey}`, "Content-Type": "application/json" },
          body: { model: c.model, voice: c.voice, input: text, response_format: "wav", ...(c.instructions ? { instructions: c.instructions } : {}) },
        };
  for (let attempt = 1; ; attempt++) {
    const res = await fetchImpl(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    // Rate limits and server hiccups get two retries; auth / validation errors fail at once.
    if (attempt < 3 && (res.status === 429 || res.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new TtsConfigError(`${c.provider} rejected the API key (HTTP ${res.status}): ${detail}`);
    throw new Error(`${c.provider} TTS failed (HTTP ${res.status}): ${detail}`);
  }
}

/** The computer's built-in voice (Windows System.Speech) reads the text into a WAV. */
function windowsChunk(c: Extract<TtsConfig, { provider: "windows" }>, text: string): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-wintts-"));
  const txt = path.join(dir, "in.txt");
  const out = path.join(dir, "out.wav");
  fs.writeFileSync(txt, text, "utf8");
  const q = (p: string) => p.replace(/'/g, "''");
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ${c.rate}; ` +
    `$t = Get-Content -Raw -Encoding UTF8 '${q(txt)}'; $s.SetOutputToWaveFile('${q(out)}'); $s.Speak($t); $s.Dispose()`;
  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = code === 0 && fs.existsSync(out);
      const buf = ok ? fs.readFileSync(out) : null;
      fs.rmSync(dir, { recursive: true, force: true });
      if (buf) resolve(buf);
      else reject(new Error(`Windows voice failed (exit ${code}): ${err.trim().slice(-300)}`));
    });
  });
}

function piperChunk(c: Extract<TtsConfig, { provider: "piper" }>, text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-piper-")), "out.wav");
    const child = spawn(c.binary, ["--model", c.model, "--output_file", out], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(out)) {
        const buf = fs.readFileSync(out);
        fs.rmSync(path.dirname(out), { recursive: true, force: true });
        resolve(buf);
      } else reject(new Error(`piper failed (exit ${code}): ${err.trim().slice(-300)}`));
    });
    child.stdin.end(text);
  });
}

async function concatAudio(parts: string[], out: string): Promise<void> {
  const ff = ffmpegPath();
  if (!ff) throw new Error("ffmpeg not found (needed to join TTS chunks)");
  const list = `${out}.concat.txt`;
  fs.writeFileSync(list, parts.map((p) => `file '${p.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n") + "\n");
  const codec = out.endsWith(".mp3") ? ["-c:a", "libmp3lame", "-b:a", "192k"] : ["-c:a", "pcm_s16le"];
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, ...codec, out]);
  fs.rmSync(list, { force: true });
  if (r.code !== 0) throw new Error(`joining TTS chunks failed: ${r.stderr.slice(-300)}`);
}
