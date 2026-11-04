import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

/**
 * What a channel has already made: channels/<id>/history/<project>.json, one file per script
 * (title, topic, the script text, when). Used to keep new ideas, titles and scripts from repeating
 * the channel's own past videos (YouTube's "repetitive content" risk), not only competitors'.
 */

export interface HistoryEntry {
  project: string;
  title: string;
  topic: string;
  text: string;
  at: string;
  /** nomic-embed-text vector of the text (filled when embeddings are on). */
  vec?: number[] | null;
  titleVec?: number[] | null;
}

export const historyDir = (channel: string) => path.join(paths.channels, channel, "history");
const ID = /^[a-z0-9][a-z0-9_-]{0,60}$/;

export function recordHistory(channel: string, e: Omit<HistoryEntry, "at"> & { at?: string }): void {
  if (!ID.test(channel) || !ID.test(e.project.toLowerCase())) return;
  fs.mkdirSync(historyDir(channel), { recursive: true });
  fs.writeFileSync(path.join(historyDir(channel), `${e.project}.json`), JSON.stringify({ ...e, at: e.at ?? new Date().toISOString() }) + "\n");
}

/** The newest `limit` entries (newest first), optionally without one project (the one being written). */
export function loadHistory(channel: string, o: { limit?: number; exclude?: string } = {}): HistoryEntry[] {
  if (!ID.test(channel) || !fs.existsSync(historyDir(channel))) return [];
  return fs
    .readdirSync(historyDir(channel))
    .filter((f) => f.endsWith(".json") && f !== `${o.exclude}.json`)
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(historyDir(channel), f), "utf8")) as HistoryEntry;
      } catch {
        return null;
      }
    })
    .filter((x): x is HistoryEntry => !!x && typeof x.text === "string")
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, o.limit ?? 20);
}

/** Our own past titles for a channel: the history plus every project made for it. */
export function pastTitles(channel: string): string[] {
  const out = new Set(loadHistory(channel, { limit: 500 }).map((h) => h.title).filter(Boolean));
  if (fs.existsSync(paths.workspace)) {
    for (const d of fs.readdirSync(paths.workspace)) {
      const pj = path.join(paths.workspace, d, "project.json");
      const cj = path.join(paths.workspace, d, "pipeline.json");
      try {
        const p = fs.existsSync(pj) ? (JSON.parse(fs.readFileSync(pj, "utf8")) as { channel?: string; title?: string }) : {};
        const c = fs.existsSync(cj) ? (JSON.parse(fs.readFileSync(cj, "utf8")) as { channel?: string; topic?: string }) : {};
        if ((p.channel ?? c.channel) !== channel) continue;
        if (p.title) out.add(p.title);
        else if (c.topic) out.add(c.topic);
      } catch {
        /* a broken project file is skipped */
      }
    }
  }
  return [...out];
}
