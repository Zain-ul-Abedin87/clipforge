import { env } from "../env.js";
import { ResearchDb } from "./db.js";

/**
 * YouTube Data API v3 client for research, with a quota counter and an SQLite answer cache.
 *
 * Quota (default project: 10,000 units/day, reset at midnight Pacific time): search.list = 100
 * units, videos.list / channels.list / playlistItems.list = 1 unit per call (up to 50 ids). Units
 * are counted in data/research.db before each call; a call that would go past
 * dailyQuota - quotaReserve is refused (QuotaError) instead of sent. A cached answer costs nothing.
 *
 * Key: YOUTUBE_API_KEY in .env (Google Cloud console -> YouTube Data API v3 -> API key; free).
 */

export const UNIT_COST = { search: 100, videos: 1, channels: 1, playlistItems: 1 } as const;
type Endpoint = keyof typeof UNIT_COST;

export class QuotaError extends Error {
  constructor(public used: number, public need: number, public limit: number) {
    super(`YouTube API quota: ${used} of ${limit} units used today, this call needs ${need} (resets at midnight Pacific time)`);
  }
}

export class YouTubeApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Quota day (YYYY-MM-DD) in Pacific time, when Google resets the counter. */
export function quotaDay(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

export interface YtVideo {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  views: number;
  likes: number;
  comments: number;
  durationSec: number;
  thumbnail: string;
}

export interface YtChannel {
  id: string;
  title: string;
  description: string;
  publishedAt: string;
  subscribers: number;
  views: number;
  videos: number;
  uploadsPlaylist: string;
  thumbnail: string;
  country?: string;
}

/** ISO 8601 duration (PT1H2M3S) -> seconds. */
export function isoDurationSec(d: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(d ?? "");
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

const n = (v: unknown) => (v === undefined || v === null ? 0 : Number(v) || 0);
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface YouTubeApiOptions {
  key?: string;
  db: ResearchDb;
  fetch?: typeof fetch;
  dailyQuota?: number;
  quotaReserve?: number;
  cacheHours?: number;
  log?: (m: string) => void;
  now?: () => Date;
}

export class YouTubeApi {
  private key: string;
  private f: typeof fetch;
  private log: (m: string) => void;
  private now: () => Date;
  readonly dailyQuota: number;
  readonly quotaReserve: number;
  private cacheMs: number;
  /** Units spent by this instance (cached answers excluded). */
  spent = 0;
  cacheHits = 0;

  constructor(private o: YouTubeApiOptions) {
    this.key = o.key ?? env("YOUTUBE_API_KEY", "");
    this.f = o.fetch ?? ((...a) => fetch(...a));
    this.log = o.log ?? (() => {});
    this.now = o.now ?? (() => new Date());
    this.dailyQuota = o.dailyQuota ?? 10000;
    this.quotaReserve = o.quotaReserve ?? 0;
    this.cacheMs = (o.cacheHours ?? 24) * 3600_000;
  }

  get configured(): boolean {
    return !!this.key;
  }

  quota(): { day: string; used: number; limit: number; left: number } {
    const day = quotaDay(this.now());
    const used = this.o.db.quotaUsed(day);
    const limit = this.dailyQuota - this.quotaReserve;
    return { day, used, limit, left: Math.max(0, limit - used) };
  }

  /** Units left today for research. */
  canSpend(units: number): boolean {
    return this.quota().left >= units;
  }

  private async call(endpoint: Endpoint, params: Record<string, string | number | undefined>, cacheHours?: number): Promise<Json> {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== "")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const cacheKey = `yt:${endpoint}?${qs}`;
    const maxAge = cacheHours === undefined ? this.cacheMs : cacheHours * 3600_000;
    const hit = this.o.db.getCache<Json>(cacheKey, maxAge, this.now().getTime());
    if (hit) {
      this.cacheHits++;
      return hit;
    }
    if (!this.key) throw new YouTubeApiError(401, "YOUTUBE_API_KEY is not set in .env (Google Cloud console -> YouTube Data API v3 -> API key, free)");
    const cost = UNIT_COST[endpoint];
    const q = this.quota();
    if (q.left < cost) throw new QuotaError(q.used, cost, q.limit);
    // Counted before the call: a failed call still costs quota at Google.
    const used = this.o.db.addQuota(q.day, cost);
    this.spent += cost;
    const url = `https://www.googleapis.com/youtube/v3/${endpoint}?${qs}&key=${encodeURIComponent(this.key)}`;
    const res = await this.f(url, { signal: AbortSignal.timeout(30_000) });
    const body = (await res.json().catch(() => ({}))) as Json;
    this.log(`[research] youtube ${endpoint} (${cost} unit${cost > 1 ? "s" : ""}, ${used}/${q.limit} today) -> ${res.status}`);
    if (!res.ok) {
      const reason = body?.error?.errors?.[0]?.reason ?? "";
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
        // Google's counter is the truth: mark the day as used up.
        this.o.db.addQuota(q.day, Math.max(0, this.dailyQuota - used));
        throw new QuotaError(this.dailyQuota, cost, this.dailyQuota);
      }
      throw new YouTubeApiError(res.status, `YouTube API ${res.status}: ${body?.error?.message ?? res.statusText}`);
    }
    this.o.db.setCache(cacheKey, body, this.now().getTime());
    return body;
  }

  /** search.list type=video (100 units per call, max 50 results). Returns video ids. */
  async searchVideos(q: string, o: { publishedAfter?: Date; maxResults?: number; order?: "viewCount" | "relevance" | "date"; duration?: "short" | "medium" | "long" | "any" } = {}): Promise<string[]> {
    const body = await this.call(
      "search",
      {
        part: "id",
        type: "video",
        q,
        maxResults: Math.min(50, o.maxResults ?? 50),
        order: o.order ?? "viewCount",
        publishedAfter: o.publishedAfter?.toISOString().replace(/\.\d{3}Z$/, "Z"),
        videoDuration: o.duration && o.duration !== "any" ? o.duration : undefined,
        relevanceLanguage: "en",
      },
      12,
    );
    return ((body.items ?? []) as Json[]).map((it) => String(it.id?.videoId ?? "")).filter(Boolean);
  }

  /** search.list type=channel (100 units). Returns channel ids. */
  async searchChannels(q: string, o: { publishedAfter?: Date; maxResults?: number } = {}): Promise<string[]> {
    const body = await this.call("search", { part: "id", type: "channel", q, maxResults: Math.min(50, o.maxResults ?? 50), order: "relevance", publishedAfter: o.publishedAfter?.toISOString().replace(/\.\d{3}Z$/, "Z") }, 12);
    return ((body.items ?? []) as Json[]).map((it) => String(it.id?.channelId ?? "")).filter(Boolean);
  }

  /** videos.list with statistics (1 unit per 50 ids). */
  async videos(ids: string[]): Promise<YtVideo[]> {
    const out: YtVideo[] = [];
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 50) {
      const body = await this.call("videos", { part: "snippet,statistics,contentDetails", id: uniq.slice(i, i + 50).join(","), maxResults: 50 });
      for (const it of (body.items ?? []) as Json[]) {
        out.push({
          id: String(it.id),
          title: String(it.snippet?.title ?? ""),
          channelId: String(it.snippet?.channelId ?? ""),
          channelTitle: String(it.snippet?.channelTitle ?? ""),
          publishedAt: String(it.snippet?.publishedAt ?? ""),
          views: n(it.statistics?.viewCount),
          likes: n(it.statistics?.likeCount),
          comments: n(it.statistics?.commentCount),
          durationSec: isoDurationSec(String(it.contentDetails?.duration ?? "")),
          thumbnail: String(it.snippet?.thumbnails?.medium?.url ?? it.snippet?.thumbnails?.default?.url ?? ""),
        });
      }
    }
    return out;
  }

  /** channels.list with statistics + uploads playlist (1 unit per 50 ids). */
  async channels(ids: string[]): Promise<YtChannel[]> {
    const out: YtChannel[] = [];
    const uniq = [...new Set(ids)];
    for (let i = 0; i < uniq.length; i += 50) {
      const body = await this.call("channels", { part: "snippet,statistics,contentDetails", id: uniq.slice(i, i + 50).join(","), maxResults: 50 });
      for (const it of (body.items ?? []) as Json[]) {
        out.push({
          id: String(it.id),
          title: String(it.snippet?.title ?? ""),
          description: String(it.snippet?.description ?? ""),
          publishedAt: String(it.snippet?.publishedAt ?? ""),
          subscribers: n(it.statistics?.subscriberCount),
          views: n(it.statistics?.viewCount),
          videos: n(it.statistics?.videoCount),
          uploadsPlaylist: String(it.contentDetails?.relatedPlaylists?.uploads ?? ""),
          thumbnail: String(it.snippet?.thumbnails?.default?.url ?? ""),
          country: it.snippet?.country ? String(it.snippet.country) : undefined,
        });
      }
    }
    return out;
  }

  /** Latest `max` upload ids of a channel (playlistItems.list, 1 unit per 50). */
  async latestUploads(uploadsPlaylist: string, max = 30): Promise<string[]> {
    if (!uploadsPlaylist) return [];
    const body = await this.call("playlistItems", { part: "contentDetails", playlistId: uploadsPlaylist, maxResults: Math.min(50, max) });
    return ((body.items ?? []) as Json[]).map((it) => String(it.contentDetails?.videoId ?? "")).filter(Boolean).slice(0, max);
  }
}
