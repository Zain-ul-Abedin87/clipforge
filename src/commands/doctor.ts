import fs from "node:fs";
import os from "node:os";
import { run } from "../lib/exec.js";
import { hasKey } from "../lib/env.js";
import { paths } from "../lib/paths.js";
import { stopYoutubeWorker, youtubeStatus } from "../lib/assets/youtube.js";
import { webCrawlerStatus } from "../lib/assets/webCrawler.js";
import { webCrawlStatus } from "../lib/assets/webCrawl.js";
import { libraryBackend, librarySize } from "../lib/assets/footageLibrary.js";
import { basePythonPath, ffmpegPath, ffprobePath, venvPythonPath } from "../lib/tools.js";
import { llmAvailable } from "../lib/agents/llm/llm.js";

type Status = "ok" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
}

const icon: Record<Status, string> = { ok: "[ OK ]", warn: "[WARN]", fail: "[FAIL]" };

async function firstLine(cmd: string, args: string[]): Promise<string> {
  const r = await run(cmd, args);
  return (r.stdout || r.stderr).split(/\r?\n/)[0].trim();
}

export async function doctor(): Promise<number> {
  const checks: Check[] = [];

  checks.push({ name: "Node", status: "ok", detail: process.version });

  const py = basePythonPath();
  checks.push(
    py
      ? { name: "Python", status: "ok", detail: `${await firstLine(py, ["--version"])}  (${py})` }
      : { name: "Python", status: "fail", detail: "Python 3.11 not found (winget install Python.Python.3.11)" },
  );

  const venv = venvPythonPath();
  checks.push(
    venv
      ? { name: "Project venv", status: "ok", detail: venv }
      : { name: "Project venv", status: "warn", detail: "not created yet (.venv)" },
  );

  const ff = ffmpegPath();
  const fp = ffprobePath();
  if (ff) {
    checks.push({ name: "FFmpeg", status: "ok", detail: `${await firstLine(ff, ["-version"])}  (${ff})` });
    const enc = await run(ff, ["-hide_banner", "-encoders"]);
    const nvenc = ["h264_nvenc", "hevc_nvenc"].filter((e) => enc.stdout.includes(e));
    checks.push(
      nvenc.length
        ? { name: "NVENC encoders", status: "ok", detail: nvenc.join(", ") }
        : { name: "NVENC encoders", status: "fail", detail: "ffmpeg build has no NVENC support" },
    );
  } else {
    checks.push({ name: "FFmpeg", status: "fail", detail: "not found (winget install Gyan.FFmpeg)" });
  }
  checks.push(
    fp ? { name: "FFprobe", status: "ok", detail: fp } : { name: "FFprobe", status: "fail", detail: "not found" },
  );

  const smi = await run("nvidia-smi", [
    "--query-gpu=name,driver_version,memory.total,memory.used",
    "--format=csv,noheader",
  ]);
  checks.push(
    smi.code === 0
      ? { name: "NVIDIA GPU", status: "ok", detail: smi.stdout.trim() }
      : { name: "NVIDIA GPU", status: "fail", detail: "nvidia-smi failed" },
  );

  const totalGb = os.totalmem() / 1024 ** 3;
  const freeGb = os.freemem() / 1024 ** 3;
  checks.push({
    name: "RAM",
    status: freeGb < 3 ? "warn" : "ok",
    detail: `${freeGb.toFixed(1)} GB free of ${totalGb.toFixed(1)} GB${freeGb < 3 ? " - close other apps before rendering" : ""}`,
  });

  const disk = fs.statfsSync(paths.root);
  const diskFreeGb = (disk.bavail * disk.bsize) / 1024 ** 3;
  checks.push({
    name: "Disk (project drive)",
    status: diskFreeGb < 20 ? "warn" : "ok",
    detail: `${diskFreeGb.toFixed(1)} GB free`,
  });

  const envExists = fs.existsSync(paths.envFile);
  checks.push(
    envExists
      ? { name: ".env", status: "ok", detail: "found" }
      : { name: ".env", status: "warn", detail: "missing - copy .env.example to .env and fill keys" },
  );
  for (const key of ["ANTHROPIC_API_KEY", "PEXELS_API_KEY", "PIXABAY_API_KEY"]) {
    checks.push({ name: `  ${key}`, status: hasKey(key) ? "ok" : "warn", detail: hasKey(key) ? "set" : "empty" });
  }

  const yt = await youtubeStatus();
  stopYoutubeWorker();
  checks.push({ name: "YouTube CC (yt-dlp)", status: yt.ok ? "ok" : "warn", detail: yt.ok ? yt.detail : `${yt.detail} - only needed for the youtube_cc source` });
  const web = await webCrawlerStatus();
  checks.push({ name: "Web CC fallback", status: web.ok ? "ok" : "warn", detail: web.ok ? web.detail : `${web.detail} - pip install -r python/requirements.txt (only needed for the web_cc fallback)` });

  const wc = await webCrawlStatus();
  checks.push({ name: "Web crawl (any licence)", status: wc.ok ? "ok" : "warn", detail: wc.ok ? wc.detail : `${wc.detail} - only needed for the web_crawl source` });
  checks.push({ name: "Footage library", status: "ok", detail: `${libraryBackend()} backend, ${librarySize()} clip(s) stored` });
  checks.push({ name: "Vision verify", status: llmAvailable({ vision: true }) ? "ok" : "warn", detail: llmAvailable({ vision: true }) ? (process.env.VISION_VERIFY?.toLowerCase() === "off" ? "off (VISION_VERIFY=off)" : "on") : "off (needs ANTHROPIC_API_KEY)" });
  console.log("\nClipForge doctor\n");
  for (const c of checks) console.log(`${icon[c.status]} ${c.name.padEnd(22)} ${c.detail}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  console.log(`\n${fails === 0 ? "No blocking problems." : `${fails} blocking problem(s).`}\n`);
  return fails === 0 ? 0 : 1;
}
