import { loadFeatures } from "../settings/features.js";
import { ResearchDb } from "./db.js";
import { findOutliers, Outlier, outlierScanCost } from "./outliers.js";
import { GrowingChannel, scanNiches } from "./niche-scan.js";
import { QuotaError, YouTubeApi } from "./youtube-api.js";

/** One research scan (the /research page's button and `clipforge research`). */

export interface ResearchResult {
  at: number;
  seeds: string[];
  outliers: Outlier[];
  channels: GrowingChannel[];
  quota: { day: string; used: number; limit: number; left: number; spent: number; cacheHits: number };
  warnings: string[];
}

export async function runResearch(o: { seeds?: string[]; db?: ResearchDb; api?: YouTubeApi; log?: (m: string) => void; now?: Date } = {}): Promise<ResearchResult> {
  const cfg = loadFeatures().research;
  const log = o.log ?? ((m: string) => console.log(m));
  const db = o.db ?? new ResearchDb();
  const api = o.api ?? new YouTubeApi({ db, dailyQuota: cfg.dailyQuota, quotaReserve: cfg.quotaReserve, cacheHours: cfg.cacheHours, log });
  const seeds = (o.seeds?.length ? o.seeds : cfg.seeds).map((s) => s.trim()).filter(Boolean).slice(0, 12);
  const warnings: string[] = [];
  const maxChannels = 150;
  const need = outlierScanCost({ seeds, resultsPerSeed: cfg.resultsPerSeed, maxChannels }) + seeds.length * 101;
  const q0 = api.quota();
  log(`[research] scan for ${seeds.length} seed(s): up to ~${need} units (cache hits are free), ${q0.left} left today`);
  if (need > q0.left) warnings.push(`This scan may need up to ~${need} units and ${q0.left} are left today; later seeds are skipped when the quota runs low.`);
  let outliers: Outlier[] = [];
  let channels: GrowingChannel[] = [];
  try {
    const r = await findOutliers(api, { seeds, publishedWithinDays: cfg.publishedWithinDays, resultsPerSeed: cfg.resultsPerSeed, medianOf: cfg.medianOf, top: cfg.topOutliers, maxChannels, log, now: o.now });
    outliers = r.outliers;
    const seedOfChannel = new Map(r.candidates.map((c) => [c.video.channelId, c.seed]));
    channels = await scanNiches(api, db, { seeds, newChannelMonths: cfg.newChannelMonths, top: cfg.topChannels, log, now: o.now }, { channels: r.channels, uploads: r.uploads, seedOfChannel });
  } catch (err) {
    if (!(err instanceof QuotaError)) throw err;
    warnings.push(err.message);
    log(`[research] ${err.message}`);
  }
  const q = api.quota();
  const result: ResearchResult = { at: (o.now ?? new Date()).getTime(), seeds, outliers, channels, quota: { ...q, spent: api.spent, cacheHits: api.cacheHits }, warnings };
  db.saveScan("research", seeds, result);
  log(`[research] done: ${outliers.length} outlier(s), ${channels.length} growing channel(s), ${api.spent} unit(s) spent (${q.used}/${q.limit} today)`);
  return result;
}

export function lastResearch(db = new ResearchDb()): ResearchResult | null {
  return db.lastScan<ResearchResult>("research")?.result ?? null;
}
