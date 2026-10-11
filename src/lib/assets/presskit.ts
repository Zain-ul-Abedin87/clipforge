import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";

const MEDIA = /\.(jpe?g|png|webp|mp4|mov|m4v|webm)$/i;
const MAX_BYTES = 600 * 1024 * 1024;
export const USER_AGENT = "ClipForge/0.1 (local faceless-video tool; personal use)";

/** "Ruger 10/22 Takedown" -> "ruger-10-22-takedown": folder names double as match tags. */
export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

const readMeta = (file: string) =>
  fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) : {};

export interface PresskitProduct {
  product: string;
  folder: string;
  files: { name: string; url: string; license: string; bytes: number }[];
}

export function listPresskit(channel: string): PresskitProduct[] {
  const root = path.join(paths.channels, channel, "presskit");
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const dir = path.join(root, d.name);
      const meta = readMeta(path.join(dir, "sources.json"));
      const files = fs
        .readdirSync(dir)
        .filter((f) => MEDIA.test(f))
        .map((f) => ({
          name: f,
          url: meta.files?.[f]?.url ?? meta.url ?? "",
          license: meta.files?.[f]?.license ?? meta.license ?? "",
          bytes: fs.statSync(path.join(dir, f)).size,
        }));
      return { product: meta.product ?? d.name, folder: d.name, files };
    });
}

/**
 * Downloads one official media file into channels/<ch>/presskit/<product>/ and records its
 * source page and license in that folder's sources.json (read by the asset resolver).
 */
export async function addPresskitFile(channel: string, product: string, url: string, license: string): Promise<{ file: string; bytes: number }> {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) links");
  if (/^(localhost|127\.|10\.|192\.168\.|\[?::1)/.test(u.hostname)) throw new Error("local addresses are not allowed");
  const dir = path.join(paths.channels, channel, "presskit", slug(product));

  // Media sites (Wikimedia in particular) reject anonymous clients; identify the tool honestly.
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000), redirect: "follow", headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const type = res.headers.get("content-type") ?? "";
  // A ".jpg"-looking URL can still be a web page (e.g. a Wikimedia "File:" page): trust the
  // server's content type first, the extension only when the type is missing or generic.
  const generic = !type || /octet-stream|binary/i.test(type);
  if (!/^(image|video)\//.test(type) && !(generic && MEDIA.test(u.pathname))) {
    throw new Error(`not an image or video (${type || "unknown type"}) - paste the direct file link, not the web page`);
  }
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Error("file larger than 600 MB");

  const guessed = type.includes("png") ? ".png" : type.includes("webp") ? ".webp" : type.startsWith("video") ? ".mp4" : ".jpg";
  const ext = (u.pathname.match(MEDIA)?.[0] ?? guessed).toLowerCase();
  const base = slug(path.basename(u.pathname).replace(MEDIA, "")) || "media";
  fs.mkdirSync(dir, { recursive: true }); // only after a successful response, so failures leave no empty folder
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("file larger than 600 MB");
  fs.writeFileSync(path.join(dir, name), buf);

  const src = path.join(dir, "sources.json");
  const meta = readMeta(src);
  meta.product = product;
  meta.files = { ...(meta.files ?? {}), [name]: { url, license, added: new Date().toISOString() } };
  fs.writeFileSync(src, JSON.stringify(meta, null, 2));
  return { file: path.join(dir, name), bytes: buf.length };
}

export function removePresskitFile(channel: string, folder: string, name: string): void {
  const dir = path.join(paths.channels, channel, "presskit", slug(folder));
  const file = path.join(dir, path.basename(name));
  if (file.startsWith(dir) && fs.existsSync(file)) fs.rmSync(file);
}
