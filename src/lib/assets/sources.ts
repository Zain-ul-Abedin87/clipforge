import { isBlocked, Niche } from "../niche.js";
import { downloadArchive, searchArchive } from "./archive.js";
import { downloadStock, searchPexels, searchPixabay } from "./stock.js";
import type { Candidate } from "./types.js";
import { downloadUnsplash, searchUnsplash } from "./unsplash.js";
import { downloadWikimedia, searchWikimediaVideo } from "./wikimedia.js";

/** Stock providers a niche can list in stock.sources, in the order it wants them tried. */
export const STOCK_PROVIDERS = ["pixabay", "pexels", "unsplash", "wikimedia_video", "archive"] as const;
export type StockProvider = (typeof STOCK_PROVIDERS)[number];

export class RateLimited extends Error {}

export async function searchProvider(provider: StockProvider, query: string, niche: Niche): Promise<Candidate[]> {
  let found: Candidate[];
  try {
    if (provider === "pixabay") found = await searchPixabay(query);
    else if (provider === "pexels") found = await searchPexels(query);
    else if (provider === "unsplash") found = await searchUnsplash(query);
    else if (provider === "wikimedia_video") found = await searchWikimediaVideo(query, niche.stock.blockedTerms);
    else found = await searchArchive(query);
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (/rate limit/i.test(msg)) throw new RateLimited(msg);
    throw err;
  }
  // Niche safety filter on titles/tags (no toys, airsoft, war footage in a gun review...).
  return found.filter((c) => !isBlocked(niche, c.tags ?? ""));
}

/** The niche's stock order; older rule files without stock.sources get Pixabay then Pexels. */
export function nicheProviders(niche: Niche): StockProvider[] {
  const list = (niche.stock as { sources?: string[] }).sources ?? ["pixabay", "pexels"];
  return list.filter((p): p is StockProvider => (STOCK_PROVIDERS as readonly string[]).includes(p));
}

/** Downloads any remote candidate into the shared media cache and returns the local path. */
export async function downloadCandidate(c: Candidate): Promise<string> {
  if (c.source === "pexels" || c.source === "pixabay") return downloadStock(c);
  if (c.source === "unsplash") return downloadUnsplash(c);
  if (c.source === "wikimedia") return downloadWikimedia(c);
  if (c.source === "archive") return downloadArchive(c);
  return c.location; // local / press kit files are already on disk
}
