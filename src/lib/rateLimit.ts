import crypto from "node:crypto";
import { env } from "./env.js";
import { redis } from "./redis.js";

/**
 * Per-host rate limiter for every outside request the sourcing agents make (stock APIs, YouTube via
 * yt-dlp, DuckDuckGo, web pages). With REDIS_URL the budget lives in Redis (key rate_limit:<name>),
 * so all workers on all machines share it; without, it is kept in this process.
 *
 * Algorithm: sliding window (at most `max` requests in any `windowMs`) plus an optional minimum gap
 * between two requests (`gapMs`, for sites that ban bursts). One Lua script checks and records
 * atomically using Redis' own clock, so workers with skewed clocks agree.
 *
 * Defaults: Pexels 200 / hour, Pixabay 100 / 60 s and Unsplash 50 / hour are the providers'
 * documented API limits (Unsplash: demo apps; only api.unsplash.com counts). YouTube, DuckDuckGo,
 * Wikimedia, Archive and plain web hosts publish no number: those defaults are conservative guesses.
 * Override with RATE_LIMITS="pexels=200/3600,youtube=20/60:2000" (name=max/windowSeconds[:gapMs]).
 */

export interface Limit {
  max: number;
  windowMs: number;
  gapMs: number;
}

const DEFAULTS: Record<string, Limit> = {
  pexels: { max: 200, windowMs: 3_600_000, gapMs: 0 },
  pixabay: { max: 100, windowMs: 60_000, gapMs: 0 },
  unsplash: { max: 50, windowMs: 3_600_000, gapMs: 0 },
  youtube: { max: 30, windowMs: 60_000, gapMs: 1500 },
  duckduckgo: { max: 20, windowMs: 60_000, gapMs: 2000 },
  wikimedia: { max: 100, windowMs: 60_000, gapMs: 200 },
  archive: { max: 60, windowMs: 60_000, gapMs: 500 },
  storyblocks: { max: 60, windowMs: 60_000, gapMs: 0 },
  retail: { max: 20, windowMs: 60_000, gapMs: 2000 },
};
/**
 * Any other host: CDN files (thumbnails, video files: not API calls, CLIP ranking fetches dozens per
 * scene) and brand sites. 10 per second per host keeps us polite without stalling a scene.
 */
const HOST_DEFAULT: Limit = { max: 600, windowMs: 60_000, gapMs: 0 };

export function limitFor(name: string): Limit {
  const custom = parseLimits(env("RATE_LIMITS", ""));
  return custom[name] ?? (name.startsWith("host:") ? custom.host : undefined) ?? DEFAULTS[name] ?? HOST_DEFAULT;
}

export function parseLimits(raw: string): Record<string, Limit> {
  const out: Record<string, Limit> = {};
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = part.match(/^([\w:.-]+)=(\d+)\/(\d+(?:\.\d+)?)(?::(\d+))?$/);
    if (m) out[m[1]] = { max: Number(m[2]), windowMs: Math.round(Number(m[3]) * 1000), gapMs: Number(m[4] ?? 0) };
  }
  return out;
}

/** Limiter name of a URL: the API it counts against, else the host. */
export function limitKeyFor(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return "host:invalid";
  }
  const h = u.hostname.toLowerCase();
  const is = (d: string) => h === d || h.endsWith(`.${d}`);
  // Pages and searches only: thumbnails (i.ytimg.com) and media files are plain CDN hosts.
  if (is("youtube.com") || is("youtu.be")) return "youtube";
  if (h === "api.pexels.com") return "pexels";
  if (is("pixabay.com") && u.pathname.startsWith("/api")) return "pixabay";
  if (h === "api.unsplash.com") return "unsplash";
  if (h !== "upload.wikimedia.org" && (is("wikimedia.org") || is("wikipedia.org"))) return "wikimedia";
  if (is("archive.org")) return "archive";
  if (is("duckduckgo.com")) return "duckduckgo";
  if (is("storyblocks.com") || is("videoblocks.com")) return "storyblocks";
  return `host:${h}`;
}

// KEYS[1] sliding-window zset, KEYS[2] last-request time. ARGV: max, windowMs, gapMs, member.
// Returns 0 when the request may go now (and records it), else the milliseconds to wait.
const SCRIPT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local max = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
local gap = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - win)
local wait = 0
if redis.call('ZCARD', KEYS[1]) >= max then
  local oldest = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  wait = tonumber(oldest[2]) + win - now
end
if gap > 0 then
  local last = tonumber(redis.call('GET', KEYS[2]) or '0')
  if now - last < gap then wait = math.max(wait, last + gap - now) end
end
if wait > 0 then return wait end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], win)
if gap > 0 then redis.call('SET', KEYS[2], now, 'PX', math.max(gap, 1000)) end
return 0
`;

/** In-process fallback: the same rules over this process's own requests. */
const local = new Map<string, { times: number[]; last: number }>();
function localTry(name: string, l: Limit, now = Date.now()): number {
  const s = local.get(name) ?? { times: [], last: 0 };
  local.set(name, s);
  s.times = s.times.filter((t) => t > now - l.windowMs);
  let wait = s.times.length >= l.max ? s.times[0] + l.windowMs - now : 0;
  if (l.gapMs > 0 && now - s.last < l.gapMs) wait = Math.max(wait, s.last + l.gapMs - now);
  if (wait > 0) return wait;
  s.times.push(now);
  s.last = now;
  return 0;
}

let redisBroken = false;

/** One attempt: 0 = go (recorded), else ms to wait. Redis errors fall back to the local limiter. */
export async function tryAcquire(name: string, l = limitFor(name)): Promise<number> {
  const r = redisBroken ? null : redis();
  if (!r) return localTry(name, l);
  try {
    const member = `${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
    return Number(await r.eval(SCRIPT, 2, `rate_limit:${name}`, `rate_limit:${name}:last`, l.max, l.windowMs, l.gapMs, member));
  } catch (err) {
    redisBroken = true;
    console.warn(`[rate-limit] Redis unavailable (${String((err as Error).message ?? err).slice(0, 120)}); limiting per process from now on`);
    return localTry(name, l);
  }
}

const said = new Set<string>();

/**
 * Waits until a request to `name` is allowed (RATE_LIMIT=off skips). Gives up after
 * RATE_LIMIT_MAX_WAIT_MS (default 15 min) with RateLimitWaitError, so a job never waits forever.
 */
export async function acquire(name: string, log: (m: string) => void = console.log): Promise<void> {
  if (env("RATE_LIMIT", "on").toLowerCase() === "off") return;
  const maxWait = Number(env("RATE_LIMIT_MAX_WAIT_MS", "900000"));
  const t0 = Date.now();
  for (;;) {
    const wait = await tryAcquire(name);
    if (wait <= 0) return;
    if (Date.now() - t0 + wait > maxWait) throw new RateLimitWaitError(name, wait);
    if (wait > 5000 && !said.has(name)) {
      said.add(name);
      log(`[rate-limit] ${name}: budget used up, waiting ${Math.ceil(wait / 1000)} s (shared by all workers)`);
    }
    await new Promise((res) => setTimeout(res, wait + Math.floor(Math.random() * 50)));
  }
}

export class RateLimitWaitError extends Error {
  constructor(readonly limiter: string, readonly waitMs: number) {
    super(`rate limit ${limiter}: next slot in ${Math.ceil(waitMs / 1000)} s, more than RATE_LIMIT_MAX_WAIT_MS`);
  }
}

/** fetch() that first takes a slot from the URL's limiter. */
export async function limitedFetch(url: string, init?: RequestInit): Promise<Response> {
  await acquire(limitKeyFor(url));
  return fetch(url, init);
}
