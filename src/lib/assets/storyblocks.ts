import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env, hasKey } from "../env.js";
import { paths } from "../paths.js";
import { netFetch } from "../net.js";
import { MEDIA_CACHE, RateLimited } from "./stock.js";
import type { Candidate } from "./types.js";

/**
 * Storyblocks (licensed stock video, API v2). Every request is signed: HMAC-SHA256 of the URL path,
 * keyed with private key + EXPIRES (unix time, at most 36 h ahead), sent as APIKEY/EXPIRES/HMAC.
 * Search and download also carry user_id (hashed channel) and project_id (project name), which
 * Storyblocks uses to tie downloads to searches. Downloads are counted, so only clips that win
 * the CLIP ranking are downloaded, once, into the shared media cache.
 *
 * Keys: STORYBLOCKS_PUBLIC_KEY / STORYBLOCKS_PRIVATE_KEY in .env. Test keys are for internal
 * testing only (check your API agreement before publishing videos made with them).
 */

const BASE = "https://api.storyblocks.com";
const SEARCH_CACHE = path.join(paths.root, "cache", "search");
const SEARCH_TTL_MS = 24 * 3600 * 1000;

export const STORYBLOCKS_LICENSE = "Storyblocks licence (API, licensed stock)";
export const storyblocksReady = () => hasKey("STORYBLOCKS_PUBLIC_KEY") && hasKey("STORYBLOCKS_PRIVATE_KEY");

/** Set by the assets step so requests carry the channel and project. */
const ids = { user: "clipforge", project: "clipforge" };
export function setStoryblocksIds(channel: string, project: string): void {
  ids.user = `ch_${crypto.createHash("sha1").update(channel).digest("hex").slice(0, 12)}`;
  ids.project = project.replace(/[^\w-]/g, "_").slice(0, 64) || "clipforge";
}

function signed(resource: string, query: Record<string, string | number>): string {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const hmac = crypto.createHmac("sha256", env("STORYBLOCKS_PRIVATE_KEY") + expires).update(resource).digest("hex");
  const qs = new URLSearchParams({
    ...Object.fromEntries(Object.entries(query).map(([k, v]) => [k, String(v)])),
    APIKEY: env("STORYBLOCKS_PUBLIC_KEY"),
    EXPIRES: String(expires),
    HMAC: hmac,
    user_id: ids.user,
    project_id: ids.project,
  });
  return `${BASE}${resource}?${qs}`;
}

/**
 * Set when the account has no downloads left. Remembered per key for 24 h in cache/, so later
 * runs do not pick Storyblocks clips that cannot be downloaded; a new key starts fresh.
 */
const QUOTA_FILE = path.join(paths.root, "cache", "storyblocks_quota.json");
const keyHash = () => crypto.createHash("sha1").update(env("STORYBLOCKS_PUBLIC_KEY")).digest("hex").slice(0, 12);
let exhausted = (() => {
  try {
    const q = JSON.parse(fs.readFileSync(QUOTA_FILE, "utf8")) as { key: string; at: string };
    return q.key === keyHash() && Date.now() - Date.parse(q.at) < 24 * 3600 * 1000;
  } catch {
    return false;
  }
})();
export const storyblocksExhausted = () => exhausted;
function markExhausted(): void {
  exhausted = true;
  fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
  fs.writeFileSync(QUOTA_FILE, JSON.stringify({ key: keyHash(), at: new Date().toISOString() }));
}

async function getJson(resource: string, query: Record<string, string | number>): Promise<unknown> {
  const res = await netFetch(signed(resource, query), { timeoutMs: 45_000 });
  const text = await res.text();
  if (res.status === 429) throw new RateLimited("Storyblocks rate limit reached");
  if (res.status === 403 && /no downloads remaining/i.test(text)) {
    markExhausted();
    throw new Error("Storyblocks: no downloads remaining on this key (test keys allow only a few); using other sources");
  }
  if (!res.ok) throw new Error(`Storyblocks ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text.replace(/\\u0000/g, ""));
}

interface SbVideo {
  id: number | string;
  title?: string;
  keywords?: string[] | string;
  duration?: number;
  thumbnail_url?: string;
  preview_urls?: Record<string, string>;
  type?: string;
  is_editorial?: boolean;
  orientation?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v : "");

export async function searchStoryblocks(query: string): Promise<Candidate[]> {
  if (!storyblocksReady()) return [];
  // No downloads left: only clips already in the media cache are worth offering.
  const cachedOnly = exhausted;
  fs.mkdirSync(SEARCH_CACHE, { recursive: true });
  const f = path.join(SEARCH_CACHE, `storyblocks-${crypto.createHash("sha1").update(query).digest("hex").slice(0, 16)}.json`);
  let data: { results?: SbVideo[] };
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < SEARCH_TTL_MS) data = JSON.parse(fs.readFileSync(f, "utf8"));
  else {
    data = (await getJson("/api/v2/videos/search", { keywords: query.slice(0, 100), results_per_page: 30, page: 1, content_type: "footage", quality: "HD" })) as { results?: SbVideo[] };
    fs.writeFileSync(f, JSON.stringify(data));
  }
  return (data.results ?? []).flatMap((v, rank) => {
    // Vertical clips (phone-style) do not fit a 16:9 video.
    if (v.id === undefined || v.is_editorial || v.orientation === "vertical") return [];
    if (cachedOnly && !fs.existsSync(path.join(MEDIA_CACHE, `storyblocks_${v.id}.mp4`))) return [];
    const prev = v.preview_urls ?? {};
    const tags = [str(v.title), Array.isArray(v.keywords) ? v.keywords.join(", ") : str(v.keywords)].filter(Boolean).join(" | ");
    return [{
      source: "storyblocks" as const,
      id: `storyblocks_${v.id}`,
      kind: "video" as const,
      // The real file URL comes from the download endpoint (counted), only for the chosen clip.
      location: String(v.id),
      pageUrl: `https://www.storyblocks.com/video/stock/${v.id}`,
      license: STORYBLOCKS_LICENSE,
      width: 1920,
      height: 1080,
      duration: Number(v.duration) || undefined,
      // Licensed, purpose-shot stock: ranked above the free sites on ties.
      score: 6 - rank * 0.1,
      tags,
      thumbUrl: str(v.thumbnail_url) || str(prev._480p) || undefined,
    }];
  });
}

/** Picks an MP4 rendition from the download answer: 1080p, else 720p, never 4K (slow link). */
function pickRendition(answer: unknown): string | null {
  const urls: { url: string; res: number }[] = [];
  const walk = (o: unknown, key = "") => {
    if (typeof o === "string" && /^https?:\/\//.test(o)) {
      const m = key.match(/(\d{3,4})p/i) ?? o.match(/(\d{3,4})p/i);
      const res = /4k|2160/i.test(key + o) ? 2160 : m ? Number(m[1]) : 0;
      if (!/\.mov(\?|$)/i.test(o) && !/mov/i.test(key)) urls.push({ url: o, res });
    } else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) walk(v, `${key}.${k}`);
  };
  walk(answer);
  const want = Number(env("STOCK_MAX_WIDTH", "1920")) <= 1280 ? 720 : 1080;
  return (urls.filter((u) => u.res && u.res <= want).sort((a, b) => b.res - a.res)[0] ?? urls.filter((u) => u.res !== 2160)[0])?.url ?? null;
}

export async function downloadStoryblocks(c: Candidate): Promise<string> {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true });
  const out = path.join(MEDIA_CACHE, `${c.id}.mp4`);
  if (fs.existsSync(out)) return out;
  if (exhausted) throw new Error("Storyblocks: no downloads remaining on this key");
  const answer = await getJson(`/api/v2/videos/stock-item/download/${encodeURIComponent(c.location)}`, {});
  const url = pickRendition(answer);
  if (!url) throw new Error(`Storyblocks ${c.location}: no MP4 in download answer (${JSON.stringify(answer).slice(0, 160)})`);
  const part = `${out}.part`;
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new Error(`Storyblocks file HTTP ${res.status}`);
  fs.writeFileSync(part, Buffer.from(await res.arrayBuffer()));
  fs.renameSync(part, out);
  return out;
}
