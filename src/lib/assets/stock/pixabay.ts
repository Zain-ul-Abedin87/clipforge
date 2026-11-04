import { hasKey } from "../../env.js";
import { downloadStock, searchPixabay } from "../stock.js";
import type { Candidate } from "../types.js";
import { LICENSE_URLS, LicenseMeta, writeLicenseSidecar } from "./license.js";

/**
 * Pixabay videos (PIXABAY_API_KEY, free). Search and download reuse src/lib/assets/stock.ts (Pixabay
 * requires its results cached for 24 h); this module adds the licence metadata.
 */

export const pixabayConfigured = () => hasKey("PIXABAY_API_KEY");

export function pixabayLicense(c: Candidate, query?: string): LicenseMeta {
  return { source: "pixabay", id: c.id, pageUrl: c.pageUrl, author: c.author, license: c.license, licenseUrl: LICENSE_URLS.pixabay, attributionRequired: false, fetchedAt: new Date().toISOString(), query };
}

export async function searchPixabayVideos(query: string): Promise<Candidate[]> {
  return pixabayConfigured() ? searchPixabay(query) : [];
}

export async function downloadPixabay(c: Candidate, query?: string): Promise<{ file: string; license: LicenseMeta }> {
  const file = await downloadStock(c);
  const license = pixabayLicense(c, query);
  writeLicenseSidecar(file, license);
  return { file, license };
}
