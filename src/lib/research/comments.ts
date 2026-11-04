import { closest } from "../originality/similarity.js";
import type { YouTubeApi } from "./youtube-api.js";

/**
 * Comment mining: the top comments of outlier videos -> what viewers ask and complain about ->
 * candidate angles for the idea multiplier ("nobody covered X", "too heavy for Y"). Rules only (no
 * model): questions and complaint phrasing, the most liked first, near-duplicates merged. Needs
 * YOUTUBE_API_KEY; without it this step is skipped and says so.
 */

const COMPLAINT = /\b(wish|should have|should've|too (expensive|heavy|big|small|loud|long|short|pricey)|problem|broke|broken|disappoint\w*|don'?t like|hate|why didn'?t|nobody (talks|mentions|covers)|what about|you forgot|you missed|missing|overpriced|not worth|failed|stopped working|returned it)\b/i;
const NOISE = /\b(first|subscribe|sub to|check out my|giveaway|whatsapp|telegram|crypto|onlyfans)\b|https?:\/\//i;

export function anglesFromComments(comments: { text: string; likes: number }[], max = 12): { angle: string; kind: "question" | "complaint"; likes: number }[] {
  const out: { angle: string; kind: "question" | "complaint"; likes: number }[] = [];
  for (const c of [...comments].sort((a, b) => b.likes - a.likes)) {
    const text = c.text.replace(/\s+/g, " ").trim();
    if (text.length < 15 || text.length > 600 || NOISE.test(text)) continue;
    // The sentence that carries the question / complaint.
    const sents = text.split(/(?<=[.!?])\s+/);
    const q = sents.find((s) => /\?\s*$/.test(s) && s.split(" ").length >= 4);
    const k = sents.find((s) => COMPLAINT.test(s));
    const pick = q ?? k;
    if (!pick) continue;
    const angle = pick.slice(0, 160);
    if (out.some((o) => closest(angle, [o.angle], { n: 2 }).score > 0.6)) continue;
    out.push({ angle, kind: q ? "question" : "complaint", likes: c.likes });
    if (out.length >= max) break;
  }
  return out;
}

export async function commentAngles(api: YouTubeApi, videoIds: string[], log: (m: string) => void = () => {}, max = 12): Promise<{ angle: string; kind: "question" | "complaint"; likes: number }[]> {
  if (!api.configured) {
    log("[comments] YOUTUBE_API_KEY is not set: comment mining skipped");
    return [];
  }
  const all: { text: string; likes: number }[] = [];
  for (const id of videoIds.slice(0, 5)) {
    if (!api.canSpend(1)) {
      log("[comments] no YouTube quota left today: comment mining stopped");
      break;
    }
    all.push(...(await api.topComments(id, 100)));
  }
  const a = anglesFromComments(all, max);
  log(`[comments] ${all.length} comment(s) read from ${Math.min(5, videoIds.length)} video(s): ${a.length} question / complaint angle(s)`);
  return a;
}
