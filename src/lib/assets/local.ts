import fs from "node:fs";
import path from "node:path";
import { run } from "../exec.js";
import { norm } from "../text.js";
import { ffprobePath } from "../tools.js";
import type { Candidate } from "./types.js";

const VIDEO = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v"]);
const IMAGE = new Set([".jpg", ".jpeg", ".png", ".webp"]);

interface Probe {
  mtime: number;
  width: number;
  height: number;
  duration?: number;
}

/** Tokens used for matching: "Mossberg_500-closeup.mp4" -> ["mossberg", "500", "closeup"]. */
export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map(norm)
    .filter((t) => t.length > 1);
}

async function probe(file: string): Promise<Omit<Probe, "mtime"> | null> {
  const fp = ffprobePath();
  if (!fp) return null;
  const r = await run(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration", "-of", "json", file]);
  if (r.code !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const s = j.streams?.[0];
    if (!s) return null;
    const d = Number(j.format?.duration);
    return { width: s.width, height: s.height, duration: Number.isFinite(d) && d > 0.5 ? d : undefined };
  } catch {
    return null;
  }
}

export interface LocalItem {
  file: string;
  kind: "video" | "image";
  tokens: string[];
  width: number;
  height: number;
  duration?: number;
  /** Press-kit folders carry their source page and license in sources.json. */
  pageUrl: string;
  license: string;
}

/**
 * Indexes a media folder recursively. ffprobe results are cached in .index.json (keyed by mtime)
 * so re-runs do not re-probe hundreds of clips. Folder names count as tags: footage/mossberg-500/a.mp4
 * matches "Mossberg 500".
 */
export async function indexFolder(root: string, source: "local" | "presskit"): Promise<LocalItem[]> {
  if (!fs.existsSync(root)) return [];
  const cacheFile = path.join(root, ".index.json");
  const cache: Record<string, Probe> = fs.existsSync(cacheFile) ? JSON.parse(fs.readFileSync(cacheFile, "utf8")) : {};
  const items: LocalItem[] = [];
  let dirty = false;

  const walk = async (dir: string, inherited: { url: string; license: string }) => {
    let meta = inherited;
    let perFile: Record<string, { url?: string; license?: string }> = {};
    const src = path.join(dir, "sources.json");
    if (fs.existsSync(src)) {
      try {
        const j = JSON.parse(fs.readFileSync(src, "utf8").replace(/^﻿/, ""));
        meta = { url: j.url ?? inherited.url, license: j.license ?? inherited.license };
        perFile = j.files ?? {};
      } catch {
        /* malformed sources.json: keep inherited values */
      }
    }
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, meta);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      const kind = VIDEO.has(ext) ? "video" : IMAGE.has(ext) ? "image" : null;
      if (!kind) continue;
      const rel = path.relative(root, full);
      const mtime = fs.statSync(full).mtimeMs;
      let p = cache[rel];
      if (!p || p.mtime !== mtime) {
        const got = await probe(full);
        if (!got) continue;
        p = { mtime, ...got };
        cache[rel] = p;
        dirty = true;
      }
      // Skip portrait media: the output is 16:9.
      if (p.height > p.width) continue;
      items.push({
        file: full,
        kind,
        tokens: tokens(rel),
        width: p.width,
        height: p.height,
        duration: kind === "video" ? p.duration : undefined,
        pageUrl: perFile[entry.name]?.url ?? meta.url,
        license: perFile[entry.name]?.license ?? meta.license,
      });
    }
  };

  const defaults =
    source === "local"
      ? { url: "", license: "Own footage" }
      : { url: "", license: "Manufacturer press kit (license not recorded - add sources.json)" };
  await walk(root, defaults);
  if (dirty) fs.writeFileSync(cacheFile, JSON.stringify(cache));
  return items;
}

/** Scores items against the scene: product-name tokens weigh most, then query tokens. */
export function matchLocal(items: LocalItem[], source: "local" | "presskit", wantTokens: string[], productTokens: string[]): Candidate[] {
  const out: Candidate[] = [];
  for (const it of items) {
    const set = new Set(it.tokens);
    let score = 0;
    if (productTokens.length) {
      const hit = productTokens.filter((t) => set.has(t)).length;
      // All product tokens must match ("glock 19" never matches a "glock 17" clip).
      if (hit === productTokens.length) score += 10 + hit;
      else if (source === "presskit") continue;
    }
    score += wantTokens.filter((t) => set.has(t)).length;
    if (score <= 0) continue;
    out.push({
      source,
      id: it.file,
      kind: it.kind,
      location: it.file,
      pageUrl: it.pageUrl,
      license: it.license,
      width: it.width,
      height: it.height,
      duration: it.duration,
      // Prefer video over stills at equal relevance.
      score: score + (it.kind === "video" ? 0.5 : 0),
    });
  }
  return out.sort((a, b) => b.score - a.score);
}
