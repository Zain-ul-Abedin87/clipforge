import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { paths } from "../paths.js";
import { slug } from "./presskit.js";

const MEDIA = /\.(jpe?g|png|webp|mp4|mov|m4v|webm|mkv)$/i;
const MAX_BYTES = 2 * 1024 ** 3;

export type LibraryRoot = "footage" | "presskit";

const readMeta = (file: string) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) : {};

export interface LibraryFolder {
  folder: string;
  label: string;
  files: { name: string; note: string; bytes: number; added?: string }[];
}

/** Folders of a channel's own media (footage/ or presskit/) with each file's source note. */
export function listLibrary(channel: string, root: LibraryRoot): LibraryFolder[] {
  const base = path.join(paths.channels, channel, root);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(base, d.name);
      const meta = readMeta(path.join(dir, "sources.json"));
      return {
        folder: d.name,
        label: meta.product ?? meta.label ?? d.name,
        files: fs
          .readdirSync(dir)
          .filter((f) => MEDIA.test(f))
          .map((f) => ({
            name: f,
            note: meta.files?.[f]?.license ?? meta.license ?? "",
            bytes: fs.statSync(path.join(dir, f)).size,
            added: meta.files?.[f]?.added,
          })),
      };
    })
    .filter((f) => f.files.length);
}

/**
 * Streams an uploaded file into channels/<ch>/<root>/<folder>/ and records where it came from in
 * that folder's sources.json. The folder name doubles as match tags: "sig-sauer-p365" is used for
 * that product's scenes, "pistol-range-shooting" for B-roll scenes with those words.
 */
export async function importFile(
  req: IncomingMessage,
  channel: string,
  root: LibraryRoot,
  label: string,
  filename: string,
  note: string,
): Promise<{ file: string; bytes: number }> {
  const ext = path.extname(filename).toLowerCase();
  if (!MEDIA.test(ext)) throw new Error("only video (mp4, mov, webm, mkv) or photo (jpg, png, webp) files");
  const folder = slug(label);
  if (!folder) throw new Error("give a product name or keywords");
  const dir = path.join(paths.channels, channel, root, folder);
  fs.mkdirSync(dir, { recursive: true });

  const base = slug(path.basename(filename, ext)) || "clip";
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  const dest = path.join(dir, name);
  const part = `${dest}.part`;

  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(part);
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_BYTES) {
        req.destroy();
        ws.destroy();
        reject(new Error("file larger than 2 GB"));
      }
    });
    req.pipe(ws);
    ws.on("finish", () => resolve());
    ws.on("error", reject);
    req.on("error", reject);
  }).catch((err) => {
    fs.rmSync(part, { force: true });
    throw err;
  });
  fs.renameSync(part, dest);

  const src = path.join(dir, "sources.json");
  const meta = readMeta(src);
  meta.label = label;
  if (root === "presskit") meta.product = label;
  meta.files = { ...(meta.files ?? {}), [name]: { url: "", license: note, added: new Date().toISOString(), originalName: filename } };
  fs.writeFileSync(src, JSON.stringify(meta, null, 2));
  return { file: dest, bytes };
}

export function removeLibraryFile(channel: string, root: LibraryRoot, folder: string, name: string): void {
  const dir = path.join(paths.channels, channel, root, slug(folder));
  const file = path.join(dir, path.basename(name));
  if (!file.startsWith(dir) || !fs.existsSync(file)) return;
  fs.rmSync(file);
  const src = path.join(dir, "sources.json");
  const meta = readMeta(src);
  if (meta.files?.[name]) {
    delete meta.files[name];
    fs.writeFileSync(src, JSON.stringify(meta, null, 2));
  }
}
