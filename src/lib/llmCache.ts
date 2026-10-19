import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { canonicalJson } from "./compiler/incrementalCache.js";

/**
 * Small JSON cache for LLM answers, keyed by a hash of exactly what the answer depends on (the
 * model, the prompt version and the text of one scene or section). A script edit then re-asks the
 * LLM only for the parts whose text changed; every other scene keeps its earlier labels, so its
 * searches, footage and render-cache entry stay the same (LLM answers are not deterministic, so
 * asking again would reshuffle them).
 * Old entries are kept (an undone edit hits the cache again) up to `max`, oldest dropped first.
 */
export class LlmCache<T> {
  private data: Record<string, { v: T; at: number }> = {};
  private dirty = false;
  hits = 0;
  misses = 0;

  constructor(readonly file: string, private max = 4000) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object" && raw.version === 1 && raw.entries) this.data = raw.entries;
    } catch {
      /* no cache yet, or an older format: start empty */
    }
  }

  static key(parts: unknown): string {
    return crypto.createHash("sha256").update(canonicalJson(parts)).digest("hex").slice(0, 40);
  }

  get(key: string): T | undefined {
    const e = this.data[key];
    if (e) {
      this.hits++;
      e.at = Date.now();
      this.dirty = true;
      return e.v;
    }
    this.misses++;
    return undefined;
  }

  set(key: string, v: T): void {
    this.data[key] = { v, at: Date.now() };
    this.dirty = true;
  }

  save(): void {
    if (!this.dirty) return;
    const keys = Object.keys(this.data);
    if (keys.length > this.max) {
      for (const k of keys.sort((a, b) => this.data[a].at - this.data[b].at).slice(0, keys.length - this.max)) delete this.data[k];
    }
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ version: 1, entries: this.data }));
    this.dirty = false;
  }
}
