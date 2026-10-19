import { acquire, limitKeyFor } from "./rateLimit.js";

/**
 * fetch() with retries on network failures (dropped connection, DNS hiccup, connect timeout).
 * The link on this machine is slow and drops now and then; one failed search used to turn a
 * scene into a text card. HTTP error statuses are returned as-is (callers handle 429 etc.).
 */
export async function netFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}, waits = [2000, 6000]): Promise<Response> {
  const { timeoutMs = 30_000, ...rest } = init;
  let lastErr: unknown;
  for (const wait of [0, ...waits]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    // Every attempt takes a slot from the host's limiter (shared via Redis when configured).
    await acquire(limitKeyFor(url));
    try {
      return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
