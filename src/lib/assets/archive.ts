import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { netFetch } from "../net.js";
import { ffmpegPath } from "../tools.js";
import { USER_AGENT } from "./presskit.js";
import type { Candidate } from "./types.js";

const CACHE = path.join(paths.root, "cache");
const SEARCH_CACHE = path.join(CACHE, "search");
const MEDIA_CACHE = path.join(CACHE, "media");
const TTL = 7 * 24 * 3600 * 1000;
const SEGMENT = 15;

/**
 * Licences a monetized channel may use: public domain / CC0 / CC BY / CC BY-SA.
 * NonCommercial (NC) and NoDerivatives (ND) are excluded (cutting a clip is a derivative).
 */
export function usableLicense(url: string): string | null {
  const u = url.toLowerCase();
  if (/publicdomain|\/zero\//.test(u)) return "Public domain";
  if (/-nc|-nd/.test(u)) return null;
  const m = u.match(/licenses\/(by(?:-sa)?)\//);
  return m ? `CC ${m[1].toUpperCase()}` : null;
}

async function cachedJson<T>(key: string, url: string): Promise<T> {
  fs.mkdirSync(SEARCH_CACHE, { recursive: true });
  const f = path.join(SEARCH_CACHE, `${crypto.createHash("sha1").update(key).digest("hex").slice(0, 16)}.json`);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < TTL) return JSON.parse(fs.readFileSync(f, "utf8"));
  const res = await netFetch(url, { headers: { "User-Agent": USER_AGENT }, timeoutMs: 30_000 });
  if (!res.ok) throw new Error(`Archive.org ${res.status}`);
  const data = (await res.json()) as T;
  fs.writeFileSync(f, JSON.stringify(data));
  return data;
}

interface ArchiveFile { name: string; format: string; size?: string; length?: string; width?: string; height?: string }

/**
 * Archive.org films with a usable licence (best for history / documentary channels). Only the
 * few most relevant items are inspected, and only files at least 640 px wide are kept.
 */
export async function searchArchive(query: string): Promise<Candidate[]> {
  const q = `(${query}) AND mediatype:movies AND licenseurl:*`;
  const url =
    "https://archive.org/advancedsearch.php?output=json&rows=12" +
    `&q=${encodeURIComponent(q)}&fl%5B%5D=identifier&fl%5B%5D=title&fl%5B%5D=licenseurl&fl%5B%5D=creator`;
  const found = await cachedJson<{ response: { docs: { identifier: string; title: string; licenseurl: string; creator?: string }[] } }>(`archive-v3:${query}`, url);

  const out: Candidate[] = [];
  for (const d of found.response.docs.filter((d) => usableLicense(d.licenseurl)).slice(0, 6)) {
    const meta = await cachedJson<{ files?: ArchiveFile[] }>(`archive-meta:${d.identifier}`, `https://archive.org/metadata/${d.identifier}`).catch(() => ({ files: [] }));
    const file = (meta.files ?? [])
      .filter(
        (f) =>
          /\.mp4$/i.test(f.name) &&
          Number(f.width ?? 0) >= 640 &&
          Number(f.width ?? 0) >= Number(f.height ?? 0) * 1.2 && // landscape only
          Number(f.length ?? 0) >= SEGMENT + 5,
      )
      .sort((a, b) => Number(b.width) - Number(a.width))[0];
    if (!file) continue;
    out.push({
      source: "archive",
      id: `archive_${d.identifier.replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      kind: "video",
      location: `https://archive.org/download/${d.identifier}/${encodeURIComponent(file.name)}`,
      pageUrl: `https://archive.org/details/${d.identifier}`,
      license: `${usableLicense(d.licenseurl)} via Archive.org (${d.licenseurl})`,
      author: (Array.isArray(d.creator) ? d.creator[0] : d.creator)?.slice(0, 80),
      width: Number(file.width),
      height: Number(file.height ?? 0),
      // Only a SEGMENT-second piece is fetched, so that is the usable duration.
      duration: SEGMENT,
      score: 3.5 - out.length * 0.1,
      tags: d.title,
      thumbUrl: `https://archive.org/services/img/${d.identifier}`,
      sourceLength: Number(file.length),
    });
  }
  return out;
}

/**
 * Fetches only a short piece of the film (HTTP range reads via FFmpeg), not the whole file:
 * old films are often hundreds of MB. The piece starts ~35% in, past titles and credits.
 */
export async function downloadArchive(c: Candidate, fullLength = c.sourceLength): Promise<string> {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true });
  const out = path.join(MEDIA_CACHE, `${c.id}.mp4`);
  if (fs.existsSync(out)) return out;
  const ff = ffmpegPath();
  if (!ff) throw new Error("ffmpeg not found");
  const start = fullLength ? Math.max(0, Math.min(fullLength * 0.35, fullLength - SEGMENT - 2)) : 30;
  const part = `${out}.part.mp4`;
  // Archive.org servers sometimes stop sending mid-read: give up after 30 s of silence (with
  // reconnect attempts), and never let one piece take longer than 2 minutes overall.
  const r = await run(
    ff,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      "-user_agent", USER_AGENT,
      "-rw_timeout", "30000000",
      "-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5",
      "-ss", start.toFixed(1), "-i", c.location, "-t", String(SEGMENT),
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
      part,
    ],
    { timeoutMs: 120_000 },
  );
  if (r.code !== 0 || !fs.existsSync(part)) {
    fs.rmSync(part, { force: true });
    throw new Error(`Archive.org segment failed: ${r.stderr.slice(-200)}`);
  }
  fs.renameSync(part, out);
  return out;
}
