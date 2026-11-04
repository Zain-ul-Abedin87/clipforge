import { loadFeatures, saveFeatures } from "../../lib/settings/features.js";
import { ResearchDb } from "../../lib/research/db.js";
import { lastResearch, runResearch, runTitles } from "../../lib/research/index.js";
import { YouTubeApi } from "../../lib/research/youtube-api.js";

/**
 * Research + feature settings API (plain JSON):
 *   GET  /api/research          last scan + quota + whether YOUTUBE_API_KEY is set
 *   POST /api/research/scan     { seeds?: string[] } runs a scan (one at a time)
 *   GET  /api/features          all feature settings (features.json merged with defaults)
 *   PUT  /api/features          partial update { section: { key: value } }
 * Returns null for routes it does not own.
 */

let running: Promise<unknown> | null = null;
const logs: string[] = [];

export async function researchRoute(parts: string[], method: string, body: () => Promise<string>): Promise<{ status: number; body: unknown } | null> {
  if (parts[1] === "features") {
    if (method === "GET") return { status: 200, body: loadFeatures() };
    if (method === "PUT") return { status: 200, body: saveFeatures(JSON.parse((await body()) || "{}")) };
    return { status: 405, body: { error: "GET or PUT" } };
  }
  if (parts[1] !== "research") return null;
  const db = new ResearchDb();
  try {
    const cfg = loadFeatures().research;
    const api = new YouTubeApi({ db, dailyQuota: cfg.dailyQuota, quotaReserve: cfg.quotaReserve });
    if (method === "GET" && !parts[2]) return { status: 200, body: { configured: api.configured, quota: api.quota(), running: !!running, log: logs.slice(-40), last: lastResearch(db), seeds: cfg.seeds } };
    if (method === "POST" && parts[2] === "scan") {
      if (!api.configured) return { status: 400, body: { error: "YOUTUBE_API_KEY is not set in .env (Google Cloud console -> YouTube Data API v3 -> API key, free)" } };
      if (running) return { status: 409, body: { error: "a scan is already running" } };
      const req = JSON.parse((await body()) || "{}") as { seeds?: unknown };
      const seeds = Array.isArray(req.seeds) ? req.seeds.filter((s): s is string => typeof s === "string" && s.trim().length > 0 && s.length < 80) : undefined;
      logs.length = 0;
      const job = runResearch({ seeds, db, log: (m) => (logs.push(m), console.log(m)) });
      running = job;
      try {
        return { status: 200, body: await job };
      } finally {
        running = null;
      }
    }
    if (method === "POST" && parts[2] === "titles") {
      const req = JSON.parse((await body()) || "{}") as { topic?: unknown };
      const topic = typeof req.topic === "string" ? req.topic.trim().slice(0, 120) : "";
      if (!topic) return { status: 400, body: { error: "topic is required" } };
      return { status: 200, body: await runTitles(topic, { db, api, log: (m) => (logs.push(m), console.log(m)) }) };
    }
    if (method === "GET" && parts[2] === "titles") return { status: 200, body: db.lastScan("titles")?.result ?? null };
    return { status: 404, body: { error: "unknown research route" } };
  } finally {
    db.close();
  }
}
