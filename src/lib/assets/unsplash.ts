import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env, hasKey } from "../env.js";
import { paths } from "../paths.js";
import { USER_AGENT } from "./presskit.js";
import type { Candidate } from "./types.js";

const CACHE = path.join(paths.root, "cache");
const SEARCH_CACHE = path.join(CACHE, "search");
const MEDIA_CACHE = path.join(CACHE, "media");
const TTL = 24 * 3600 * 1000;

interface UnsplashPhoto {
  id: string;
  width: number;
  height: number;
  description: string | null;
  alt_description: string | null;
  urls: { raw: string; small: string };
  links: { html: string; download_location?: string };
  user: { name: string; links: { html: string } };
}

/**
 * Unsplash photos (Unsplash License: free for commercial use; we still credit the photographer).
 * Landscape only. Requires UNSPLASH_ACCESS_KEY (free developer key, 50 searches/hour in demo mode).
 */
export async function searchUnsplash(query: string): Promise<Candidate[]> {
  if (!hasKey("UNSPLASH_ACCESS_KEY")) return [];
  fs.mkdirSync(SEARCH_CACHE, { recursive: true });
  const key = crypto.createHash("sha1").update(`unsplash:${query}`).digest("hex").slice(0, 16);
  const cacheFile = path.join(SEARCH_CACHE, `${key}.json`);
  let results: UnsplashPhoto[];
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < TTL) {
    results = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  } else {
    const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&orientation=landscape&per_page=20&content_filter=high`;
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${env("UNSPLASH_ACCESS_KEY")}`, "Accept-Version": "v1", "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 403 || res.status === 429) throw new Error("Unsplash rate limit reached (50 searches/hour in demo mode)");
    if (!res.ok) throw new Error(`Unsplash ${res.status}`);
    results = ((await res.json()) as { results: UnsplashPhoto[] }).results ?? [];
    fs.writeFileSync(cacheFile, JSON.stringify(results));
  }

  return results
    .filter((p) => p.width >= 1600 && p.width > p.height * 1.2)
    .map((p, rank) => ({
      source: "unsplash" as const,
      id: `unsplash_${p.id}`,
      kind: "image" as const,
      // raw + sizing params keeps Unsplash's tracking parameters, as their guidelines ask.
      location: `${p.urls.raw}&w=1920&fm=jpg&q=85`,
      pageUrl: p.links.html,
      license: `Unsplash License - Photo by ${p.user.name} on Unsplash`,
      author: p.user.name,
      width: 1920,
      height: Math.round((1920 * p.height) / p.width),
      score: 4.5 - rank * 0.1,
      tags: `${p.description ?? ""} ${p.alt_description ?? ""}`,
      thumbUrl: p.urls.small,
    }));
}

/** Downloads a photo and registers the download with Unsplash (required by their API terms). */
export async function downloadUnsplash(c: Candidate): Promise<string> {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true });
  const out = path.join(MEDIA_CACHE, `${c.id}.jpg`);
  if (fs.existsSync(out)) return out;
  const id = c.id.replace(/^unsplash_/, "");
  await fetch(`https://api.unsplash.com/photos/${id}/download`, {
    headers: { Authorization: `Client-ID ${env("UNSPLASH_ACCESS_KEY")}`, "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(30_000),
  }).catch(() => undefined);
  const res = await fetch(c.location, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Unsplash download HTTP ${res.status}`);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
  return out;
}
