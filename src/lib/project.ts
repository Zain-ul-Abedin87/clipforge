import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

/** Per-video working folder: workspace/<name>/ holds every step's cached output. */
export function projectDir(name: string): string {
  const dir = path.join(paths.workspace, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function projectNameFromAudio(audio: string): string {
  return path.basename(audio, path.extname(audio)).replace(/[^a-zA-Z0-9_-]+/g, "_");
}

/** Cheap fingerprint for big media files (size + mtime), content hash for small text files. */
export function fingerprint(file: string | null | undefined): string {
  if (!file || !fs.existsSync(file)) return "none";
  const st = fs.statSync(file);
  if (st.size > 5 * 1024 * 1024) return `${st.size}:${st.mtimeMs}`;
  return crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex");
}

interface StepMeta {
  step: string;
  inputs: Record<string, string>;
  finishedAt: string;
}

const metaPath = (dir: string, step: string) => path.join(dir, `.${step}.meta.json`);

/** True when the step's outputs exist and were produced from the same inputs. */
export function isCached(dir: string, step: string, inputs: Record<string, string>, outputs: string[]): boolean {
  const mp = metaPath(dir, step);
  if (!fs.existsSync(mp)) return false;
  if (!outputs.every((o) => fs.existsSync(path.join(dir, o)))) return false;
  const meta: StepMeta = JSON.parse(fs.readFileSync(mp, "utf8"));
  return JSON.stringify(meta.inputs) === JSON.stringify(inputs);
}

export function markDone(dir: string, step: string, inputs: Record<string, string>): void {
  const meta: StepMeta = { step, inputs, finishedAt: new Date().toISOString() };
  fs.writeFileSync(metaPath(dir, step), JSON.stringify(meta, null, 2));
}

export function readJson<T>(file: string): T {
  // Strip a UTF-8 BOM: Notepad and PowerShell add one, JSON.parse rejects it.
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as T;
}

export function writeJson(file: string, data: unknown): void {
  fs.writeFileSync(file, JSON.stringify(data, null, 1));
}
