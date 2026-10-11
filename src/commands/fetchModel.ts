import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { env } from "../lib/env.js";
import { paths } from "../lib/paths.js";

// Official CTranslate2 conversions on Hugging Face. sha256 = the LFS object id of model.bin.
const MODELS: Record<string, { repo: string; sha256: string }> = {
  "large-v3-turbo": {
    repo: "mobiuslabsgmbh/faster-whisper-large-v3-turbo",
    sha256: "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da",
  },
};
const SMALL_FILES = ["config.json", "preprocessor_config.json", "tokenizer.json", "vocabulary.json"];

export const localModelDir = (name: string) => path.join(paths.root, "models", name);

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

/**
 * Downloads a Whisper model with curl.exe: resumable (-C -), retries on stalls, verifies sha256.
 * The huggingface_hub downloader hung repeatedly on this network; curl resumes where it stopped.
 */
export async function fetchModel(name = env("WHISPER_MODEL", "large-v3-turbo")): Promise<number> {
  const m = MODELS[name];
  if (!m) {
    console.error(`No download recipe for "${name}". Known: ${Object.keys(MODELS).join(", ")}`);
    return 1;
  }
  const dir = localModelDir(name);
  fs.mkdirSync(dir, { recursive: true });
  const base = `https://huggingface.co/${m.repo}/resolve/main`;
  const auth = env("HF_TOKEN") ? ["-H", `Authorization: Bearer ${env("HF_TOKEN")}`] : [];
  const curl = ["-L", "--fail", "--silent", "--show-error", "--connect-timeout", "20",
    // Abort a transfer that drops under 20 KB/s for 45 s, then the loop below resumes it.
    "--speed-limit", "20000", "--speed-time", "45", ...auth];

  for (const f of SMALL_FILES) {
    if (fs.existsSync(path.join(dir, f))) continue;
    const r = await run("curl.exe", [...curl, "-o", path.join(dir, f), `${base}/${f}`]);
    if (r.code !== 0) {
      console.error(`download failed: ${f}\n${r.stderr}`);
      return 1;
    }
  }

  const final = path.join(dir, "model.bin");
  const part = path.join(dir, "model.bin.part");
  if (fs.existsSync(final)) {
    console.log(`[fetch-model] ${final} already present`);
    return 0;
  }

  for (let attempt = 1; attempt <= 200; attempt++) {
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    console.log(`[fetch-model] attempt ${attempt}: resuming at ${(have / 1024 / 1024).toFixed(0)} MB`);
    const r = await run("curl.exe", [...curl, "-C", "-", "-o", part, `${base}/model.bin`]);
    if (r.code === 0) break;
    // 33 = server refused the range, usually because the file is already complete.
    if (r.code === 33) break;
    console.log(`[fetch-model] curl exit ${r.code}: ${r.stderr.trim().split("\n").pop()} - retrying`);
  }

  console.log(`[fetch-model] verifying sha256 ...`);
  const got = await sha256(part);
  if (got !== m.sha256) {
    console.error(`[fetch-model] checksum mismatch (got ${got}). Delete ${part} and run again.`);
    return 1;
  }
  fs.renameSync(part, final);
  console.log(`[fetch-model] OK -> ${dir}`);
  return 0;
}
