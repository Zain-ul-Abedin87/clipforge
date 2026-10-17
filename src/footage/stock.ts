import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { env, hasKey } from "../lib/env.js";
import { netFetch } from "../lib/net.js";
import { paths } from "../lib/paths.js";
import { agentModel } from "../lib/agent/footage.js";
import { llm, llmAvailable } from "../lib/agents/llm/llm.js";

/**
 * Stock B-roll helpers from the repo study:
 * - findStockVideo: Pexels (then Pixabay) search with the short-video-maker filters (MIT,
 *   gyoridavid/short-video-maker src/short-creator/libraries/Pexels.ts): per_page 80, size medium,
 *   landscape, low-fps duration fix (fps < 25 -> duration * fps / 25), clip must be >= need + 3 s,
 *   HD file, excludeIds so one video is never used twice, random pick among the matches with 3
 *   retries, then fallback terms. Keys come from .env (PEXELS_API_KEY / PIXABAY_API_KEY); without
 *   keys every function returns nothing instead of failing.
 * - titleTheme + searchTermsForLines: MoneyPrinterTurbo-style search-term prompt (MIT,
 *   harry0703/MoneyPrinterTurbo app/services/llm.py generate_terms) with the video title's theme as
 *   the main subject, so generic lines of "Best guns for a truck under $350" search
 *   "truck glovebox pistol" instead of "gun".
 */

export interface StockVideo {
  source: "pexels" | "pixabay";
  id: string;
  url: string;
  pageUrl: string;
  author?: string;
  width: number;
  height: number;
  duration: number;
  license: string;
}

const BUFFER_S = 3;
const RETRIES = 3;
const TIMEOUT_MS = 8000;
const CACHE = path.join(paths.root, "cache", "stock2");
const hash = (s: string) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

async function cached<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
  fs.mkdirSync(CACHE, { recursive: true });
  const f = path.join(CACHE, `${hash(key)}.json`);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < ttlMs) return JSON.parse(fs.readFileSync(f, "utf8")) as T;
  const v = await fetcher();
  fs.writeFileSync(f, JSON.stringify(v));
  return v;
}

export const stockKeys = () => ({ pexels: hasKey("PEXELS_API_KEY"), pixabay: hasKey("PIXABAY_API_KEY") });

interface PxFile { fps?: number; quality: string; width: number; height: number; id: number; link: string; file_type?: string }
interface PxVideo { id: number; url: string; duration: number; user?: { name: string }; video_files: PxFile[] }

async function pexelsMatches(term: string, need: number, exclude: Set<string>): Promise<StockVideo[]> {
  if (!hasKey("PEXELS_API_KEY")) return [];
  const data = await cached(`pexels80:${term}`, 24 * 3600_000, async () => {
    const res = await netFetch(`https://api.pexels.com/videos/search?orientation=landscape&size=medium&per_page=80&query=${encodeURIComponent(term)}`, {
      headers: { Authorization: env("PEXELS_API_KEY") },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) throw new Error("Pexels key rejected (check PEXELS_API_KEY in .env)");
    if (!res.ok) throw new Error(`Pexels ${res.status}`);
    return (await res.json()) as { videos?: PxVideo[] };
  });
  const out: StockVideo[] = [];
  for (const v of data.videos ?? []) {
    const id = `pexels_${v.id}`;
    if (exclude.has(id)) continue;
    for (const f of v.video_files) {
      if (f.file_type && f.file_type !== "video/mp4") continue;
      // Low-fps files play slower once conformed to 25+ fps: their usable length shrinks.
      const dur = f.fps && f.fps < 25 ? v.duration * (f.fps / 25) : v.duration;
      if (dur < need + BUFFER_S) continue;
      if (!(f.width === 1920 && f.height === 1080) && !(f.width >= 1280 && f.width < 2560 && f.width / f.height > 1.7)) continue;
      out.push({ source: "pexels", id, url: f.link, pageUrl: v.url, author: v.user?.name, width: f.width, height: f.height, duration: dur, license: "Pexels License (free to use, no attribution required)" });
      break;
    }
  }
  return out;
}

interface PbHit { id: number; pageURL: string; duration: number; user: string; videos: Record<string, { url: string; width: number; height: number }> }

async function pixabayMatches(term: string, need: number, exclude: Set<string>): Promise<StockVideo[]> {
  if (!hasKey("PIXABAY_API_KEY")) return [];
  const data = await cached(`pixabay80:${term}`, 24 * 3600_000, async () => {
    const res = await netFetch(`https://pixabay.com/api/videos/?key=${env("PIXABAY_API_KEY")}&q=${encodeURIComponent(term.slice(0, 100))}&per_page=80&safesearch=true`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`Pixabay ${res.status}`);
    return (await res.json()) as { hits?: PbHit[] };
  });
  const out: StockVideo[] = [];
  for (const h of data.hits ?? []) {
    const id = `pixabay_${h.id}`;
    if (exclude.has(id) || h.duration < need + BUFFER_S) continue;
    const f = ["large", "medium"].map((k) => h.videos[k]).find((x) => x?.url && x.width >= 1280 && x.width < 2560);
    if (f) out.push({ source: "pixabay", id, url: f.url, pageUrl: h.pageURL, author: h.user, width: f.width, height: f.height, duration: h.duration, license: "Pixabay Content License (free to use, no attribution required)" });
  }
  return out;
}

/**
 * One stock clip for `terms` (tried in order, then `fallbackTerms`) that is at least need + 3 s
 * long and not in `excludeIds`. The chosen id is added to excludeIds. Null when nothing fits or
 * no key is set.
 */
export async function findStockVideo(terms: string[], needSec: number, excludeIds: Set<string>, fallbackTerms: string[] = [], log: (m: string) => void = () => {}): Promise<StockVideo | null> {
  if (!stockKeys().pexels && !stockKeys().pixabay) return null;
  for (const term of [...terms, ...fallbackTerms]) {
    for (let attempt = 0; attempt < RETRIES; attempt++) {
      try {
        const list = [...(await pexelsMatches(term, needSec, excludeIds)), ...(await pixabayMatches(term, needSec, excludeIds))];
        if (!list.length) break;
        // Random among the best third (both sites rank by relevance) so videos don't all look alike.
        const top = list.slice(0, Math.max(3, Math.ceil(list.length / 3)));
        const pick = top[Math.floor(Math.random() * top.length)];
        excludeIds.add(pick.id);
        return pick;
      } catch (err) {
        log(`[stock] "${term}" attempt ${attempt + 1} failed: ${String((err as Error).message ?? err).slice(0, 120)}`);
      }
    }
  }
  return null;
}

const STOP = new Set("a an the and or for of to in on with under over best top cheap budget guns gun pistol pistols handgun handguns rifle rifles shotgun shotguns tech gadgets gadget products review reviews vs your you my our this that these those buy 2024 2025 2026 2027 most new list".split(" "));

/** The title's theme words: "Best guns for a truck under $350" -> "truck". */
export function titleTheme(title: string | undefined): string {
  if (!title) return "";
  return title
    .toLowerCase()
    .replace(/\$?\d[\d,.]*k?/g, " ")
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 3)
    .join(" ");
}

const TERMS_SYSTEM = `# Role: Video Search Terms Generator
## Goals:
Generate stock-footage search terms for each numbered narration line of a video.
## Constraints:
1. Return a JSON object only: {"lines": [{"id": <number>, "terms": ["...", "..."]}]}, one entry per line given.
2. Each line gets 3 search terms; each term has 1-3 words.
3. Always add the main subject of the video (given below) to the first term of every line.
4. Terms describe something a stock camera could film (objects, places, actions), never brand or model names, never people talking.
5. English only.
6. Keep the lines in the same order as the narration; earlier terms describe earlier visual moments.`;

/** MPT-style search terms per generic narration line, with the title theme as main subject. Cached. */
export async function searchTermsForLines(subject: string, lines: { id: number; text: string }[], log: (m: string) => void = () => {}): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  if (!subject || !lines.length) return out;
  const fallback = () => {
    for (const l of lines) out.set(l.id, [subject]);
    return out;
  };
  if (!llmAvailable()) return fallback();
  const model = agentModel();
  try {
    const res = await cached(`terms-v1:${model}:${subject}:${JSON.stringify(lines)}`, 30 * 86400_000, async () => {
      const client = llm();
      const msg = await client.messages.create({
        model,
        max_tokens: 4000,
        system: TERMS_SYSTEM,
        messages: [{ role: "user", content: `Main subject of the video: "${subject}"\n\n${lines.map((l) => `${l.id}. ${l.text.slice(0, 300)}`).join("\n")}` }],
      });
      const text = msg.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
      return JSON.parse(json) as { lines: { id: number; terms: string[] }[] };
    });
    for (const l of res.lines ?? []) if (Array.isArray(l.terms) && l.terms.length) out.set(Number(l.id), l.terms.map(String).slice(0, 3));
    log(`[stock] search terms with title theme "${subject}" for ${out.size}/${lines.length} generic line(s)`);
    return out.size ? out : fallback();
  } catch (err) {
    log(`[stock] search-term prompt failed (${String((err as Error).message ?? err).slice(0, 120)}); using "${subject}"`);
    return fallback();
  }
}
