import fs from "node:fs";
import path from "node:path";
import { paths } from "../../paths.js";
import type { TranscriptMeta } from "./transcript.js";

export interface CompetitorTranscripts {
  competitor: string;
  transcripts: { id: string; text: string; meta?: TranscriptMeta }[];
}

const readFolder = (dir: string, max: number) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".txt"))
    .sort()
    .slice(0, max)
    .map((f) => {
      const id = f.replace(/\.txt$/, "");
      const mf = path.join(dir, `${id}.json`);
      return { id, text: fs.readFileSync(path.join(dir, f), "utf8"), meta: fs.existsSync(mf) ? (JSON.parse(fs.readFileSync(mf, "utf8")) as TranscriptMeta) : undefined };
    });

/**
 * Where the transcripts come from:
 *  - a folder of .txt files (optional <id>.json next to each: {durationSec, title, views});
 *  - a project name: workspace/<project>/competitors/*.txt (fetched by the script step);
 *  - a YouTube channel id (UC...): the channel's latest uploads, the most viewed first, with
 *    their transcripts (needs YOUTUBE_API_KEY; cached in channels/<ch>/sop/<id>/).
 */
export async function competitorTranscripts(spec: string, channel: string, max = 8, log: (m: string) => void = console.log): Promise<CompetitorTranscripts> {
  const asDir = path.resolve(spec);
  if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) return { competitor: path.basename(asDir), transcripts: readFolder(asDir, max) };
  const proj = path.join(paths.workspace, spec, "competitors");
  if (/^[a-z0-9][a-z0-9-]{0,60}$/i.test(spec) && fs.existsSync(proj)) return { competitor: spec, transcripts: readFolder(proj, max) };
  if (!/^UC[\w-]{22}$/.test(spec)) throw new Error(`"${spec}" is not a folder, a project with competitors/*.txt, or a YouTube channel id (UC + 22 characters).`);
  const cache = path.join(paths.channels, channel, "sop", spec);
  if (fs.existsSync(cache) && fs.readdirSync(cache).filter((f) => f.endsWith(".txt")).length >= Math.min(max, 5)) {
    log(`[sop] using ${spec}'s cached transcripts (${cache})`);
    return { competitor: spec, transcripts: readFolder(cache, max) };
  }
  const { YouTubeApi } = await import("../../research/youtube-api.js");
  const { ResearchDb } = await import("../../research/db.js");
  const { loadFeatures } = await import("../../settings/features.js");
  const f = loadFeatures().research;
  const api = new YouTubeApi({ db: new ResearchDb(), dailyQuota: f.dailyQuota, quotaReserve: f.quotaReserve, log });
  if (!api.configured) throw new Error(`Fetching ${spec}'s videos needs YOUTUBE_API_KEY in .env. Without it, put the transcripts in a folder and pass the folder.`);
  const [ch] = await api.channels([spec]);
  if (!ch) throw new Error(`YouTube has no channel ${spec}`);
  // The most viewed of the latest uploads (long videos only: Shorts have no script structure to learn).
  const vids = (await api.videos(await api.latestUploads(ch.uploadsPlaylist, 50))).filter((v) => v.durationSec >= 180).sort((a, b) => b.views - a.views);
  const { quickTranscript } = await import("../youtube/ytExtractor.js");
  fs.mkdirSync(cache, { recursive: true });
  let got = 0;
  for (const v of vids) {
    if (got >= max) break;
    const t = await quickTranscript(`https://www.youtube.com/watch?v=${v.id}`).catch(() => null);
    if (!t?.words.length) {
      log(`[sop] no transcript for ${v.id} (${v.title.slice(0, 50)})`);
      continue;
    }
    fs.writeFileSync(path.join(cache, `${v.id}.txt`), t.words.map((w) => w.text).join(" "));
    fs.writeFileSync(path.join(cache, `${v.id}.json`), JSON.stringify({ durationSec: v.durationSec, title: v.title, views: v.views }, null, 2));
    got++;
  }
  log(`[sop] ${ch.title}: ${got} transcript(s) from the ${vids.length} longest-viewed recent uploads`);
  return { competitor: spec, transcripts: readFolder(cache, max) };
}
