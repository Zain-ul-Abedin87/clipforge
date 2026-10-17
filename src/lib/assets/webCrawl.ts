import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { ffmpegPath, venvPythonPath } from "../tools.js";
import type { Candidate } from "./types.js";
import { Worker } from "./youtube.js";

/**
 * Stock provider "web_crawl" (VidRush-style general web crawling). NOT licence-checked:
 * python/web_crawl.py searches YouTube (ytsearch) and DuckDuckGo video results on sites yt-dlp
 * supports (Vimeo, Dailymotion, archive.org...). For the best hits a low-res preview piece is
 * downloaded, split into shots (python/split_shots.py, PySceneDetect) and every shot becomes its own
 * candidate with up to 3 frames for CLIP / the vision check. Only the picked shot is fetched in HD.
 * Licence is logged as "unknown/web" and QA warns about copyright risk.
 */

const CACHE = path.join(paths.root, "cache");
const SEARCH_CACHE = path.join(CACHE, "search");
const PREVIEW_DIR = path.join(CACHE, "webcrawl");
const MEDIA_CACHE = path.join(CACHE, "media");
const TTL = 7 * 24 * 3600 * 1000;
const WORKER = path.join(paths.python, "web_crawl.py");
const SPLITTER = path.join(paths.python, "split_shots.py");

export const WEB_CRAWL_LICENSE = "unknown/web";

const worker = new Worker(WORKER);
let disabledWhy: string | null = null;
let searches = 0;
/** Product-pool searches have their own budget, so stock fallbacks cannot starve a product's pool. */
let poolSearches = 0;
const said = new Set<string>();
const sayOnce = (m: string) => {
  if (!said.has(m)) console.log(m);
  said.add(m);
};

const num = (k: string, d: number) => {
  const v = Number(env(k, String(d)));
  return Number.isFinite(v) && v > 0 ? v : d;
};
const maxSearches = () => num("WEBCRAWL_MAX_SEARCHES", 20);
const previewsPerQuery = () => num("WEBCRAWL_PREVIEWS", 2);
const previewSeconds = () => num("WEBCRAWL_PREVIEW_SECONDS", 45);
const minShot = () => num("SHOT_MIN_SECONDS", 1.5);
/** Seconds fetched in HD for a picked shot (at least the shot, at least this much so a scene fits). */
const pickSeconds = () => num("WEBCRAWL_SECONDS", 10);

export const webCrawlEnabled = () => env("WEB_CRAWL", "on").toLowerCase() !== "off" && !!venvPythonPath() && fs.existsSync(WORKER);
/** "fallback" (default): only searched when the other providers found few candidates for a scene. */
export const webCrawlMode = () => (env("WEBCRAWL_MODE", "fallback").toLowerCase() === "always" ? "always" : "fallback");
export const webCrawlMinCands = () => num("WEBCRAWL_WHEN_FEWER", 6);

interface Hit {
  url: string;
  title: string;
  uploader: string;
  duration: number;
  site: string;
}
interface Shot {
  start: number;
  end: number;
  frames: string[];
}
interface Preview {
  ok: boolean;
  error?: string;
  url: string;
  uploader: string;
  uploaderUrl: string;
  title: string;
  license: string;
  offset: number;
  sourceLength: number;
  width: number;
  height: number;
  shots: Shot[];
}

const h16 = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

export async function webCrawlStatus(): Promise<{ ok: boolean; detail: string }> {
  const r = await worker.start();
  worker.stop();
  if (!r.ready) return { ok: false, detail: String(r.error) };
  const py = venvPythonPath()!;
  const probe = await run(py, ["-c", "import importlib.util as u;print('ok' if u.find_spec('scenedetect') and u.find_spec('cv2') else 'missing scenedetect/opencv')"], { timeoutMs: 30_000 });
  const split = probe.stdout.trim() === "ok";
  return { ok: true, detail: `yt-dlp ${r.version}${r.proxy ? ", via proxy" : ""}; shot splitting ${split ? "on (PySceneDetect)" : "OFF - " + probe.stdout.trim()}` };
}

export function stopWebCrawlWorker(): void {
  worker.stop();
}

/** Runs python/split_shots.py; on failure the whole preview is one shot with ffmpeg frames. */
export async function splitShots(video: string, outDir: string): Promise<{ shots: Shot[]; duration: number }> {
  const py = venvPythonPath();
  const ff = ffmpegPath() ?? "ffmpeg";
  if (py && fs.existsSync(SPLITTER)) {
    const r = await run(py, [SPLITTER, "--video", video, "--out-dir", outDir, "--min-shot", String(minShot()), "--frames", "3", "--ffmpeg", ff], { timeoutMs: 180_000 });
    const line = r.stdout.trim().split(/\r?\n/).pop() ?? "";
    try {
      const j = JSON.parse(line);
      if (j.ok) return { shots: j.shots, duration: j.duration };
      sayOnce(`[web_crawl] shot splitting off: ${j.error}`);
    } catch {
      sayOnce(`[web_crawl] shot splitting failed: ${(r.stderr.trim().split(/\r?\n/).pop() ?? "").slice(0, 160)}`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const stem = path.basename(video, path.extname(video));
  const frames: string[] = [];
  const dur = previewSeconds();
  for (const [k, f] of [0.2, 0.5, 0.8].entries()) {
    const out = path.join(outDir, `${stem}_whole_${k}.jpg`);
    const g = await run(ff, ["-v", "error", "-y", "-ss", (dur * f).toFixed(2), "-i", video, "-frames:v", "1", "-vf", "scale=384:-2", "-q:v", "5", out], { timeoutMs: 60_000 });
    if (g.code === 0 && fs.existsSync(out)) frames.push(out);
  }
  return { shots: frames.length ? [{ start: 0, end: dur, frames }] : [], duration: dur };
}

async function preview(hit: Hit): Promise<Preview | null> {
  fs.mkdirSync(PREVIEW_DIR, { recursive: true });
  const key = h16(hit.url);
  const metaFile = path.join(PREVIEW_DIR, `${key}.json`);
  if (fs.existsSync(metaFile)) {
    const p = JSON.parse(fs.readFileSync(metaFile, "utf8")) as Preview;
    // A failed preview (HTTP 403, timeout) is retried once after 30 min instead of being skipped forever.
    const retry = !p.ok && !/vertical|too long|live/i.test(String(p.error ?? "")) && !(p as Preview & { retried?: boolean }).retried && Date.now() - fs.statSync(metaFile).mtimeMs > 30 * 60_000;
    if (!retry && (!p.ok || p.shots.every((s) => s.frames.every((f) => fs.existsSync(f))))) return p.ok ? p : null;
  }
  const ff = ffmpegPath();
  if (!ff) return null;
  const out = path.join(PREVIEW_DIR, `${key}_preview.mp4`);
  const secs = previewSeconds();
  const start = hit.duration ? Math.max(0, Math.min(hit.duration * 0.3, hit.duration - secs - 1)) : 20;
  console.log(`[web_crawl] preview ${hit.url} ...`);
  const r = await worker.call({ op: "fetch", url: hit.url, start, seconds: secs, out, ffmpeg: ff, max_height: 360, timeout: 90 }, 120_000);
  if (!r.ok || !fs.existsSync(out)) {
    fs.writeFileSync(metaFile, JSON.stringify({ ok: false, error: r.error, url: hit.url, retried: fs.existsSync(metaFile) }));
    sayOnce(`[web_crawl] preview ${hit.url}: ${String(r.error ?? "no file").slice(0, 140)}`);
    return null;
  }
  const { shots } = await splitShots(out, path.join(PREVIEW_DIR, key));
  const p: Preview = {
    ok: true,
    url: String(r.webpage_url ?? hit.url),
    uploader: String(r.uploader || hit.uploader || ""),
    uploaderUrl: String(r.uploader_url ?? ""),
    title: String(r.title || hit.title || ""),
    license: String(r.license ?? WEB_CRAWL_LICENSE),
    offset: Number(r.start ?? start),
    sourceLength: Number(r.duration ?? hit.duration ?? 0),
    width: Number(r.width ?? 640),
    height: Number(r.height ?? 360),
    shots,
  };
  fs.writeFileSync(metaFile, JSON.stringify(p));
  return p;
}

/** Search + low-res preview + shot split. Each kept shot (>= SHOT_MIN_SECONDS) is one candidate. */
/**
 * Title filter for a product pool: listicles / compilations / comparisons are skipped unless the
 * exact product is clearly the subject; review / test / unboxing / hands-on titles with the exact
 * model come first. Returns hits in preferred order.
 */
export function rankHitsForProduct(hits: Hit[], product: string, forbidden: string[] = []): Hit[] {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const name = norm(product);
  const words = name.split(" ");
  const model = words.length > 1 ? words.slice(1).join(" ") : name;
  const scored = hits.map((h) => {
    const t = norm(h.title || "");
    const exact = t.includes(name);
    const hasModel = exact || t.includes(model);
    const listy = /\btop \d+\b|\bbest\b|\bcompilation\b|\bvs\b|\bversus\b|\bcomparison\b|\bcompared\b|\branked\b|\branking\b/.test(t);
    const good = /\breview\b|\btest\b|\bunboxing\b|\bhands on\b|\bwalkaround\b|\bdemo\b|\bassembly\b|\bfirst look\b/.test(t);
    // A listicle is only kept when the title is about this one product (exact name, no "vs"/"top N").
    const skip = listy && !(exact && !/\bvs\b|\bversus\b|\btop \d+\b|\bcompilation\b/.test(t));
    // Forbidden title words (case-insensitive, whole word) from the niche / Claude: skip before any download.
    const bad = forbidden.some((w) => new RegExp(`\\b${w.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim()}\\b`).test(t));
    return { h, skip: skip || bad, score: (exact ? 3 : hasModel ? 1.5 : 0) + (good ? 1 : 0) - (listy ? 1 : 0) };
  });
  return scored.filter((x) => !x.skip).sort((a, b) => b.score - a.score).map((x) => x.h);
}

export async function searchWebCrawl(query: string, opts: { pool?: boolean; previews?: number; product?: string; forbidden?: string[] } = {}): Promise<Candidate[]> {
  const previews = opts.previews ?? previewsPerQuery();
  // A direct video URL (official site / retailer page video) is previewed without a search.
  if (/^https?:\/\//i.test(query)) {
    if (disabledWhy || !webCrawlEnabled()) return [];
    return candidatesFromHits([{ url: query, title: opts.product ?? "", uploader: "", duration: 0, site: "direct" }], 1);
  }
  if (disabledWhy || !webCrawlEnabled()) return [];
  fs.mkdirSync(SEARCH_CACHE, { recursive: true });
  const f = path.join(SEARCH_CACHE, `webcrawl-${h16(query)}${previews > previewsPerQuery() ? `-n${previews}` : ""}${opts.product ? "-p" : ""}.json`);
  let hits: Hit[];
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < TTL) hits = JSON.parse(fs.readFileSync(f, "utf8"));
  else {
    if (opts.pool) {
      const maxPool = num("WEBCRAWL_POOL_MAX_SEARCHES", 80);
      if (poolSearches >= maxPool) {
        sayOnce(`[web_crawl] product-pool search limit reached (${maxPool} per run, WEBCRAWL_POOL_MAX_SEARCHES)`);
        return [];
      }
      poolSearches++;
    } else {
      if (searches >= maxSearches()) {
        sayOnce(`[web_crawl] search limit reached (${maxSearches()} per run, WEBCRAWL_MAX_SEARCHES)`);
        return [];
      }
      searches++;
    }
    let r: Awaited<ReturnType<Worker["call"]>>;
    try {
      r = await worker.call({ op: "search", query, limit: Math.max(2, opts.product ? previews * 3 : previews + 1) }, 90_000);
    } catch (err) {
      disabledWhy = String((err as Error).message ?? err);
      sayOnce(`[web_crawl] disabled: ${disabledWhy}`);
      return [];
    }
    if (!r.ok) throw new Error(`web crawl search: ${r.error}`);
    hits = r.results as Hit[];
    fs.writeFileSync(f, JSON.stringify(hits));
  }
  if (opts.product) {
    const ranked = rankHitsForProduct(hits, opts.product, opts.forbidden ?? []);
    if (ranked.length < hits.length) sayOnce(`[web_crawl] "${query}": ${hits.length - ranked.length} listicle/comparison/forbidden-keyword title(s) skipped (title checked before download)`);
    hits = ranked;
  }
  return candidatesFromHits(hits, previews);
}

async function candidatesFromHits(hits: Hit[], previews: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const hit of hits.slice(0, previews)) {
    const p = await preview(hit);
    if (!p) continue;
    const vid = h16(p.url);
    p.shots.forEach((s, i) => {
      // At least WEBCRAWL_SECONDS so a scene fits, at most 20 s of HD per pick (long uncut shots).
      const len = Math.min(20, Math.max(s.end - s.start, pickSeconds()));
      const cand: Candidate = {
        source: "web_crawl",
        id: `webx_${vid}_${i}`,
        kind: "video",
        location: p.url,
        pageUrl: p.url,
        license: WEB_CRAWL_LICENSE + (p.license.includes("page says") ? ` ${p.license.slice(WEB_CRAWL_LICENSE.length).trim()}` : ""),
        author: p.uploader.slice(0, 80) || undefined,
        width: 1920,
        height: 1080,
        duration: Math.round(len * 100) / 100,
        score: 2.0 - i * 0.01,
        tags: p.title,
        frames: s.frames,
        shotStart: Math.round((p.offset + s.start) * 100) / 100,
        sourceLength: p.sourceLength,
      };
      out.push(Object.assign(cand, { shotLen: Math.round((s.end - s.start) * 100) / 100 }));
    });
  }
  return out;
}

/** Downloads only the picked shot (plus room for the scene) in HD. */
export async function downloadWebCrawl(c: Candidate): Promise<string> {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true });
  const out = path.join(MEDIA_CACHE, `${c.id}.mp4`);
  if (fs.existsSync(out)) return out;
  const ff = ffmpegPath();
  if (!ff) throw new Error("ffmpeg not found");
  // HD first; on failure (403 / format not available) retry with lower formats before giving up.
  const top = Number(env("STOCK_MAX_WIDTH", "1920")) <= 1280 ? 720 : 1080;
  const errors: string[] = [];
  for (const h of [top, 720, 480].filter((x, i, a) => x <= top && a.indexOf(x) === i)) {
    try {
      const r = await worker.call(
        { op: "fetch", url: c.location, start: c.shotStart ?? 0, seconds: c.duration ?? pickSeconds(), out, ffmpeg: ff, max_height: h, timeout: 150, max_mb: 250 },
        200_000,
      );
      if (r.ok && fs.existsSync(out)) return out;
      errors.push(`${h}p: ${String(r.error ?? "no file").slice(0, 80)}`);
    } catch (err) {
      errors.push(`${h}p: ${String((err as Error).message ?? err).slice(0, 80)}`);
    }
  }
  throw new Error(`web crawl ${c.pageUrl}: ${errors.join(" | ")}`);
}
