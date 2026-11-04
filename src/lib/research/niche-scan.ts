import type { ResearchDb } from "./db.js";
import type { YouTubeApi, YtChannel, YtVideo } from "./youtube-api.js";

/**
 * Niche scan: new (created < 12 months ago), likely faceless channels that grow fast in the seed
 * niches. Views over the last 28 days are MEASURED when two snapshots of the channel are at least
 * 3 days apart (data/research.db), otherwise ESTIMATED from the channel's age and recent uploads.
 * RPM is never known from outside the channel: it is shown as an estimate range per niche.
 */

export interface GrowingChannel {
  channel: YtChannel;
  ageDays: number;
  views28: number;
  views28Source: "measured" | "estimated";
  facelessScore: number;
  faceless: boolean;
  rpm: [number, number];
  /** Estimated monthly AdSense revenue range (USD) = views28 / 1000 x rpm. */
  revenue28: [number, number];
  longFormShare: number;
  seed: string;
}

/** Rough RPM ranges (USD per 1000 views, US-heavy audience). Estimates only. */
const RPM_TABLE: [RegExp, [number, number]][] = [
  [/financ|invest|money|credit|insurance|crypto/i, [8, 20]],
  [/tech|gadget|laptop|phone|software|ai\b/i, [4, 10]],
  [/survival|prepper|bushcraft|camping|outdoor|hunting|knife/i, [3, 7]],
  [/gun|firearm|pistol|handgun|rifle|ammo|carry|shotgun/i, [2, 5]],
  [/car|truck|tool|mower|garage/i, [3, 8]],
];
export function rpmRange(niche: string): [number, number] {
  return RPM_TABLE.find(([re]) => re.test(niche))?.[1] ?? [1.5, 5];
}

const FACELESS_POS = /\b(facts?|top ?\d*|best|explained|daily|guide|reviews?|hq|tv|media|zone|hub|world|insider|central|lab|ai|official|channel|countdown|ranked|tier|data|story|stories|history|documentar)/i;
const FACE_NEG = /\b(i'?m|my name is|i am|join me|vlogs?|my family|me and my|with me|hi guys|hey guys|subscribe to me|my wife|my husband)\b/i;
const NARRATION_POS = /\b(faceless|ai voice|narrat|compilation|animated|animation|voiceover|stock footage)\b/i;
/** "John Smith" style titles (two capitalised words, no topic word) are often a person on camera. */
const PERSON_NAME = /^[A-Z][a-z]+ [A-Z][a-z]+$/;

/** 0-1: how likely the channel never shows a face (title / description heuristics). */
export function facelessScore(c: Pick<YtChannel, "title" | "description">): number {
  let s = 0.5;
  if (FACELESS_POS.test(c.title)) s += 0.2;
  if (NARRATION_POS.test(c.description)) s += 0.25;
  if (FACE_NEG.test(c.description)) s -= 0.35;
  if (PERSON_NAME.test(c.title.trim())) s -= 0.25;
  return Math.max(0, Math.min(1, Math.round(s * 100) / 100));
}

export function ageDays(publishedAt: string, now = new Date()): number {
  const t = Date.parse(publishedAt);
  return Number.isFinite(t) ? Math.max(1, Math.round((now.getTime() - t) / 86400_000)) : 99999;
}

/** Views in the last 28 days: measured from snapshots, else estimated. */
export function views28(c: YtChannel, recent: YtVideo[], snaps: { at: number; views: number }[], now = new Date()): { value: number; source: "measured" | "estimated" } {
  if (snaps.length >= 2) {
    const a = snaps[0];
    const b = snaps[snaps.length - 1];
    const days = (b.at - a.at) / 86400_000;
    if (days >= 3 && b.views >= a.views) return { value: Math.round(((b.views - a.views) / days) * 28), source: "measured" };
  }
  const age = ageDays(c.publishedAt, now);
  const cutoff = now.getTime() - 28 * 86400_000;
  const recentSum = recent.filter((v) => Date.parse(v.publishedAt) >= cutoff).reduce((s, v) => s + v.views, 0);
  // Young channels get most views in their first weeks: the lifetime average per day x 28 is a floor.
  const avg = (c.views / Math.max(age, 1)) * 28;
  return { value: Math.round(Math.max(recentSum, Math.min(avg, c.views))), source: "estimated" };
}

export interface NicheScanOptions {
  seeds: string[];
  newChannelMonths: number;
  top: number;
  /** Also search channels created in the window per seed (100 units each). */
  channelSearch?: boolean;
  log?: (m: string) => void;
  now?: Date;
}

/**
 * Growing new faceless channels. Reuses the channels / uploads the outlier scan already fetched
 * (no extra quota); `channelSearch` adds a channel search per seed for channels the video search
 * did not reach.
 */
export async function scanNiches(
  api: YouTubeApi,
  db: ResearchDb,
  o: NicheScanOptions,
  known: { channels: YtChannel[]; uploads: Map<string, YtVideo[]>; seedOfChannel?: Map<string, string> } = { channels: [], uploads: new Map() },
): Promise<GrowingChannel[]> {
  const log = o.log ?? (() => {});
  const now = o.now ?? new Date();
  const after = new Date(now.getTime() - o.newChannelMonths * 30.44 * 86400_000);
  const channels = new Map(known.channels.map((c) => [c.id, c]));
  const seedOf = new Map(known.seedOfChannel ?? []);
  if (o.channelSearch !== false) {
    for (const seed of o.seeds) {
      if (!api.canSpend(150)) {
        log(`[research] quota low: channel search for "${seed}" and later seeds skipped`);
        break;
      }
      const ids = (await api.searchChannels(seed, { publishedAfter: after, maxResults: 50 })).filter((id) => !channels.has(id));
      for (const c of await api.channels(ids)) {
        channels.set(c.id, c);
        if (!seedOf.has(c.id)) seedOf.set(c.id, seed);
      }
    }
  }
  const young = [...channels.values()].filter((c) => Date.parse(c.publishedAt) >= after.getTime() && c.videos > 0);
  const out: GrowingChannel[] = [];
  for (const c of young) {
    let recent = known.uploads.get(c.id);
    if (!recent && api.canSpend(2)) recent = await api.videos(await api.latestUploads(c.uploadsPlaylist, 30));
    recent ??= [];
    db.snapshot(c.id, { views: c.views, subs: c.subscribers, videos: c.videos }, now.getTime());
    const v = views28(c, recent, db.snapshots(c.id), now);
    const fs = facelessScore(c);
    const seed = seedOf.get(c.id) ?? o.seeds.find((s) => recent!.some((x) => x.title.toLowerCase().includes(s.split(" ")[0].toLowerCase()))) ?? o.seeds[0] ?? "";
    // The seed decides the niche; the channel text only when the seed matches no known niche.
    const rpm = RPM_TABLE.some(([re]) => re.test(seed)) ? rpmRange(seed) : rpmRange(`${c.title} ${c.description.slice(0, 200)}`);
    const longShare = recent.length ? recent.filter((x) => x.durationSec >= 60).length / recent.length : 0;
    out.push({
      channel: c,
      ageDays: ageDays(c.publishedAt, now),
      views28: v.value,
      views28Source: v.source,
      facelessScore: fs,
      faceless: fs >= 0.5,
      rpm,
      revenue28: [Math.round((v.value / 1000) * rpm[0]), Math.round((v.value / 1000) * rpm[1])],
      longFormShare: Math.round(longShare * 100) / 100,
      seed,
    });
  }
  // Growing = most views per 28 days for the channel's age; faceless ones first.
  const ranked = out.filter((g) => g.faceless).sort((a, b) => b.views28 - a.views28);
  const top = ranked.slice(0, o.top);
  log(`[research] niche scan: ${channels.size} channel(s) seen, ${young.length} created in the last ${o.newChannelMonths} months, ${ranked.length} likely faceless, top ${top.length}`);
  return top;
}
