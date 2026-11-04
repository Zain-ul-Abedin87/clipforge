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

const RULES: [RegExp, Hint][] = [
  [/YOUTUBE_API_KEY is not set/i, { title: "YouTube API key missing", fix: "Add your free YouTube Data API v3 key as YOUTUBE_API_KEY in the .env file, then try again. Research is optional: you can also skip it and type your topic.", where: "/research" }],
  [/quota/i, { title: "YouTube quota used up for today", fix: "The free daily YouTube quota is used up. It resets at midnight Pacific time; results already found stay available." }],
  [/Qwen not reachable|Ollama|ECONNREFUSED.*11434/i, { title: "The local AI (Ollama) is not running", fix: "Start Ollama from the Start menu, wait a few seconds, then press Retry." }],
  [/model .* not found|ollama pull/i, { title: "An AI model is not downloaded", fix: "Open a terminal and run the 'ollama pull' command shown in the log, then press Retry." }],
  [/No TTS voice is set up|Kokoro needs its model files|TTS_PROVIDER/i, { title: "No voice engine set up", fix: "Set up the free Kokoro voice (see Tools > Voice), or upload your own voiceover on the Create page.", where: "/tools" }],
  [/own voice only/i, { title: "Voice cloning needs your own recording", fix: "Put a clean 10-30 second recording of your own voice in channels/<channel>/voice/ and select it in Tools > Voice.", where: "/tools" }],
  [/script\.txt missing|Mode B needs a script/i, { title: "No script yet", fix: "Write and approve the script first (step 3)." }],
  [/no avatar photo/i, { title: "No avatar photo", fix: "Add one photo of the presenter as channels/<channel>/avatar.png, or switch the avatar off in Tools > AI avatar.", where: "/tools" }],
  [/avatar.*(engine exit|failed)/i, { title: "The avatar engine failed", fix: "Check the MuseTalk folder and Python in Tools > AI avatar, or switch the avatar off for this video.", where: "/tools" }],
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
  for (const [re, h] of RULES) if (re.test(text)) return h;
  if (!error) return null;
  const last = [...log].reverse().find((l) => /error|failed|missing|not found/i.test(l));
  return { title: "This step did not finish", fix: last ? `The last message was: "${last.slice(0, 200)}". Press Retry; if it fails again, open the Pipeline page for the full log.` : "Press Retry; if it fails again, open the Pipeline page for the full log." };
}
