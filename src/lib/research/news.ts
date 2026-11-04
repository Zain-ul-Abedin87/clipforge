import { ResearchDb } from "./db.js";

/**
 * Google News RSS headlines for a topic (free, no key): fresh hooks for titles / intros
 * ("after the new ATF rule", "this year's recall"). Cached 6 hours in data/research.db.
 * Headlines are used as context for an angle, never copied into a title.
 */

export interface NewsItem {
  title: string;
  source: string;
  link: string;
  published: string;
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();

export function parseRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (t: string) => decode(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(m[1])?.[1] ?? "");
    const source = tag("source");
    // Google appends " - Source" to every title.
    const title = tag("title").replace(source ? new RegExp(`\\s+-\\s+${source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) : /$^/, "");
    if (title) out.push({ title, source, link: tag("link"), published: tag("pubDate") });
  }
  return out;
}

export async function newsHooks(topic: string, o: { db?: ResearchDb; fetch?: typeof fetch; max?: number; log?: (m: string) => void } = {}): Promise<NewsItem[]> {
  const db = o.db ?? new ResearchDb();
  const key = `news:${topic.toLowerCase()}`;
  const hit = db.getCache<NewsItem[]>(key, 6 * 3600_000);
  if (hit) return hit.slice(0, o.max ?? 8);
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}+when:30d&hl=en-US&gl=US&ceid=US:en`;
  try {
    const res = await (o.fetch ?? fetch)(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const items = parseRss(await res.text());
    db.setCache(key, items);
    o.log?.(`[titles] Google News: ${items.length} headline(s) for "${topic}"`);
    return items.slice(0, o.max ?? 8);
  } catch (err) {
    o.log?.(`[titles] Google News not reachable (${(err as Error).message}); no news hooks`);
    return [];
  }
}
