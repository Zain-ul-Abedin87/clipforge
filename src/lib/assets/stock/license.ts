import fs from "node:fs";

/**
 * Licence metadata saved next to every downloaded / generated visual (`<file>.license.json`) and
 * logged, so each asset's source and licence can be shown and audited later.
 */
export interface LicenseMeta {
  source: string;
  id: string;
  pageUrl: string;
  author?: string;
  license: string;
  licenseUrl?: string;
  attributionRequired: boolean;
  fetchedAt: string;
  query?: string;
  /** Generated pictures: model + prompt. */
  model?: string;
  prompt?: string;
}

export const LICENSE_URLS: Record<string, string> = {
  pexels: "https://www.pexels.com/license/",
  pixabay: "https://pixabay.com/service/license-summary/",
};

export const sidecarOf = (file: string) => `${file}.license.json`;

export function writeLicenseSidecar(file: string, meta: LicenseMeta): string {
  const f = sidecarOf(file);
  fs.writeFileSync(f, JSON.stringify(meta, null, 1));
  return f;
}

export function readLicenseSidecar(file: string): LicenseMeta | null {
  try {
    return JSON.parse(fs.readFileSync(sidecarOf(file), "utf8")) as LicenseMeta;
  } catch {
    return null;
  }
}
