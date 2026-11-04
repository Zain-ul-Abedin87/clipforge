import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-research-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { ResearchDb } = await import("../src/lib/research/db.js");
const { YouTubeApi, QuotaError, quotaDay, isoDurationSec, UNIT_COST } = await import("../src/lib/research/youtube-api.js");
const { median, outlierScore, flagOf, findOutliers, outlierScanCost } = await import("../src/lib/research/outliers.js");
const { facelessScore, rpmRange, views28, scanNiches } = await import("../src/lib/research/niche-scan.js");
const { runResearch } = await import("../src/lib/research/index.js");
const F = await import("../src/lib/settings/features.js");

const NOW = new Date("2026-11-04T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86400_000).toISOString();

/**
 * Fake YouTube Data API: 2 channels. "A" (old, face-cam) has one 6x video; "B" (new, faceless
 * "Survival Facts HQ") has one 3x video. Each channel's uploads are 30 long videos + 1 Short.
 */
function fakeYouTube() {
  const calls: string[] = [];
  const vids: Record<string, { ch: string; views: number; dur: string; at: string; title: string }> = {};
  for (const [ch, base] of [["A", 10_000], ["B", 2_000]] as const) {
    for (let i = 0; i < 30; i++) vids[`${ch}${i}`] = { ch, views: base + i * 10, dur: "PT10M", at: daysAgo(5 + i * 7), title: `${ch} video ${i}` };
    vids[`${ch}short`] = { ch, views: 9_999_999, dur: "PT30S", at: daysAgo(2), title: "short" };
  }
  vids.A0.views = 60_000; // 6x
  vids.B0.views = 7_000; // ~3.2x
  const channels: Record<string, Record<string, unknown>> = {
    A: { title: "John Smith", description: "Hi guys, I'm John and this is my range vlog", publishedAt: daysAgo(2000), subs: 500_000, views: 90_000_000, videos: 400 },
    B: { title: "Survival Facts HQ", description: "Faceless survival gear countdowns with AI voice narration", publishedAt: daysAgo(200), subs: 40_000, views: 3_000_000, videos: 31 },
  };
  const f = (async (url: string) => {
    const u = new URL(url);
    const ep = u.pathname.split("/").pop()!;
    calls.push(ep);
    const ids = (u.searchParams.get("id") ?? "").split(",").filter(Boolean);
    const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (ep === "search" && u.searchParams.get("type") === "video") return json({ items: ["A0", "B0", "Ashort", "A5"].map((videoId) => ({ id: { videoId } })) });
    if (ep === "search") return json({ items: [{ id: { channelId: "B" } }] });
    if (ep === "videos")
      return json({ items: ids.filter((id) => vids[id]).map((id) => ({ id, snippet: { title: vids[id].title, channelId: vids[id].ch, channelTitle: String(channels[vids[id].ch].title), publishedAt: vids[id].at, thumbnails: { medium: { url: `https://i/${id}.jpg` } } }, statistics: { viewCount: String(vids[id].views) }, contentDetails: { duration: vids[id].dur } })) });
    if (ep === "channels")
      return json({ items: ids.map((id) => ({ id, snippet: { title: channels[id].title, description: channels[id].description, publishedAt: channels[id].publishedAt }, statistics: { subscriberCount: String(channels[id].subs), viewCount: String(channels[id].views), videoCount: String(channels[id].videos) }, contentDetails: { relatedPlaylists: { uploads: `UU${id}` } } })) });
    if (ep === "playlistItems") {
      const ch = u.searchParams.get("playlistId")!.slice(2);
      return json({ items: [`${ch}short`, ...Array.from({ length: 30 }, (_, i) => `${ch}${i}`)].map((videoId) => ({ contentDetails: { videoId } })) });
    }
    return new Response(JSON.stringify({ error: { message: "nope" } }), { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

const api = (db: InstanceType<typeof ResearchDb>, f: typeof fetch, o: { dailyQuota?: number; quotaReserve?: number } = {}) =>
  new YouTubeApi({ key: "test-key", db, fetch: f, now: () => NOW, dailyQuota: o.dailyQuota ?? 10000, quotaReserve: o.quotaReserve ?? 0 });

describe("outlier math", () => {
  test("score = views / median of the channel's recent views; flags 2x / 3x / 5x+", () => {
    assert.equal(median([1, 3, 2]), 2);
    assert.equal(median([1, 2, 3, 4]), 2.5);
    assert.equal(outlierScore(500, [100, 100, 90, 110]), 5);
    assert.deepEqual([flagOf(5), flagOf(3.2), flagOf(2), flagOf(1.9)], ["5x+", "3x", "2x", ""]);
    assert.equal(isoDurationSec("PT1H2M3S"), 3723);
    assert.equal(isoDurationSec("P1DT1S"), 86401);
  });

  test("quota day is the Pacific-time date (Google's reset)", () => {
    assert.equal(quotaDay(new Date("2026-11-05T06:00:00Z")), "2026-11-04");
    assert.equal(quotaDay(new Date("2026-11-05T09:00:00Z")), "2026-11-05");
  });
});

describe("YouTube API client: quota counter + cache", () => {
  test("units are counted per call, cached answers are free, the limit is enforced before sending", async () => {
    const db = new ResearchDb(":memory:");
    const yt = fakeYouTube();
    const a = api(db, yt.f, { dailyQuota: 250, quotaReserve: 50 });
    await a.searchVideos("gun review");
    assert.equal(a.quota().used, UNIT_COST.search);
    await a.searchVideos("gun review"); // cached
    assert.equal(a.cacheHits, 1);
    await a.searchVideos("survival");
    assert.equal(a.quota().used, 200);
    await assert.rejects(a.searchVideos("prepper"), (e) => e instanceof QuotaError);
    assert.equal(yt.calls.filter((c) => c === "search").length, 2, "the refused call was never sent");
  });

  test("no key: a clear error, nothing sent", async () => {
    const db = new ResearchDb(":memory:");
    const yt = fakeYouTube();
    const a = new YouTubeApi({ key: "", db, fetch: yt.f });
    assert.equal(a.configured, false);
    await assert.rejects(a.videos(["x"]), /YOUTUBE_API_KEY/);
    assert.equal(yt.calls.length, 0);
  });
});

describe("findOutliers + scanNiches (fake API)", () => {
  test("outliers ranked by score with flags; Shorts left out; cost estimate covers the scan", async () => {
    const db = new ResearchDb(":memory:");
    const yt = fakeYouTube();
    const a = api(db, yt.f);
    const r = await findOutliers(a, { seeds: ["gun review"], publishedWithinDays: 365, resultsPerSeed: 50, medianOf: 30, top: 50, now: NOW });
    assert.deepEqual(r.outliers.map((o) => o.video.id).slice(0, 2), ["A0", "B0"]);
    assert.equal(r.outliers[0].flag, "5x+");
    assert.equal(r.outliers[1].flag, "3x");
    assert.ok(!r.outliers.some((o) => o.video.id === "Ashort"));
    assert.ok(a.spent <= outlierScanCost({ seeds: ["gun review"], resultsPerSeed: 50, maxChannels: 150 }));
  });

  test("growing new faceless channels: old / face-cam channels are left out; RPM is a range", async () => {
    const db = new ResearchDb(":memory:");
    const yt = fakeYouTube();
    const a = api(db, yt.f);
    const r = await findOutliers(a, { seeds: ["survival gear"], publishedWithinDays: 365, resultsPerSeed: 50, medianOf: 30, top: 50, now: NOW });
    const g = await scanNiches(a, db, { seeds: ["survival gear"], newChannelMonths: 12, top: 20, now: NOW }, { channels: r.channels, uploads: r.uploads });
    assert.deepEqual(g.map((x) => x.channel.id), ["B"]);
    assert.equal(g[0].views28Source, "estimated");
    assert.ok(g[0].views28 > 0);
    assert.deepEqual(g[0].rpm, rpmRange("survival gear"));
    assert.ok(g[0].revenue28[0] <= g[0].revenue28[1]);
  });

  test("28-day views are measured from two snapshots 3+ days apart", () => {
    const c = { id: "B", publishedAt: daysAgo(100), views: 1_000_000 } as never;
    const v = views28(c, [], [{ at: NOW.getTime() - 7 * 86400_000, views: 900_000 }, { at: NOW.getTime(), views: 1_000_000 }], NOW);
    assert.deepEqual(v, { value: 400_000, source: "measured" });
  });

  test("faceless heuristic", () => {
    assert.ok(facelessScore({ title: "Survival Facts HQ", description: "AI voice narration" }) >= 0.5);
    assert.ok(facelessScore({ title: "John Smith", description: "Hi guys, I'm John" }) < 0.5);
  });

  test("runResearch saves the scan and reports quota (one click)", async () => {
    const db = new ResearchDb(":memory:");
    const yt = fakeYouTube();
    const a = api(db, yt.f);
    const r = await runResearch({ seeds: ["gun review", "survival gear"], db, api: a, log: () => {}, now: NOW });
    assert.ok(r.outliers.length >= 2);
    assert.equal(r.channels.length, 1);
    assert.ok(r.quota.spent > 0 && r.quota.spent < 10000);
    assert.deepEqual(db.lastScan<{ seeds: string[] }>("research")?.seeds, ["gun review", "survival gear"]);
  });
});

describe("feature settings (features.json)", () => {
  test("defaults, validated partial updates, unknown keys and wrong types ignored", () => {
    assert.equal(F.loadFeatures().research.dailyQuota, 10000);
    const s = F.saveFeatures({ research: { seeds: ["ar-15", " "], dailyQuota: 5000, bogus: 1, topOutliers: "x" } } as never);
    assert.deepEqual(s.research.seeds, ["ar-15"]);
    assert.equal(s.research.dailyQuota, 5000);
    assert.equal(s.research.topOutliers, 50);
    assert.equal(s.titles.count, 10);
  });
});
