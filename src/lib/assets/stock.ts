import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env, hasKey } from "../env.js";
import { paths } from "../paths.js";
import type { Candidate } from "./types.js";

const CACHE = path.join(paths.root, "cache");
const SEARCH_CACHE = path.join(CACHE, "search");
export const MEDIA_CACHE = path.join(CACHE, "media");
const SEARCH_TTL_MS = 24 * 3600 * 1000; // Pixabay requires caching results for 24h; Pexels is rate limited.

const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

async function cachedJson(key: string, fetcher: () => Promise<unknown>): Promise<unknown> {
  fs.mkdirSync(SEARCH_CACHE, { recursive: true });
  const f = path.join(SEARCH_CACHE, `${hash(key)}.json`);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < SEARCH_TTL_MS) {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  }
  const data = await fetcher();
  fs.writeFileSync(f, JSON.stringify(data));
  return data;
}

export class RateLimited extends Error {}

const lastCall = new Map<string, number>();
async function spaced(name: string, ms: number): Promise<void> {
  const wait = (lastCall.get(name) ?? 0) + ms - Date.now();
  lastCall.set(name, Date.now() + Math.max(0, wait));
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

interface PexelsFile { width: number; height: number; link: string; quality: string; file_type: string }
interface PexelsVideo { id: number; url: string; image?: string; duration: number; width: number; height: number; user: { name: string }; video_files: PexelsFile[] }

/** Target width for stock downloads: 1920 (default) or 1280 via STOCK_MAX_WIDTH for slow connections. */
const maxWidth = () => Number(env("STOCK_MAX_WIDTH", "1920")) || 1920;

/** Smallest landscape file at least as wide as the target, never 4K; else the widest below it (>= 1280). */
function pickBySize<T extends { width: number; height: number }>(files: T[]): T | null {
  const landscape = files.filter((f) => f.width > f.height && f.width >= 1280);
  const target = maxWidth();
  const atLeast = landscape.filter((f) => f.width >= target && f.width < 2560).sort((a, b) => a.width - b.width)[0];
  return atLeast ?? landscape.filter((f) => f.width <= target).sort((a, b) => b.width - a.width)[0] ?? null;
}

function pickPexelsFile(v: PexelsVideo): PexelsFile | null {
  return pickBySize(v.video_files.filter((f) => f.file_type === "video/mp4"));
}

export async function searchPexels(query: string): Promise<Candidate[]> {
  if (!hasKey("PEXELS_API_KEY")) return [];
  const url = `https://api.pexels.com/videos/search?query=${encodeURIComponent(query)}&orientation=landscape&size=medium&per_page=15`;
  const data = (await cachedJson(`pexels:${query}`, async () => {
    const res = await fetch(url, { headers: { Authorization: env("PEXELS_API_KEY") } });
    if (res.status === 429) throw new RateLimited("Pexels rate limit reached");
    if (!res.ok) throw new Error(`Pexels ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  })) as { videos?: PexelsVideo[] };

  return (data.videos ?? []).flatMap((v, rank) => {
    const f = pickPexelsFile(v);
    if (!f) return [];
    return [{
      source: "pexels" as const,
      id: `pexels_${v.id}_${f.width}`,
      kind: "video" as const,
      location: f.link,
      pageUrl: v.url,
      license: "Pexels License (free to use, no attribution required)",
      author: v.user?.name,
      width: f.width,
      height: f.height,
      duration: v.duration,
      score: 5 - rank * 0.1,
      // Pexels has no tags in this endpoint; the page URL slug carries the title words.
      tags: v.url,
      thumbUrl: v.image,
    }];
  });
}

interface PixabayHit {
  id: number;
  tags: string;
  pageURL: string;
  duration: number;
  user: string;
  videos: Record<string, { url: string; width: number; height: number; size: number; thumbnail?: string }>;
}

export async function searchPixabay(query: string): Promise<Candidate[]> {
  if (!hasKey("PIXABAY_API_KEY")) return [];
  const q = encodeURIComponent(query.slice(0, 100));
  const url = `https://pixabay.com/api/videos/?key=${env("PIXABAY_API_KEY")}&q=${q}&per_page=15&safesearch=true`;
  const data = (await cachedJson(`pixabay:${query}`, async () => {
    await spaced("pixabay", 700);
    const res = await fetch(url);
    if (res.status === 429) throw new RateLimited("Pixabay rate limit reached");
    if (!res.ok) throw new Error(`Pixabay ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  })) as { hits?: PixabayHit[] };

  return (data.hits ?? []).flatMap((h, rank) => {
    const v = pickBySize(["large", "medium", "small"].map((k) => h.videos[k]).filter((x) => x?.url));
    if (!v) return [];
    return [{
      source: "pixabay" as const,
      id: `pixabay_${h.id}_${v.width}`,
      kind: "video" as const,
      location: v.url,
      pageUrl: h.pageURL,
      license: "Pixabay Content License (free to use, no attribution required)",
      author: h.user,
      width: v.width,
      height: v.height,
      duration: h.duration,
      score: 4 - rank * 0.1,
      tags: h.tags,
      thumbUrl: h.videos.medium?.thumbnail ?? h.videos.small?.thumbnail ?? h.videos.large?.thumbnail,
    }];
  });
}

/**
 * Downloads a stock clip into the shared media cache (reused across projects, so the same clip is
 * never downloaded twice). Writes to .part and renames, so an interrupted download is never used.
 */
export async function downloadStock(c: Candidate): Promise<string> {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true });
  const out = path.join(MEDIA_CACHE, `${c.id}.mp4`);
  if (fs.existsSync(out)) return out;
  const part = `${out}.part`;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(c.location, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
      fs.renameSync(part, out);
      return out;
    } catch (err) {
      lastErr = err;
    }
  }
  fs.rmSync(part, { force: true });
  throw new Error(`download failed for ${c.pageUrl}: ${String(lastErr)}`);
}

export const THUMB_CACHE = path.join(CACHE, "thumbs");

/** Downloads a candidate's small preview image (tens of KB) for relevance scoring. */
export async function downloadThumb(c: Candidate): Promise<string | null> {
  if (!c.thumbUrl) return null;
  fs.mkdirSync(THUMB_CACHE, { recursive: true });
  const out = path.join(THUMB_CACHE, `${c.id}.jpg`);
  if (fs.existsSync(out)) return out;
  try {
    const res = await fetch(c.thumbUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
    return out;
  } catch {
    return null;
  }
}
