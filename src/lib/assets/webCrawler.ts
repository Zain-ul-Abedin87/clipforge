import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { ffmpegPath, venvPythonPath } from "../tools.js";

/**
 * Last-resort footage source "web_cc": python/web_crawler.py searches DuckDuckGo videos for any
 * keyword, keeps only pages whose own metadata says Creative Commons (no NC/ND) or public domain,
 * and cuts a muted 5 s piece. Used when every stock source came back empty for a scene.
 */

const SCRIPT = path.join(paths.python, "web_crawler.py");

export interface WebClipMeta {
  license: string;
  url: string;
  title: string;
  author: string;
  author_url?: string;
  width: number;
  height: number;
  duration: number;
  keyword: string;
}

/** Per-run budget: each crawl reads several pages and downloads video over a slow link. */
const maxCrawls = () => Number(env("WEBCC_MAX_CRAWLS", "8")) || 8;
const timeoutMs = () => Number(env("WEBCC_TIMEOUT_MS", "120000")) || 120_000;
let crawls = 0;
let disabledWhy: string | null = null;

export const webCrawlerReady = () => !!venvPythonPath() && fs.existsSync(SCRIPT) && !disabledWhy && env("WEBCC", "on").toLowerCase() !== "off";
export const webCrawlsLeft = () => Math.max(0, maxCrawls() - crawls);

/**
 * Returns the absolute path of a 5 s muted clip in `workspaceDir`, or null when nothing licensed
 * was found, the crawler failed, or it ran past the timeout (the process is then killed, so a
 * slow site can never hang the pipeline).
 */
export async function fetchFromWeb(
  keyword: string,
  workspaceDir: string,
  sceneId: string,
  opts: { seconds?: number; log?: (m: string) => void } = {},
): Promise<string | null> {
  const log = opts.log ?? (() => {});
  const py = venvPythonPath();
  if (!py || !fs.existsSync(SCRIPT) || disabledWhy) return null;
  if (crawls >= maxCrawls()) {
    log(`[web_cc] crawl limit reached (${maxCrawls()} per run, WEBCC_MAX_CRAWLS)`);
    return null;
  }
  crawls++;
  fs.mkdirSync(workspaceDir, { recursive: true });
  const limit = timeoutMs();
  const args = [
    "-u", SCRIPT,
    "--keyword", keyword,
    "--out-dir", workspaceDir,
    "--scene-id", sceneId,
    "--seconds", String(opts.seconds ?? (Number(env("WEBCC_SECONDS", "5")) || 5)),
    // The crawler stops trying new pages a few seconds before the kill, so it can clean up itself.
    "--deadline", String(Math.max(10, Math.round(limit / 1000) - 8)),
  ];
  const ff = ffmpegPath();
  if (ff) args.push("--ffmpeg", ff);

  const r = await run(py, args, { timeoutMs: limit });
  const line = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith("SUCCESS:"));
  const file = line?.slice("SUCCESS:".length).trim();
  if (r.code === 0 && file && fs.existsSync(file)) return path.resolve(file);

  const why = (r.stderr.trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] ?? `exit ${r.code}`).replace(/^\[web_cc\]\s*/, "");
  if (/missing packages/.test(r.stderr)) {
    disabledWhy = why;
    log(`[web_cc] disabled: ${why}`);
  } else log(`[web_cc] "${keyword}": ${why}`);
  return null;
}

/** For `clipforge doctor`: are ddgs (or duckduckgo_search), moviepy and yt-dlp importable in .venv? */
export async function webCrawlerStatus(): Promise<{ ok: boolean; detail: string }> {
  const py = venvPythonPath();
  if (!py) return { ok: false, detail: "project .venv not found" };
  const probe = [
    "import importlib.util as u",
    "m=[n for n in ('yt_dlp','moviepy') if not u.find_spec(n)]",
    "m+=[] if (u.find_spec('ddgs') or u.find_spec('duckduckgo_search')) else ['ddgs']",
    "print('missing: '+', '.join(m) if m else 'ok')",
  ].join("\n");
  const r = await run(py, ["-c", probe], { timeoutMs: 30_000 });
  const out = r.stdout.trim();
  return out === "ok" ? { ok: true, detail: "ddgs + moviepy + yt-dlp" } : { ok: false, detail: out || r.stderr.trim().slice(-200) };
}

/**
 * yt-dlp's raw licence ("by-sa", a creativecommons.org URL, ...) in the wording the licence log and
 * the QA credits use ("CC BY ..." lines are credited in the description).
 */
export function webLicense(raw: string): string {
  const s = raw.toLowerCase();
  if (/public\s*domain|publicdomain|cc0|\bpdm\b/.test(s)) return `Public domain / CC0 via web (${raw})`;
  if (/\bsa\b|share\s*alike|sharealike/.test(s.replace(/[-_/]/g, " "))) return `CC BY-SA via web (${raw})`;
  return `CC BY via web (${raw})`;
}

/** Licence / page / author written by the crawler next to the clip (`<clip>.json`). */
export function readWebMeta(clip: string): WebClipMeta | null {
  const f = clip.replace(/\.mp4$/i, ".json");
  try {
    return JSON.parse(fs.readFileSync(f, "utf8")) as WebClipMeta;
  } catch {
    return null;
  }
}
