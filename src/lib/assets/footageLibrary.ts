import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { env } from "../env.js";
import { paths } from "../paths.js";
import type { Asset } from "./types.js";

/**
 * Footage library: every clip ClipForge downloads and uses is remembered with its CLIP embedding
 * (cache/footage_library.sqlite via Node's built-in node:sqlite, no native build; falls back to
 * cache/footage_library.json if node:sqlite is unavailable). Before searching for a scene, the
 * library is checked first; a stored clip whose similarity to the scene text is at least
 * LIBRARY_MIN_MATCH is reused without any search or download.
 */

export interface LibraryShot {
  id: string;
  path: string;
  source: string;
  url: string;
  license: string;
  author?: string;
  kind: "video" | "image";
  duration?: number;
  width?: number;
  height?: number;
  title?: string;
  model: string;
  embedding: number[];
  added: string;
}

const DB_FILE = path.join(paths.root, "cache", "footage_library.sqlite");
const JSON_FILE = path.join(paths.root, "cache", "footage_library.json");

export const libraryEnabled = () => env("FOOTAGE_LIBRARY", "on").toLowerCase() !== "off";
export const libraryMinMatch = () => Number(env("LIBRARY_MIN_MATCH", "0.27")) || 0.27;

type Db = { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; all(...a: unknown[]): unknown[] } };

let db: Db | null | undefined;
function open(): Db | null {
  if (db !== undefined) return db;
  try {
    const req = createRequire(import.meta.url);
    const { DatabaseSync } = req("node:sqlite") as { DatabaseSync: new (f: string) => Db };
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    db = new DatabaseSync(DB_FILE);
    db.exec(`CREATE TABLE IF NOT EXISTS shots (
      id TEXT PRIMARY KEY, path TEXT NOT NULL, source TEXT, url TEXT, license TEXT, author TEXT, kind TEXT,
      duration REAL, width INTEGER, height INTEGER, title TEXT, model TEXT, embedding TEXT, added TEXT)`);
  } catch {
    db = null;
  }
  return db;
}

function readJsonLib(): LibraryShot[] {
  try {
    return JSON.parse(fs.readFileSync(JSON_FILE, "utf8"));
  } catch {
    return [];
  }
}

export const libraryBackend = () => (open() ? "sqlite" : "json");

/** All usable shots (file still on disk) embedded with `model`. */
export function loadLibrary(model: string): LibraryShot[] {
  const d = open();
  const rows: LibraryShot[] = d
    ? (d.prepare("SELECT * FROM shots WHERE model = ?").all(model) as Record<string, unknown>[]).map((r) => ({ ...(r as unknown as LibraryShot), embedding: JSON.parse(String(r.embedding)) }))
    : readJsonLib().filter((s) => s.model === model);
  return rows.filter((s) => fs.existsSync(s.path));
}

export function addToLibrary(shots: LibraryShot[]): number {
  if (!shots.length) return 0;
  const d = open();
  if (d) {
    const st = d.prepare(
      `INSERT OR REPLACE INTO shots (id,path,source,url,license,author,kind,duration,width,height,title,model,embedding,added)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const s of shots)
      st.run(s.id, s.path, s.source, s.url, s.license, s.author ?? null, s.kind, s.duration ?? null, s.width ?? null, s.height ?? null, s.title ?? null, s.model, JSON.stringify(s.embedding), s.added);
  } else {
    const all = new Map(readJsonLib().map((s) => [s.id, s]));
    for (const s of shots) all.set(s.id, s);
    fs.mkdirSync(path.dirname(JSON_FILE), { recursive: true });
    fs.writeFileSync(JSON_FILE, JSON.stringify([...all.values()]));
  }
  return shots.length;
}

const dot = (a: number[], b: number[]) => {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
};

/** Best library shots for a (normalised) text embedding, highest similarity first. */
export function queryLibrary(lib: LibraryShot[], textVec: number[], top = 5): { shot: LibraryShot; sim: number }[] {
  return lib
    .map((shot) => ({ shot, sim: Math.round(dot(textVec, shot.embedding) * 10000) / 10000 }))
    .sort((a, b) => b.sim - a.sim)
    .slice(0, top);
}

export function libraryAsset(shot: LibraryShot, sim: number, query: string): Asset {
  return {
    path: shot.path,
    source: shot.source as Asset["source"],
    license: shot.license,
    url: shot.url,
    kind: shot.kind,
    author: shot.author ?? undefined,
    width: shot.width ?? undefined,
    height: shot.height ?? undefined,
    duration: shot.duration ?? undefined,
    in: 0,
    query,
    match: sim,
    note: `Reused from footage library (similarity ${sim})`,
  };
}

/** Number of stored clips (any model). */
export function librarySize(): number {
  const d = open();
  if (d) return Number((d.prepare("SELECT COUNT(*) AS n FROM shots").all()[0] as { n: number }).n);
  return readJsonLib().length;
}
