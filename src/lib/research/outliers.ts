import type { YouTubeApi, YtChannel, YtVideo } from "./youtube-api.js";

/**
 * Outlier finder: a video is an outlier when it has far more views than its channel usually gets.
 * score = views / median views of the channel's last N (default 30) long-form uploads.
 * Flags: 2x, 3x, 5x+. Shorts (< 60 s) are left out of both sides (their views follow other rules).
 */

export type OutlierFlag = "5x+" | "3x" | "2x" | "";

export interface Outlier {
  video: YtVideo;
  channel: Pick<YtChannel, "id" | "title" | "subscribers" | "publishedAt">;
  channelMedian: number;
  score: number;
  flag: OutlierFlag;
  seed: string;
  /** How many of the channel's recent uploads the median is from. */
  sample: number;
}

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function outlierScore(views: number, channelViews: number[]): number {
  const med = median(channelViews);
  return med > 0 ? Math.round((views / med) * 100) / 100 : 0;
}

export function flagOf(score: number): OutlierFlag {
  return score >= 5 ? "5x+" : score >= 3 ? "3x" : score >= 2 ? "2x" : "";
}

const isLongForm = (v: YtVideo) => v.durationSec >= 60;

export interface OutlierOptions {
  seeds: string[];
  publishedWithinDays: number;
  resultsPerSeed: number;
  medianOf: number;
  top: number;
  /** Channels whose median is computed (2 units each); the rest are skipped. */
  maxChannels?: number;
  /** Fewer recent uploads than this: the median is not trusted, the video is left out. */
  minSample?: number;
  log?: (m: string) => void;
  now?: Date;
}

/** Quota a scan will use at most (before cache hits). */
export function outlierScanCost(o: Pick<OutlierOptions, "seeds" | "resultsPerSeed" | "maxChannels">): number {
  const videos = o.seeds.length * o.resultsPerSeed;
  const channels = Math.min(o.maxChannels ?? 150, videos);
  return o.seeds.length * 100 + Math.ceil(videos / 50) + Math.ceil(channels / 50) + channels * 2;
}

export async function findOutliers(api: YouTubeApi, o: OutlierOptions): Promise<{ outliers: Outlier[]; channels: YtChannel[]; uploads: Map<string, YtVideo[]>; candidates: { seed: string; video: YtVideo }[] }> {
  const log = o.log ?? (() => {});
  const now = o.now ?? new Date();
  const after = new Date(now.getTime() - o.publishedWithinDays * 86400_000);
  const minSample = o.minSample ?? 5;
  // 1. Seed searches (100 units each), most-viewed first inside the window.
  const seedOf = new Map<string, string>();
  for (const seed of o.seeds) {
    if (!api.canSpend(100)) {
      log(`[research] quota low: seed "${seed}" and later seeds skipped`);
      break;
    }
    const ids = await api.searchVideos(seed, { publishedAfter: after, maxResults: o.resultsPerSeed, order: "viewCount" });
    for (const id of ids) if (!seedOf.has(id)) seedOf.set(id, seed);
    log(`[research] seed "${seed}": ${ids.length} video(s)`);
  }
  const found = (await api.videos([...seedOf.keys()])).filter(isLongForm);
  const candidates = found.map((video) => ({ seed: seedOf.get(video.id) ?? "", video }));
  // 2. Channels of the candidates, the most-viewed candidates' channels first.
  const byViews = [...found].sort((a, b) => b.views - a.views);
  const channelIds = [...new Set(byViews.map((v) => v.channelId))].slice(0, o.maxChannels ?? 150);
  const channels = await api.channels(channelIds);
  // 3. Median of each channel's last N long-form uploads (2 units per channel).
  const uploads = new Map<string, YtVideo[]>();
  for (const ch of channels) {
    if (!api.canSpend(2)) {
      log(`[research] quota low: medians for ${channels.length - uploads.size} channel(s) skipped`);
      break;
    }
    const ids = await api.latestUploads(ch.uploadsPlaylist, Math.min(50, o.medianOf + 10));
    const vids = (await api.videos(ids)).filter(isLongForm).slice(0, o.medianOf);
    uploads.set(ch.id, vids);
  }
  const outliers: Outlier[] = [];
  for (const { seed, video } of candidates) {
    const ch = channels.find((c) => c.id === video.channelId);
    const recent = uploads.get(video.channelId);
    if (!ch || !recent || recent.length < minSample) continue;
    const med = median(recent.map((v) => v.views));
    const score = outlierScore(video.views, recent.map((v) => v.views));
    outliers.push({ video, channel: { id: ch.id, title: ch.title, subscribers: ch.subscribers, publishedAt: ch.publishedAt }, channelMedian: med, score, flag: flagOf(score), seed, sample: recent.length });
  }
  outliers.sort((a, b) => b.score - a.score || b.video.views - a.video.views);
  const top = outliers.slice(0, o.top);
  const flagged = top.filter((x) => x.flag).length;
  log(`[research] outliers: ${outliers.length} scored, top ${top.length} (${flagged} flagged 2x+; 5x+: ${top.filter((x) => x.flag === "5x+").length}), quota spent ${api.spent}, cache hits ${api.cacheHits}`);
  return { outliers: top, channels, uploads, candidates };
}
