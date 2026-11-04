import { netFetch } from "../net.js";
import { htmlToText } from "../agents/script/facts.js";

/**
 * Research sources for documentaries: the creator's own links and Wikipedia (MediaWiki API, free,
 * no key). Parameters as documented in MediaWiki's own API message files: list=search
 * (srsearch, srlimit, srnamespace), prop=extracts from TextExtracts (explaintext, exsectionformat),
 * prop=info with inprop=url (fullurl), redirects. Requests identify the tool (User-Agent), as
 * Wikimedia asks of automated clients.
 */

export interface Source {
  id: string;
  /** "wikipedia" | "link" | "notes" (the creator's own notes). */
  kind: string;
  url: string;
  title: string;
  text: string;
}

const UA = "ClipForge/0.1 (local faceless-video tool; personal use)";
type Fetch = typeof fetch;
const get = async (f: Fetch, url: string) => {
  const res = await f(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
};

export async function wikiSearch(query: string, lang = "en", limit = 3, f: Fetch = netFetch as unknown as Fetch): Promise<string[]> {
  const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  for (const [k, v] of Object.entries({ action: "query", list: "search", srsearch: query, srlimit: String(limit), srnamespace: "0", format: "json" })) u.searchParams.set(k, v);
  const j = (await (await get(f, u.toString())).json()) as { query?: { search?: { title: string }[] } };
  return (j.query?.search ?? []).map((x) => x.title);
}

export async function wikiPage(title: string, lang = "en", f: Fetch = netFetch as unknown as Fetch): Promise<Source | null> {
  const u = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  for (const [k, v] of Object.entries({ action: "query", prop: "extracts|info", inprop: "url", explaintext: "1", exsectionformat: "plain", redirects: "1", titles: title, format: "json" })) u.searchParams.set(k, v);
  const j = (await (await get(f, u.toString())).json()) as { query?: { pages?: Record<string, { title?: string; extract?: string; fullurl?: string; missing?: string }> } };
  const page = Object.values(j.query?.pages ?? {})[0];
  if (!page || page.missing !== undefined || !page.extract) return null;
  return { id: "", kind: "wikipedia", url: page.fullurl ?? `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`, title: `${page.title ?? title} (Wikipedia)`, text: page.extract.slice(0, 60_000) };
}

export async function linkPage(url: string, f: Fetch = netFetch as unknown as Fetch): Promise<Source> {
  const t = htmlToText(await (await get(f, url)).text());
  return { id: "", kind: "link", url, title: t.title || url, text: t.text.slice(0, 60_000) };
}

/** The creator's links, their notes and (optionally) Wikipedia, each with an id s1, s2 ... */
export async function gatherSources(o: { topic: string; links: string[]; notes: string; wikipedia: boolean; lang: string; pages: number; fetch?: Fetch; log?: (m: string) => void }): Promise<Source[]> {
  const log = o.log ?? (() => {});
  const out: Source[] = [];
  if (o.notes.trim()) out.push({ id: "", kind: "notes", url: "", title: "Your notes", text: o.notes.trim() });
  for (const url of o.links.slice(0, 8)) {
    try {
      out.push(await linkPage(url, o.fetch));
    } catch (err) {
      log(`[research] could not read ${url}: ${String((err as Error).message).slice(0, 100)}`);
    }
  }
  if (o.wikipedia) {
    try {
      for (const t of await wikiSearch(o.topic, o.lang, o.pages, o.fetch)) {
        const p = await wikiPage(t, o.lang, o.fetch).catch(() => null);
        if (p) out.push(p);
      }
    } catch (err) {
      log(`[research] Wikipedia not reachable: ${String((err as Error).message).slice(0, 100)}`);
    }
  }
  out.forEach((s, i) => (s.id = `s${i + 1}`));
  log(`[research] ${out.length} source(s): ${out.map((s) => s.title).join("; ").slice(0, 300)}`);
  return out;
}
