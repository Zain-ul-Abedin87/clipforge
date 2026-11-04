import type { IdeaSource } from "./ideas.js";

/**
 * The outlier video an idea run starts from: the last research scan (title, views, multiple,
 * channel), else the YouTube API (needs YOUTUBE_API_KEY), else the title given by hand. The
 * transcript is fetched when possible; without it the model judges from the title.
 */
export async function ideaSource(videoId: string, o: { title?: string; transcript?: boolean; log?: (m: string) => void } = {}): Promise<{ source: IdeaSource; competitorTitles: string[] }> {
  const log = o.log ?? (() => {});
  const { lastResearch } = await import("../research/index.js");
  const last = lastResearch();
  const competitorTitles = (last?.outliers ?? []).map((x) => x.video.title);
  const hit = last?.outliers.find((x) => x.video.id === videoId);
  let source: IdeaSource | null = hit ? { videoId, title: hit.video.title, views: hit.video.views, multiple: hit.score, channelTitle: hit.channel.title } : null;
  if (!source) {
    const { YouTubeApi } = await import("../research/youtube-api.js");
    const { ResearchDb } = await import("../research/db.js");
    const api = new YouTubeApi({ db: new ResearchDb(), log });
    if (api.configured) {
      const [v] = await api.videos([videoId]).catch(() => []);
      if (v) source = { videoId, title: v.title, views: v.views };
    }
  }
  if (!source && o.title) source = { videoId, title: o.title };
  if (!source) throw new Error(`Video ${videoId} is not in the last research scan and YOUTUBE_API_KEY is not set: pass its title with --title.`);
  if (o.title) source.title = o.title;
  if (o.transcript !== false) {
    const { quickTranscript } = await import("./youtube/ytExtractor.js");
    const t = await quickTranscript(`https://www.youtube.com/watch?v=${videoId}`).catch(() => null);
    if (t?.words.length) source.transcript = t.words.map((w) => w.text).join(" ");
    else log(`[ideas] no transcript for ${videoId}: the ideas come from the title alone`);
  }
  return { source, competitorTitles };
}
