import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "../env.js";
import { paths } from "../paths.js";

/**
 * SQLite cache for research (data/research.db, git-ignored), on Node's built-in node:sqlite (no
 * native dependency to build):
 *  - cache:     API answers by request key, with the time they were fetched (TTL per call);
 *  - quota:     YouTube Data API units used per quota day (Pacific time, when Google resets it);
 *  - snapshots: channel view / subscriber counts over time (growth between scans);
 *  - scans:     the last scan results, so the /research page opens instantly.
 */

export const researchDbFile = () => env("RESEARCH_DB", "") || path.join(paths.root, "data", "research.db");

export class ResearchDb {
  readonly db: DatabaseSync;

  constructor(file = researchDbFile()) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, json TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS quota (day TEXT PRIMARY KEY, units INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (channel_id TEXT NOT NULL, at INTEGER NOT NULL, views INTEGER, subs INTEGER, videos INTEGER, PRIMARY KEY (channel_id, at));
      CREATE TABLE IF NOT EXISTS scans (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, seeds TEXT NOT NULL, json TEXT NOT NULL);
    `);
  }

  getCache<T>(key: string, maxAgeMs: number, now = Date.now()): T | null {
    const row = this.db.prepare("SELECT json, fetched_at FROM cache WHERE key = ?").get(key) as { json: string; fetched_at: number } | undefined;
    if (!row || now - row.fetched_at > maxAgeMs) return null;
    return JSON.parse(row.json) as T;
  }

  setCache(key: string, value: unknown, now = Date.now()): void {
    this.db.prepare("INSERT OR REPLACE INTO cache (key, json, fetched_at) VALUES (?, ?, ?)").run(key, JSON.stringify(value), now);
  }

  quotaUsed(day: string): number {
    const row = this.db.prepare("SELECT units FROM quota WHERE day = ?").get(day) as { units: number } | undefined;
    return row?.units ?? 0;
  }

  addQuota(day: string, units: number): number {
    this.db.prepare("INSERT INTO quota (day, units) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET units = units + excluded.units").run(day, units);
    return this.quotaUsed(day);
  }

  snapshot(channelId: string, s: { views: number; subs: number; videos: number }, at = Date.now()): void {
    this.db.prepare("INSERT OR REPLACE INTO snapshots (channel_id, at, views, subs, videos) VALUES (?, ?, ?, ?, ?)").run(channelId, at, s.views, s.subs, s.videos);
  }

  /** Oldest and newest snapshot of a channel (for measured growth between scans). */
  snapshots(channelId: string): { at: number; views: number; subs: number }[] {
    return this.db.prepare("SELECT at, views, subs FROM snapshots WHERE channel_id = ? ORDER BY at").all(channelId) as { at: number; views: number; subs: number }[];
  }

  saveScan(kind: string, seeds: string[], result: unknown, at = Date.now()): void {
    this.db.prepare("INSERT INTO scans (at, kind, seeds, json) VALUES (?, ?, ?, ?)").run(at, kind, JSON.stringify(seeds), JSON.stringify(result));
  }

  lastScan<T>(kind: string): { at: number; seeds: string[]; result: T } | null {
    const row = this.db.prepare("SELECT at, seeds, json FROM scans WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind) as { at: number; seeds: string; json: string } | undefined;
    return row ? { at: row.at, seeds: JSON.parse(row.seeds), result: JSON.parse(row.json) as T } : null;
  }

  close(): void {
    this.db.close();
  }
}
