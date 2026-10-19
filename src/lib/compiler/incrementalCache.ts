import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Incremental render cache. Every scene segment is stored under a SHA-256 of everything that
 * changes its pixels: the asset file(s) (path + size + mtime, so replacing a file on disk
 * invalidates it), captions (times relative to the segment), overlays (and their files),
 * transition, motion, backdrop, logo and frame count. Segments are video only (the voice is muxed
 * once at the end), so neither the voice file nor the scene's position in the video is part of the
 * hash: a scene that only moved (an earlier sentence got longer) keeps its cached file. Files are
 * content-addressed (seg_<hash>.mp4), so a renumbered scene finds its old segment too.
 * (Moved from src/lib/render/sceneHash.ts, which re-exports this module.)
 */

export interface SceneHashInput {
  sceneId: number;
  asset: { path: string; kind: string; source?: string; in?: number; shots?: { path: string; kind: string; in?: number; frames: number; variant?: string }[] };
  /** Caption lines with times relative to the segment start (see relativeCaptions). */
  captions: unknown;
  overlays: readonly object[];
  transition: string;
  motion: string;
  frames: number;
  fadeIn: boolean;
  fadeOut: boolean;
  backdrop?: string | null;
  logo?: { path: string; [k: string]: unknown } | null;
  showcase?: unknown;
  /** Bump when the segment encoder settings change. */
  version: number;
}

/** File identity that changes when the file is replaced or edited: resolved path, size, mtime. */
export function fileStamp(file: string | undefined | null): { path: string; size: number; mtimeMs: number } | null {
  if (!file) return null;
  try {
    const st = fs.statSync(file);
    return { path: path.resolve(file), size: st.size, mtimeMs: Math.round(st.mtimeMs) };
  } catch {
    return { path: path.resolve(file), size: -1, mtimeMs: -1 };
  }
}

/** JSON with sorted keys, so two equal objects always hash the same. */
export function canonicalJson(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export function sceneContentHash(i: SceneHashInput): string {
  const payload = {
    v: i.version,
    asset: {
      file: fileStamp(i.asset.path),
      kind: i.asset.kind,
      source: i.asset.source ?? null,
      in: i.asset.in ?? 0,
      shots: (i.asset.shots ?? []).map((s) => ({ file: fileStamp(s.path), kind: s.kind, in: s.in ?? 0, frames: s.frames, variant: s.variant ?? null })),
    },
    captions: i.captions ?? null,
    overlays: i.overlays.map((o) => {
      const p = (o as { path?: unknown }).path;
      return { ...o, file: fileStamp(typeof p === "string" ? p : null) };
    }),
    transition: i.transition,
    motion: i.motion,
    frames: i.frames,
    fadeIn: i.fadeIn,
    fadeOut: i.fadeOut,
    backdrop: i.backdrop ?? null,
    logo: i.logo ? { ...i.logo, file: fileStamp(i.logo.path) } : null,
    showcase: i.showcase ?? null,
  };
  return crypto.createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Caption lines shifted to the segment's own clock, so a moved scene hashes the same. */
export function relativeCaptions<T extends { start: number; end: number }>(lines: T[], segStart: number): T[] {
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  return lines.map((l) => ({ ...l, start: r3(l.start - segStart), end: r3(l.end - segStart) }));
}

/** Cached segment file: content-addressed (the scene id is not part of the name). */
export const segmentFile = (cacheDir: string, _sceneId: number, hash: string) => path.join(cacheDir, `seg_${hash.slice(0, 24)}.mp4`);

export interface SegmentManifest {
  updatedAt: string;
  scenes: Record<string, { hash: string; file: string; frames: number }>;
}

/** Scenes whose hash differs from the last manifest (what an incremental render will redo). */
export function changedScenes(prev: SegmentManifest | null, next: Record<string, string>): number[] {
  return Object.entries(next)
    .filter(([id, h]) => prev?.scenes[id]?.hash !== h)
    .map(([id]) => Number(id));
}

/** One scene's cache entry for this render. */
export interface CachedSegment {
  sceneId: number;
  hash: string;
  frames: number;
  out: string;
}

/** The segment cache folder of a project (workspace/<project>/cache/segments). */
export class SegmentCache {
  readonly manifestFile: string;
  readonly previous: SegmentManifest | null;

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.manifestFile = path.join(dir, "manifest.json");
    this.previous = fs.existsSync(this.manifestFile) ? (JSON.parse(fs.readFileSync(this.manifestFile, "utf8")) as SegmentManifest) : null;
  }

  file(sceneId: number, hash: string): string {
    return segmentFile(this.dir, sceneId, hash);
  }

  has(seg: CachedSegment): boolean {
    return fs.existsSync(seg.out);
  }

  /** Drops cached files so these segments render again (force / single-scene rerender). */
  invalidate(segs: CachedSegment[]): void {
    for (const s of segs) for (const f of [s.out, `${s.out}.enc`]) fs.rmSync(f, { force: true });
  }

  changed(segs: CachedSegment[]): number[] {
    return changedScenes(this.previous, Object.fromEntries(segs.map((s) => [String(s.sceneId), s.hash])));
  }

  /** Records the current cut and deletes segments no scene references any more. */
  commit(segs: CachedSegment[]): void {
    const manifest: SegmentManifest = { updatedAt: new Date().toISOString(), scenes: Object.fromEntries(segs.map((s) => [String(s.sceneId), { hash: s.hash, file: path.basename(s.out), frames: s.frames }])) };
    fs.writeFileSync(this.manifestFile, JSON.stringify(manifest, null, 1));
    const keep = new Set(segs.flatMap((s) => [path.basename(s.out), `${path.basename(s.out)}.enc`]));
    for (const f of fs.readdirSync(this.dir)) if (/^seg_(\d+_)?[0-9a-f]+\.mp4(\.enc)?$/.test(f) && !keep.has(f)) fs.rmSync(path.join(this.dir, f), { force: true });
  }
}
