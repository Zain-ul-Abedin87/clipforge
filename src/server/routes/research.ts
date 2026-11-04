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
      const req = JSON.parse((await body()) || "{}") as { topic?: unknown; channel?: unknown };
      const topic = typeof req.topic === "string" ? req.topic.trim().slice(0, 120) : "";
      if (!topic) return { status: 400, body: { error: "topic is required" } };
      return { status: 200, body: await runTitles(topic, { db, api, channel: typeof req.channel === "string" ? req.channel : undefined, log: (m) => (logs.push(m), console.log(m)) }) };
    }
    // Script formats for /new: the list, and the one the title points to.
    if (method === "POST" && parts[2] === "formats") {
      const { FORMATS, FORMAT_IDS, suggestFormat } = await import("../../lib/agents/script/formats.js");
      const req = JSON.parse((await body()) || "{}") as { title?: unknown };
      return { status: 200, body: { formats: FORMAT_IDS.map((id) => ({ id, label: FORMATS[id].label, items: FORMATS[id].items, itemHint: FORMATS[id].itemHint, min: FORMATS[id].minItems, max: FORMATS[id].maxItems })), suggested: suggestFormat(typeof req.title === "string" ? req.title : "") } };
    }
    // Idea multiplier: POST {videoId, channel, title?} -> 15 ideas; GET /ideas/<channel>/<videoId> -> the saved run.
    if (parts[2] === "ideas") {
      const { multiplyIdeas } = await import("../../lib/agents/ideas.js");
      const { ideaSource } = await import("../../lib/agents/ideasSource.js");
      const { loadBrief } = await import("../../lib/channelBrief.js");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const { paths } = await import("../../lib/paths.js");
      if (method === "GET") {
        const ch = String(parts[3] ?? "");
        const vid = String(parts[4] ?? "").replace(/[^\w-]/g, "_");
        const f = path.join(paths.channels, ch, "ideas", `${vid}.json`);
        return /^[a-z0-9][a-z0-9_-]{0,60}$/.test(ch) && fs.existsSync(f) ? { status: 200, body: JSON.parse(fs.readFileSync(f, "utf8")) } : { status: 200, body: null };
      }
      if (method === "POST") {
        const req = JSON.parse((await body()) || "{}") as { videoId?: unknown; channel?: unknown; title?: unknown };
        const videoId = typeof req.videoId === "string" && /^[\w-]{6,20}$/.test(req.videoId) ? req.videoId : "";
        const channel = typeof req.channel === "string" && /^[a-z0-9][a-z0-9_-]{0,60}$/.test(req.channel) ? req.channel : "";
        if (!videoId || !channel) return { status: 400, body: { error: "videoId and channel are required" } };
        const log = (m: string) => (logs.push(m), console.log(m));
        const { source, competitorTitles } = await ideaSource(videoId, { title: typeof req.title === "string" ? req.title : undefined, log });
        return { status: 200, body: await multiplyIdeas(source, { channel, brief: loadBrief(channel), competitorTitles, log }) };
      }
    }
    if (method === "GET" && parts[2] === "titles") return { status: 200, body: db.lastScan("titles")?.result ?? null };
    return { status: 404, body: { error: "unknown research route" } };
  } finally {
    db.close();
  }
}
