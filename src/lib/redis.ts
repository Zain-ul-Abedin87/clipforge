import { Redis } from "ioredis";
import { env } from "./env.js";

/**
 * Optional Redis. REDIS_URL set: persistent job queues (BullMQ), job state and logs, and the
 * per-host rate limiter are shared by every process and machine using that Redis. Not set: the
 * app runs exactly as before (workspace/queue.json, in-memory state, in-process limiter).
 */
export const redisUrl = (): string | null => env("REDIS_URL") || null;

let shared: Redis | null = null;

/** One lazily created connection per process (state store, rate limiter). */
export function redis(): Redis | null {
  const url = redisUrl();
  if (!url) return null;
  if (!shared) {
    shared = new Redis(url, { maxRetriesPerRequest: 3, enableOfflineQueue: true, lazyConnect: false });
    shared.on("error", (e) => console.warn(`[redis] ${String(e.message ?? e).slice(0, 160)}`));
  }
  return shared;
}

/** Closes the shared connection so a finished CLI step can exit (an open socket keeps it alive). */
export async function closeRedis(): Promise<void> {
  const r = shared;
  shared = null;
  if (r) await r.quit().catch(() => r.disconnect());
}

/** BullMQ connection options (its workers need maxRetriesPerRequest: null). */
export function bullConnection(): { url: string; maxRetriesPerRequest: null } | null {
  const url = redisUrl();
  return url ? { url, maxRetriesPerRequest: null } : null;
}
