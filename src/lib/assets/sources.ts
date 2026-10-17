import { env } from "../env.js";
import { isBlocked, Niche } from "../niche.js";
import { downloadArchive, searchArchive } from "./archive.js";
import { downloadStock, searchPexels, searchPixabay } from "./stock.js";
import type { Candidate } from "./types.js";
import { downloadUnsplash, searchUnsplash } from "./unsplash.js";
import { downloadWikimedia, searchWikimediaVideo } from "./wikimedia.js";
import { downloadYoutubeCC, searchYoutubeCC } from "./youtube.js";
import { downloadStoryblocks, searchStoryblocks } from "./storyblocks.js";
import { downloadWebCrawl, searchWebCrawl } from "./webCrawl.js";
import { candidateLicenseInfo } from "./licenseLedger.js";

/** Stock providers a niche can list in stock.sources, in the order it wants them tried. */
export const STOCK_PROVIDERS = ["storyblocks", "pixabay", "pexels", "unsplash", "wikimedia_video", "archive", "youtube_cc", "web_crawl"] as const;
export type StockProvider = (typeof STOCK_PROVIDERS)[number];

/**
 * Exact-model footage policy (default): videos only show the user's own uploads ("local"), brand /
 * press-kit media ("presskit", incl. the official importer) and verified clips of the exact model
 * harvested from YouTube ("youtube_exact_model", src/lib/agents/youtube/ytExtractor.ts). Every generic stock
 * provider above (Pexels, Pixabay, Unsplash, Wikimedia, Archive.org, Storyblocks, CC / web crawls) is
 * off unless GENERIC_STOCK=on in .env.
 */
export const EXACT_MODEL_SOURCES = ["local", "presskit", "youtube_exact_model"] as const;
export const genericStockAllowed = () => env("GENERIC_STOCK", "off").toLowerCase() === "on";

export class RateLimited extends Error {}

export async function searchProvider(provider: StockProvider, query: string, niche: Niche): Promise<Candidate[]> {
  // Generic stock is never searched (no network call) unless explicitly enabled.
  if (!genericStockAllowed()) return [];
  let found: Candidate[];
  try {
    if (provider === "storyblocks") found = await searchStoryblocks(query);
    else if (provider === "pixabay") found = await searchPixabay(query);
    else if (provider === "pexels") found = await searchPexels(query);
    else if (provider === "unsplash") found = await searchUnsplash(query);
    else if (provider === "wikimedia_video") found = await searchWikimediaVideo(query, niche.stock.blockedTerms);
    else if (provider === "youtube_cc") found = await searchYoutubeCC(query);
    else if (provider === "web_crawl") found = await searchWebCrawl(query);
    else found = await searchArchive(query);
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    if (/rate limit/i.test(msg)) throw new RateLimited(msg);
    throw err;
  }
  // Niche safety filter on titles/tags (no toys, airsoft, war footage in a gun review...). Every
  // candidate carries its licence class so the ledger and the swap list agree on what it is.
  return found.filter((c) => !isBlocked(niche, c.tags ?? "")).map((c) => ({ ...c, licenseClass: candidateLicenseInfo(c).licenseClass }));
}

/** The niche's stock order (empty under the exact-model policy); older rule files get Pixabay then Pexels. */
export function nicheProviders(niche: Niche): StockProvider[] {
  if (!genericStockAllowed()) return [];
  const list = (niche.stock as { sources?: string[] }).sources ?? ["pixabay", "pexels"];
  return list.filter((p): p is StockProvider => (STOCK_PROVIDERS as readonly string[]).includes(p));
}

/** Downloads any remote candidate into the shared media cache and returns the local path. */
export async function downloadCandidate(c: Candidate): Promise<string> {
  if (c.source === "pexels" || c.source === "pixabay") return downloadStock(c);
  if (c.source === "unsplash") return downloadUnsplash(c);
  if (c.source === "wikimedia") return downloadWikimedia(c);
  if (c.source === "archive") return downloadArchive(c);
  if (c.source === "youtube_cc") return downloadYoutubeCC(c);
  if (c.source === "storyblocks") return downloadStoryblocks(c);
  if (c.source === "web_crawl") return downloadWebCrawl(c);
  return c.location; // local / press kit files are already on disk
}
