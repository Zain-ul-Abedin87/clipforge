import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { paths } from "./paths.js";
import { slug } from "./assets/presskit.js";

const readJsonFile = (f: string) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const styleFile = (ch: string) => path.join(paths.channels, ch, "style.json");

/** New channel = copy of an existing one's style.json, with its own empty media folders. */
export function createChannel(name: string, copyFrom = "default"): string {
  const id = slug(name);
  if (!id) throw new Error("give the channel a name");
  const dir = path.join(paths.channels, id);
  if (fs.existsSync(dir)) throw new Error(`channel "${id}" already exists`);
  const base = fs.existsSync(styleFile(copyFrom)) ? readJsonFile(styleFile(copyFrom)) : {};
  for (const sub of ["footage", "music", "logo", "presskit"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  fs.writeFileSync(path.join(dir, "style.json"), JSON.stringify({ ...base, name: id, logo: { ...(base.logo ?? {}), path: null } }, null, 2) + "\n");
  return id;
}

/**
 * Settings the review page may change. Anything else in style.json stays as the user wrote it.
 * Values are validated so a typo cannot break a render.
 */
export function updateStyle(channel: string, patch: Record<string, unknown>): Record<string, unknown> {
  const f = styleFile(channel);
  const s = readJsonFile(f);
  const hex = (v: unknown) => (typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v) ? v : undefined);
  const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && v >= lo && v <= hi ? v : undefined);
  const set = (obj: Record<string, unknown>, key: string, v: unknown) => {
    if (v !== undefined) obj[key] = v;
  };
  const p = patch as Record<string, Record<string, unknown> & unknown>;
  if (typeof p.niche === "string" && /^[a-z0-9_-]+$/.test(p.niche)) s.niche = p.niche;
  s.colors ??= {};
  for (const k of ["primary", "secondary", "text", "accent"]) set(s.colors, k, hex(p.colors?.[k]));
  s.captions ??= {};
  if (typeof p.captions?.enabled === "boolean") s.captions.enabled = p.captions.enabled;
  set(s.captions, "fontSize", num(p.captions?.fontSize, 30, 90));
  set(s.captions, "maxWordsPerLine", num(p.captions?.maxWordsPerLine, 3, 12));
  s.music ??= {};
  set(s.music, "volumeDb", num(p.music?.volumeDb, -40, -6));
  set(s.music, "duckDb", num(p.music?.duckDb, -30, 0));
  s.motionGraphics ??= {};
  if (typeof p.motionGraphics?.enabled === "boolean") s.motionGraphics.enabled = p.motionGraphics.enabled;
  if (typeof p.motionGraphics?.sfx === "boolean") s.motionGraphics.sfx = p.motionGraphics.sfx;
  set(s.motionGraphics, "sfxDb", num(p.motionGraphics?.sfxDb, -30, -4));
  s.logo ??= {};
  if (["top-right", "top-left", "bottom-right", "bottom-left"].includes(String(p.logo?.position))) s.logo.position = p.logo.position;
  set(s.logo, "opacity", num(p.logo?.opacity, 0.1, 1));
  const ai: unknown = patch.aiDisclosure;
  if (ai === "always" || ai === true || ai === false) s.aiDisclosure = ai;
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  return s;
}

async function saveUpload(req: IncomingMessage, dest: string, maxBytes: number): Promise<number> {
  const part = `${dest}.part`;
  let bytes = 0;
  await new Promise<void>((resolve, reject) => {
    const ws = fs.createWriteStream(part);
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > maxBytes) {
        req.destroy();
        ws.destroy();
        reject(new Error(`file larger than ${Math.round(maxBytes / 1024 / 1024)} MB`));
      }
    });
    req.pipe(ws);
    ws.on("finish", () => resolve());
    ws.on("error", reject);
  }).catch((e) => {
    fs.rmSync(part, { force: true });
    throw e;
  });
  fs.renameSync(part, dest);
  return bytes;
}

/** Logo (PNG with transparency works best) shown in a corner of every video of the channel. */
export async function saveLogo(req: IncomingMessage, channel: string, filename: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) throw new Error("logo must be png, jpg or webp");
  const dir = path.join(paths.channels, channel, "logo");
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `logo${ext}`);
  await saveUpload(req, dest, 20 * 1024 * 1024);
  const f = styleFile(channel);
  const s = readJsonFile(f);
  s.logo = { position: "top-right", opacity: 0.8, ...(s.logo ?? {}), path: dest };
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
  return dest;
}

export function removeLogo(channel: string): void {
  const f = styleFile(channel);
  const s = readJsonFile(f);
  if (s.logo?.path) fs.rmSync(s.logo.path, { force: true });
  s.logo = { ...(s.logo ?? {}), path: null };
  fs.writeFileSync(f, JSON.stringify(s, null, 2) + "\n");
}

/** Background music track with a required licence note (kept in music/sources.json). */
export async function saveMusic(req: IncomingMessage, channel: string, filename: string, note: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (![".mp3", ".wav", ".m4a", ".ogg", ".flac"].includes(ext)) throw new Error("music must be mp3, wav, m4a, ogg or flac");
  if (!note.trim()) throw new Error("write where the track comes from (licence)");
  const dir = path.join(paths.channels, channel, "music");
  fs.mkdirSync(dir, { recursive: true });
  const base = slug(path.basename(filename, ext)) || "track";
  let name = `${base}${ext}`;
  for (let i = 2; fs.existsSync(path.join(dir, name)); i++) name = `${base}-${i}${ext}`;
  await saveUpload(req, path.join(dir, name), 200 * 1024 * 1024);
  const src = path.join(dir, "sources.json");
  const meta = fs.existsSync(src) ? readJsonFile(src) : {};
  meta[name] = { license: note.trim(), added: new Date().toISOString(), originalName: filename };
  fs.writeFileSync(src, JSON.stringify(meta, null, 2));
  return name;
}

export function listMusic(channel: string): { name: string; license: string; bytes: number }[] {
  const dir = path.join(paths.channels, channel, "music");
  if (!fs.existsSync(dir)) return [];
  const src = path.join(dir, "sources.json");
  const meta = fs.existsSync(src) ? readJsonFile(src) : {};
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(mp3|wav|m4a|ogg|flac)$/i.test(f))
    .map((f) => ({ name: f, license: meta[f]?.license ?? "", bytes: fs.statSync(path.join(dir, f)).size }));
}

export function removeMusic(channel: string, name: string): void {
  const dir = path.join(paths.channels, channel, "music");
  const file = path.join(dir, path.basename(name));
  if (file.startsWith(dir)) fs.rmSync(file, { force: true });
}
