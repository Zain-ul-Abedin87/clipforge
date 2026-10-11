import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { env } from "../lib/env.js";
import { paths } from "../lib/paths.js";
import { fingerprint, isCached, markDone, projectDir, projectNameFromAudio } from "../lib/project.js";
import { venvPythonPath } from "../lib/tools.js";
import { localModelDir } from "./fetchModel.js";

export interface TranscribeOpts {
  audio?: string;
  project?: string;
  glossary?: string;
  model?: string;
  force?: boolean;
}

export function defaultAudio(): string | null {
  for (const name of ["voiceover.mp3", "voiceover.wav", "voiceover.m4a"]) {
    const p = path.join(paths.inputs, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export async function transcribe(opts: TranscribeOpts): Promise<number> {
  const audio = opts.audio ? path.resolve(opts.audio) : defaultAudio();
  if (!audio || !fs.existsSync(audio)) {
    console.error("No audio found. Put inputs/voiceover.mp3 or pass --audio <file>.");
    return 1;
  }
  const py = venvPythonPath();
  if (!py) {
    console.error("Project venv missing. Run `clipforge doctor`.");
    return 1;
  }

  const project = opts.project ?? projectNameFromAudio(audio);
  const dir = projectDir(project);
  const glossary = opts.glossary ? path.resolve(opts.glossary) : path.join(paths.inputs, "glossary.txt");
  const modelName = opts.model ?? env("WHISPER_MODEL", "large-v3-turbo");
  // Prefer the curl-downloaded local copy (see fetch-model); fall back to Hugging Face download.
  const localDir = localModelDir(modelName);
  const model = fs.existsSync(path.join(localDir, "model.bin")) ? localDir : modelName;
  const inputs = {
    audio: fingerprint(audio),
    glossary: fingerprint(glossary),
    model: modelName,
    // A worker code change re-runs the merge; finished chunks are still reused.
    worker: fingerprint(path.join(paths.python, "transcribe.py")),
  };

  const projFile = path.join(dir, "project.json");
  const existing = fs.existsSync(projFile) ? JSON.parse(fs.readFileSync(projFile, "utf8")) : {};
  fs.writeFileSync(projFile, JSON.stringify({ ...existing, name: project, audio, glossary }, null, 2));

  if (!opts.force && isCached(dir, "transcribe", inputs, ["words.json"])) {
    console.log(`[transcribe] cached -> ${path.join(dir, "words.json")} (use --force to redo)`);
    return 0;
  }

  // --force starts over; otherwise finished chunks from an interrupted run are reused.
  if (opts.force) fs.rmSync(path.join(dir, "chunks"), { recursive: true, force: true });

  console.log(`[transcribe] ${audio}\n[transcribe] model=${model} project=${project}`);
  const baseArgs = [
    path.join(paths.python, "transcribe.py"),
    "--audio", audio,
    "--out-dir", dir,
    "--glossary", glossary,
    "--model", model,
    "--device", env("WHISPER_DEVICE", "cuda"),
    "--compute-type", env("WHISPER_COMPUTE_TYPE", "int8_float16"),
    "--models-dir", path.join(paths.root, "models"),
  ];

  // The GPU on this laptop sporadically hits cudaErrorIllegalInstruction. Each crash costs at most
  // one chunk: restart a fresh process, and move a chunk to CPU after it fails twice on the GPU.
  const failures = new Map<number, number>();
  const cpuChunks = new Set<number>();
  const MAX_RESTARTS = 15;
  for (let attempt = 0; ; attempt++) {
    const args = cpuChunks.size ? [...baseArgs, "--cpu-chunks", [...cpuChunks].join(",")] : baseArgs;
    const { code, lastChunk } = await runWorker(py, args);
    if (code === 0) break;
    if (lastChunk === null || attempt >= MAX_RESTARTS) {
      console.error(`[transcribe] FAILED (exit ${code})`);
      return code || 1;
    }
    const n = (failures.get(lastChunk) ?? 0) + 1;
    failures.set(lastChunk, n);
    if (n >= 2) cpuChunks.add(lastChunk);
    console.log(
      `[transcribe] worker crashed in chunk ${lastChunk} (exit ${code}); restarting` +
        (cpuChunks.has(lastChunk) ? " - this chunk will run on CPU" : " on GPU"),
    );
  }

  markDone(dir, "transcribe", inputs);
  console.log(`[transcribe] wrote ${path.join(dir, "words.json")}`);
  return 0;
}

function runWorker(py: string, args: string[]): Promise<{ code: number; lastChunk: number | null }> {
  return new Promise((resolve) => {
    let lastChunk: number | null = null;
    const child = spawn(py, args, {
      windowsHide: true,
      // Keep the Hugging Face cache inside the project folder, not on C:.
      env: {
        ...process.env,
        HF_HOME: path.join(paths.root, "models", "hf"),
        // The xet transfer backend stalled at 0 bytes on this network; plain HTTPS works.
        HF_HUB_DISABLE_XET: "1",
        HF_HUB_DISABLE_SYMLINKS_WARNING: "1",
        HF_HUB_DISABLE_TELEMETRY: "1",
        PYTHONUNBUFFERED: "1",
      },
    });
    let buf = "";
    child.stdout.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line);
          if (ev.event === "chunk_start") lastChunk = ev.index;
          if (ev.event === "progress") {
            console.log(`[transcribe] ${fmt(ev.position)} / ${fmt(ev.duration)}  (chunk ${ev.chunk}, ${ev.device})`);
          } else if (ev.event !== "chunk_start") {
            const { event, ...rest } = ev;
            console.log(`[transcribe] ${event} ${JSON.stringify(rest)}`);
          }
        } catch {
          console.log(line);
        }
      }
    });
    child.stderr.on("data", (d) => {
      const s = String(d);
      // Hide noisy progress bars and the native crash dump; the restart message explains it.
      if (!/it\/s|%\|/.test(s) && !/^(Extension modules|  File |Thread 0x|Fatal Python)/m.test(s)) process.stderr.write(s);
    });
    child.on("close", (c) => resolve({ code: c ?? 1, lastChunk }));
  });
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
