import { hasKey } from "../../env.js";
import { downloadStock, searchPexels } from "../stock.js";
import type { Candidate } from "../types.js";
import { LICENSE_URLS, LicenseMeta, writeLicenseSidecar } from "./license.js";

/**
 * Pexels videos (PEXELS_API_KEY, free). Search and download reuse src/lib/assets/stock.ts (24 h
 * search cache, rate-limit spacing, 1080p file pick); this module adds the licence metadata.
 */

export const pexelsConfigured = () => hasKey("PEXELS_API_KEY");

export function pexelsLicense(c: Candidate, query?: string): LicenseMeta {
  return { source: "pexels", id: c.id, pageUrl: c.pageUrl, author: c.author, license: c.license, licenseUrl: LICENSE_URLS.pexels, attributionRequired: false, fetchedAt: new Date().toISOString(), query };
}

export async function searchPexelsVideos(query: string): Promise<Candidate[]> {
  return pexelsConfigured() ? searchPexels(query) : [];
}

/** Downloads the clip and saves `<file>.license.json`. */
export async function downloadPexels(c: Candidate, query?: string): Promise<{ file: string; license: LicenseMeta }> {
  const file = await downloadStock(c);
  const license = pexelsLicense(c, query);
  writeLicenseSidecar(file, license);
  return { file, license };
}
