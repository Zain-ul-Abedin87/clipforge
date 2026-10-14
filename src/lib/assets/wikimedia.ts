import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";
import { netFetch } from "../net.js";
import { tokens } from "./local.js";
import { USER_AGENT } from "./presskit.js";
import type { Candidate } from "./types.js";

const CACHE = path.join(paths.root, "cache");
const SEARCH_CACHE = path.join(CACHE, "search");
const MEDIA_CACHE = path.join(CACHE, "media");
const TTL = 7 * 24 * 3600 * 1000;

interface ImageInfo {
  width: number;
  height: number;
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  descriptionurl: string;
  extmetadata?: Record<string, { value: string }>;
}

const NOT_A_PHOTO = /\b(map|users|operators|diagram|drawing|schematic|chart|logo|flag|icon|exploded|patent|cutaway|blueprint|graph)\b/i;

const NOT_FOOTAGE = /\b(trailer|gameplay|game|studios?|intro|outro|screencast|screenshot|tutorial|slideshow|lecture|presentation|webinar)\b/i;

/** Wikimedia asks clients to go slowly: one API call at a time, spaced, with backoff on 429. */
let wikiQueue: Promise<unknown> = Promise.resolve();
export function wikiFetch(url: string, timeoutMs = 30_000): Promise<Response> {
  const job = wikiQueue.then(async () => {
    for (const wait of [0, 3000, 8000, 20000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      const res = await netFetch(url, { headers: { "User-Agent": USER_AGENT }, timeoutMs });
      if (res.status !== 429) {
        await new Promise((r) => setTimeout(r, 700));
        return res;
      }
    }
    throw new Error("Wikimedia 429 (rate limited, tried 4 times)");
  });
  wikiQueue = job.catch(() => undefined);
  return job;
}

const stripHtml = (s = "") => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();

/**
 * Wikimedia Commons photos of an exact product (free licenses: CC BY / CC BY-SA / CC0 / public
 * domain). Only files whose title contains every product token are kept ("Glock 19" never returns
 * a Glock 17), and only landscape-ish images big enough for 1080p.
 */
export async function searchWikimedia(product: string, blockedTerms: string[] = []): Promise<Candidate[]> {
  const want = tokens(product);
  if (!want.length) return [];
  fs.mkdirSync(SEARCH_CACHE, { recursive: true });
  const key = crypto.createHash("sha1").update(`wikimedia:${product}`).digest("hex").slice(0, 16);
  const cacheFile = path.join(SEARCH_CACHE, `${key}.json`);

  let pages: { pageid: number; title: string; imageinfo?: ImageInfo[] }[];
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < TTL) {
    pages = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } else {
    const url =
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=20" +
      `&gsrsearch=${encodeURIComponent(product)}&prop=imageinfo&iiprop=url|size|extmetadata&iiurlwidth=1920`;
    const res = await wikiFetch(url);
    if (!res.ok) throw new Error(`Wikimedia ${res.status}`);
    const j = (await res.json()) as { query?: { pages?: Record<string, { pageid: number; title: string; imageinfo?: ImageInfo[] }> } };
    pages = Object.values(j.query?.pages ?? {});
    fs.writeFileSync(cacheFile, JSON.stringify(pages));
  }

  const out: Candidate[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info?.thumburl || !/\.(jpe?g|png|webp)$/i.test(p.title)) continue;
    const titleTokens = new Set(tokens(p.title));
    if (!want.every((t) => titleTokens.has(t))) continue;
    // Not a photo of the product: maps of user countries, diagrams, logos, patent drawings...
    if (NOT_A_PHOTO.test(p.title)) continue;
    const lower = p.title.toLowerCase();
    if (blockedTerms.some((b) => lower.includes(b.toLowerCase()))) continue;
    if (info.width < 1200 || info.width < info.height * 1.15) continue;
    const meta = info.extmetadata ?? {};
    const license = stripHtml(meta.LicenseShortName?.value);
    if (!/^(cc|public domain|pd)/i.test(license)) continue;
    const author = stripHtml(meta.Artist?.value).slice(0, 80);
    out.push({
      source: "wikimedia",
      id: `wikimedia_${p.pageid}`,
      kind: "image",
      location: info.thumburl,
      pageUrl: info.descriptionurl,
      license: `${license} via Wikimedia Commons${/^cc by/i.test(license) ? " (credit the author in the description)" : ""}`,
      author,
      width: info.thumbwidth ?? 1920,
      height: info.thumbheight ?? Math.round((1920 * info.height) / info.width),
      score: 8 + (info.width >= 3000 ? 0.5 : 0),
      thumbUrl: info.thumburl,
    });
  }
  return out;
}

interface VideoInfo extends ImageInfo {
  url: string;
  size: number;
  duration?: number;
  mediatype?: string;
}

/**
 * Free-licensed B-roll videos on Wikimedia Commons (webm/ogv). Landscape, at least 1280 px wide,
 * 4+ seconds, and under 150 MB so a download stays reasonable on a slow connection.
 */
export async function searchWikimediaVideo(query: string, blockedTerms: string[] = []): Promise<Candidate[]> {
  fs.mkdirSync(SEARCH_CACHE, { recursive: true });
  const key = crypto.createHash("sha1").update(`wikimedia-video:${query}`).digest("hex").slice(0, 16);
  const cacheFile = path.join(SEARCH_CACHE, `${key}.json`);
  let pages: { pageid: number; title: string; imageinfo?: VideoInfo[] }[];
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < TTL) {
    pages = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } else {
    const url =
      "https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrlimit=20" +
      `&gsrsearch=${encodeURIComponent(`${query} filetype:video`)}&prop=imageinfo&iiprop=url|size|mediatype|extmetadata&iiurlwidth=640`;
    const res = await wikiFetch(url);
    if (!res.ok) throw new Error(`Wikimedia ${res.status}`);
    const j = (await res.json()) as { query?: { pages?: Record<string, { pageid: number; title: string; imageinfo?: VideoInfo[] }> } };
    pages = Object.values(j.query?.pages ?? {});
    fs.writeFileSync(cacheFile, JSON.stringify(pages));
  }

  const out: Candidate[] = [];
  for (const p of pages) {
    const info = p.imageinfo?.[0];
    if (!info || !/\.(webm|ogv|mp4)$/i.test(p.title)) continue;
    const aspect = info.width / Math.max(1, info.height);
    if (info.width < 1280 || aspect < 1.2 || aspect > 2.4 || (info.duration ?? 0) < 4 || info.size > 150 * 1024 * 1024) continue;
    const lower = p.title.toLowerCase();
    if (NOT_A_PHOTO.test(p.title) || NOT_FOOTAGE.test(p.title) || blockedTerms.some((b) => lower.includes(b.toLowerCase()))) continue;
    const meta = info.extmetadata ?? {};
    const license = stripHtml(meta.LicenseShortName?.value);
    if (!/^(cc0|cc by|public domain|pd)/i.test(license) || /nc|nd/i.test(license)) continue;
    out.push({
      source: "wikimedia",
      id: `wikimediavid_${p.pageid}`,
      kind: "video",
      location: info.url,
      pageUrl: info.descriptionurl,
      license: `${license} via Wikimedia Commons${/^cc by/i.test(license) ? " (credit the author in the description)" : ""}`,
      author: stripHtml(meta.Artist?.value).slice(0, 80),
      width: info.width,
      height: info.height,
      duration: info.duration,
      score: 3.8 - out.length * 0.1,
      tags: p.title,
      thumbUrl: info.thumburl,
    });
  }
  return out;
}

/** Downloads a Commons file (1920px photo rendition, or the original video) into the media cache. */
export async function downloadWikimedia(c: Candidate): Promise<string> {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true });
  const ext = c.kind === "video" ? path.extname(new URL(c.location).pathname).toLowerCase() || ".webm" : ".jpg";
  const out = path.join(MEDIA_CACHE, `${c.id}${ext}`);
  if (fs.existsSync(out)) return out;
  const res = await fetch(c.location, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Wikimedia download HTTP ${res.status}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}
