/**
 * Plain-English help for a failed step: what went wrong and what to do, instead of an exit code.
 * Matches the step's log lines against known problems; the first match wins.
 */

export interface Hint {
  title: string;
  fix: string;
  /** Where in the app to fix it (a page path), when there is one. */
  where?: string;
}

const RULES: [RegExp, Hint | ((m: RegExpMatchArray) => Hint)][] = [
  // Language versions (src/lib/tts.ts resolveTtsConfigFor): the message itself names the setting.
  [/(No (?!TTS\b)(\w[\w ()]*?) voice is set up\.[^\n]*|Kokoro has no (\w[\w ()]*?) voice\.[^\n]*|Set (?:KOKORO_VOICE|PIPER_MODEL|ELEVENLABS_VOICE_ID)_[A-Z]{2}[^\n]*)/, (m) => ({ title: `No ${m[2] ?? m[3] ?? "voice"} voice set up for this language version`, fix: `${m[1].replace(/^\[tts\]\s*(CONFIGURATION ERROR:\s*)?/, "")}${/German|_DE\b/.test(m[1]) ? " Free option: download the Piper voice de_DE-thorsten (high), put the .onnx and .onnx.json in models/piper/, add PIPER_MODEL_DE=models/piper/de_DE-thorsten-high.onnx to .env," : ""} Then press Retry.`, where: "/tools" })],
  [/is explainroo installed|explainroo check did not run|explainroo: (command )?not found|spawn explainroo ENOENT/i, { title: "explainroo is not set up", fix: "Explainer videos are made by explainroo (free, local). Install it once: git clone https://github.com/vincentsch/explainroo, then in that folder npm install and node bin/explainroo.js doctor --fetch. In Tools > Video types set explainroo to the path of bin/explainroo.js. Then press Retry.", where: "/tools" }],
  [/is argo installed|spawn argo ENOENT|argo: (command )?not found/i, { title: "argo is not set up", fix: "Tutorial videos are finished by argo (free, local). Install it once: npm install -g @argo-video/cli (needs Node 20+ and ffmpeg). Then press Retry.", where: "/tools" }],
  [/Upload the screen recording first/i, { title: "No screen recording yet", fix: "Upload your screen recording (MP4, MOV, WebM or MKV) in step 1, then press Write the voice-over." }],
  [/YOUTUBE_API_KEY is not set/i, { title: "YouTube API key missing", fix: "Add your free YouTube Data API v3 key as YOUTUBE_API_KEY in the .env file, then try again. Research is optional: you can also skip it and type your topic.", where: "/research" }],
  [/quota/i, { title: "YouTube quota used up for today", fix: "The free daily YouTube quota is used up. It resets at midnight Pacific time; results already found stay available." }],
  [/Qwen not reachable|Ollama|ECONNREFUSED.*11434/i, { title: "The local AI (Ollama) is not running", fix: "Start Ollama from the Start menu, wait a few seconds, then press Retry." }],
  [/model .* not found|ollama pull/i, { title: "An AI model is not downloaded", fix: "Open a terminal and run the 'ollama pull' command shown in the log, then press Retry." }],
  [/No TTS voice is set up|Kokoro needs its model files|TTS_PROVIDER/i, { title: "No voice engine set up", fix: "Set up the free Kokoro voice (see Tools > Voice), or upload your own voiceover on the Create page.", where: "/tools" }],
  [/own voice only/i, { title: "Voice cloning needs your own recording", fix: "Put a clean 10-30 second recording of your own voice in channels/<channel>/voice/ and select it in Tools > Voice.", where: "/tools" }],
  [/script\.txt missing|Mode B needs a script/i, { title: "No script yet", fix: "Write and approve the script first (step 3)." }],
  [/no avatar photo/i, { title: "No avatar photo", fix: "Add one photo of the presenter as channels/<channel>/avatar.png, or switch the avatar off in Tools > AI avatar.", where: "/tools" }],
  [/avatar.*(engine exit|failed)/i, { title: "The avatar engine failed", fix: "Check the MuseTalk folder and Python in Tools > AI avatar, or switch the avatar off for this video.", where: "/tools" }],
  [/venv missing|No module named ['"]?(faster_whisper|whisper|torch)/i, { title: "Speech recognition (Whisper) is not set up", fix: "ClipForge needs its Python part to listen to a recording. In the ClipForge folder run: python -m venv .venv, then .venv\\Scripts\\pip install -r python/requirements.txt, then press Retry." }],
  [/ffmpeg not found/i, { title: "FFmpeg is missing", fix: "Install FFmpeg (winget install Gyan.FFmpeg) and restart ClipForge." }],
  [/aligned\.json missing/i, { title: "Voice timings missing", fix: "Run the Voice step again; it creates the word timings." }],
  [/voiceover not found|upload audio first/i, { title: "No voiceover", fix: "Run the Voice step, or upload your own voiceover on the Create page." }],
  [/CUDA|out of memory|illegal memory/i, { title: "The graphics card ran out of memory", fix: "Close other GPU programs (games, browsers with video) and press Retry. ClipForge falls back to slower settings automatically." }],
  [/rate limit|429/i, { title: "A website is limiting requests", fix: "Wait a few minutes and press Retry." }],
  [/ENOSPC|no space left/i, { title: "The disk is full", fix: "Free some disk space and press Retry." }],
];

/** Hint for a failed step from its log (null when nothing is recognised). */
export function friendlyHint(log: string[], error?: string): Hint | null {
  const text = [...log.slice(-60), error ?? ""].join("\n");
  for (const [re, h] of RULES) {
    const m = text.match(re);
    if (m) return typeof h === "function" ? h(m) : h;
  }
  if (!error) return null;
  const last = [...log].reverse().find((l) => /error|failed|missing|not found/i.test(l));
  return { title: "This step did not finish", fix: last ? `The last message was: "${last.slice(0, 200)}". Press Retry; if it fails again, open the Pipeline page for the full log.` : "Press Retry; if it fails again, open the Pipeline page for the full log." };
}
