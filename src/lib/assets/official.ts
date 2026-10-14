import fs from "node:fs";
import path from "node:path";
import type { Niche } from "../niche.js";
import { paths } from "../paths.js";
import { addPresskitFile, slug, USER_AGENT } from "./presskit.js";
import { choosePage, ImageIn, pickProductPhotos } from "../agent/official.js";
import { agentEnabled } from "../agent/footage.js";
import { researchProduct } from "../agent/webResearch.js";

/**
 * Official photo importer: product name -> manufacturer site (niche brand table) -> product page
 * (found through the site's own sitemap) -> product photos into the channel's press kit, with the
 * page recorded as the source. YouTube links on that page are listed for the user, never fetched.
 * Sites that refuse the request (403) or disallow the path in robots.txt are skipped and reported.
 */

export interface OfficialResult {
  product: string;
  status: "imported" | "has-media" | "no-brand" | "blocked" | "not-found" | "no-photos" | "recent";
  page?: string;
  photos: number;
  youtube: string[];
  message?: string;
}

const MEDIA = /\.(jpe?g|png|webp|mp4|mov|m4v|webm)$/i;
const RETRY_DAYS = 7;
const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function get(url: string, timeoutMs = 30_000): Promise<Response> {
  return fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xml;q=0.9,*/*;q=0.8" }, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
}

class Blocked extends Error {}

async function text(url: string): Promise<string> {
  const res = await get(url);
  if (res.status === 403 || res.status === 401) throw new Blocked(`${new URL(url).hostname} refused the request (HTTP ${res.status})`);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

interface Robots {
  sitemaps: string[];
  disallow: string[];
}

async function robots(origin: string): Promise<Robots> {
  const out: Robots = { sitemaps: [], disallow: [] };
  let body = "";
  try {
    body = await text(`${origin}/robots.txt`);
  } catch (err) {
    if (err instanceof Blocked) throw err;
    return out;
  }
  let forAll = false;
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const [k, ...rest] = line.split(":");
    const v = rest.join(":").trim();
    if (/^sitemap$/i.test(k) && v) out.sitemaps.push(v);
    else if (/^user-agent$/i.test(k)) forAll = v === "*";
    else if (forAll && /^disallow$/i.test(k) && v) out.disallow.push(v);
  }
  return out;
}

const allowed = (r: Robots, url: string) => {
  const p = new URL(url).pathname;
  return !r.disallow.some((d) => !d.includes("*") && p.startsWith(d));
};

/** Same-site links on a page, with their link text (used to match the product name). */
function linksOn(html: string, page: string): Map<string, string> {
  const host = new URL(page).hostname.replace(/^www\./, "");
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<a\b[^>]*href=["\x27]([^"\x27#]+)["\x27][^>]*>([\s\S]*?)<\/a>/gi)) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, "&"), page);
      if (u.hostname.replace(/^www\./, "") !== host || !/^https?:$/.test(u.protocol)) continue;
      u.search = "";
      const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
      out.set(u.href, `${out.get(u.href) ?? ""} ${label}`.trim());
    } catch {
      /* bad href */
    }
  }
  return out;
}

const CATEGORY = /pistol|handgun|rifle|shotgun|revolver|carbine|firearm|product|shop|catalog|models?\b|series|lineup/i;

/**
 * Sites without a sitemap: read the homepage and up to 30 category pages (one level), and collect
 * every same-site link with its text. Spaced requests, robots.txt respected.
 */
async function crawlLinks(origin: string, r: Robots, focus: string[], log: (m: string) => void): Promise<Map<string, string>> {
  const all = new Map<string, string>();
  const home = linksOn(await text(origin + "/"), origin + "/");
  home.forEach((v, k) => all.set(k, v));
  const cats = [...home.entries()]
    .filter(([u, label]) => allowed(r, u) && (CATEGORY.test(u + " " + label) || focus.some((f) => compact(u + label).includes(f))))
    .slice(0, 30);
  for (const [u] of cats) {
    await new Promise((res) => setTimeout(res, 700));
    try {
      linksOn(await text(u), u).forEach((v, k) => all.set(k, `${all.get(k) ?? ""} ${v}`.trim()));
    } catch (err) {
      if (err instanceof Blocked) throw err;
    }
  }
  log(`[official] ${new URL(origin).hostname}: no usable sitemap, crawled ${cats.length + 1} page(s), ${all.size} links`);
  return all;
}

/** All page URLs listed in the site's sitemaps (follows sitemap indexes, product sitemaps first). */
async function sitemapUrls(origin: string, r: Robots, log: (m: string) => void): Promise<string[]> {
  const queue = r.sitemaps.length ? [...r.sitemaps] : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const seen = new Set<string>();
  const pages: string[] = [];
  let fetched = 0;
  while (queue.length && fetched < 25) {
    queue.sort((a, b) => Number(/product/i.test(b)) - Number(/product/i.test(a)));
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    let xml: string;
    try {
      xml = await text(sm);
      fetched++;
    } catch (err) {
      if (err instanceof Blocked) throw err;
      continue;
    }
    const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?([^<\]]+?)(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&").trim());
    if (/<sitemapindex/i.test(xml)) {
      // Skip blog / news / image sitemaps: product pages live elsewhere.
      queue.push(...locs.filter((l) => !/blog|news|post|article|author|tag|category|video|image/i.test(l)));
    } else pages.push(...locs);
  }
  log(`[official] ${new URL(origin).hostname}: ${pages.length} pages in ${fetched} sitemap file(s)`);
  return pages;
}

/** "995ts" -> ["995", "ts"]: letter/digit runs, for loose matching of model variants. */
const parts = (t: string) => t.match(/[a-z]+|\d+/g) ?? [];

/**
 * Best product page: every model token in the URL (or link text), the full compact model name
 * preferred. Falls back to a loose match (most model parts, a model number required) so
 * "Hi-Point 995TS" still finds the 995 carbine page.
 */
async function bestPage(product: string, pages: string[], modelTokens: string[], labels?: Map<string, string>): Promise<string | undefined> {
  const strict = strictPage(pages, modelTokens, labels);
  const want = compact(modelTokens.join(""));
  const exact = strict.filter((u) => compact(new URL(u).pathname).includes(want));
  if (exact.length === 1) return exact[0];
  // Ambiguous or loose (e.g. "995" matches both the 995 pistol and the 995TS carbine): let the
  // agent read the candidates; without the agent the best-scored page wins.
  const cands = [...new Set([...strict, ...loosePage(pages, modelTokens, labels)])].slice(0, 8);
  if (cands.length <= 1) return cands[0];
  const i = await choosePage(product, cands.map((url) => ({ url, label: labels?.get(url) })));
  return i >= 0 ? cands[i] : undefined;
}

function loosePage(pages: string[], modelTokens: string[], labels?: Map<string, string>): string[] {
  const all = modelTokens.flatMap(parts).filter((p) => p.length > 1 || /\d/.test(p));
  const digits = all.filter((p) => /\d/.test(p));
  if (!all.length) return [];
  const scored = pages
    .map((u) => {
      let p: string;
      try {
        p = decodeURIComponent(new URL(u).pathname).toLowerCase() + " " + (labels?.get(u) ?? "").toLowerCase();
      } catch {
        return null;
      }
      if (SKIP_PAGE.test(p)) return null;
      const words = new Set(p.split(/[^a-z0-9]+/).flatMap(parts));
      if (digits.length && !digits.some((d) => words.has(d))) return null;
      const ratio = all.filter((x) => words.has(x)).length / all.length;
      return ratio >= 0.5 ? { u, s: ratio - p.length / 1000 } : null;
    })
    .filter((x): x is { u: string; s: number } => !!x)
    .sort((a, b) => b.s - a.s);
  return scored.map((x) => x.u);
}

const SKIP_PAGE = /blog|news|article|review|compare|accessor|parts?\b|magazines?\b|holster|sights?\b|manual|dealer|warranty|recall/i;

function strictPage(pages: string[], modelTokens: string[], labels?: Map<string, string>): string[] {
  const want = compact(modelTokens.join(""));
  const scored = pages
    .map((u) => {
      let p: string;
      try {
        p = decodeURIComponent(new URL(u).pathname).toLowerCase();
      } catch {
        return null;
      }
      if (SKIP_PAGE.test(p)) return null;
      const c = compact(p + (labels?.get(u) ?? ""));
      if (!modelTokens.every((t) => c.includes(compact(t)))) return null;
      return { u, s: (c.includes(want) ? 10 : 0) - p.length / 100 };
    })
    .filter((x): x is { u: string; s: number } => !!x)
    .sort((a, b) => b.s - a.s);
  return scored.map((x) => x.u);
}

const JUNK_IMG = /\.(svg|gif)(\?|$)|logo|icon|sprite|placeholder|badge|flag|\/nav\/|menu|thumbnail_|banner|footer|social|payment|avatar|mark\.png|warranty|promo|coupon|newsletter|dealer/i;

/** Every other image on the page (for pages whose photo files do not carry the model name). */
function otherImages(html: string, page: string, skip: Set<string>): string[] {
  const out = new Set<string>();
  // Also catches URLs inside JSON in <script> tags, where the closing quote is escaped (\").
  for (const m of html.matchAll(/["'(]([^"'()\s\\]+\.(?:jpe?g|png|webp)(?:\?[^"'()\s\\]*)?)\\?["')]/gi)) {
    try {
      const u = new URL(m[1].replace(/&amp;/g, "&").replace(/\\\//g, "/"), page).href;
      if (/^https?:/.test(u) && !JUNK_IMG.test(u) && !skip.has(u)) out.add(u);
    } catch {
      /* not a URL */
    }
  }
  // Files named after the page (e.g. "...Ported_COA..." on the ".../cz-p-10-c-ported-coa" page) first.
  const slugWords = (new URL(page).pathname.split("/").filter(Boolean).pop() ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2);
  // Big renditions before small ones ("large_x.jpg" before "small_x.jpg").
  const hits = (u: string) => slugWords.filter((w) => u.toLowerCase().includes(w)).length * 2 + (/large|full|original|1920|2048/i.test(u) ? 1 : 0) - (/small|thumb|medium|150x|300x/i.test(u) ? 1 : 0);
  return [...out].sort((a, b) => hits(b) - hits(a)).slice(0, 10);
}

/** One URL per picture: "small_x.jpg", "large_x.jpg" and "x-300x200.jpg" are the same photo (largest kept). */
function dedupeRenditions(urls: string[]): string[] {
  const key = (u: string) =>
    decodeURIComponent(path.posix.basename(new URL(u).pathname))
      .toLowerCase()
      .replace(/^(thumbnail|small|medium|large|xlarge|full)[_-]/, "")
      .replace(/-\d{2,4}x\d{2,4}(?=\.)/, "")
      .replace(/\.(jpe?g|png|webp)$/, "");
  const rank = (u: string) => (/large|full|original/i.test(u) ? 2 : /small|thumb|medium|\d{2,3}x\d{2,3}/i.test(u) ? 0 : 1);
  const best = new Map<string, string>();
  for (const u of urls) {
    const k = key(u);
    const prev = best.get(k);
    if (!prev || rank(u) > rank(prev)) best.set(k, u);
  }
  return [...best.values()];
}

/** Downloads candidate images into memory for the agent to look at (small, real images only). */
async function loadImages(urls: string[]): Promise<{ url: string; img: ImageIn }[]> {
  const out: { url: string; img: ImageIn }[] = [];
  for (const url of urls) {
    try {
      const res = await get(url, 30_000);
      if (!res.ok) continue;
      const data = Buffer.from(await res.arrayBuffer());
      // Cloud storage often answers "application/octet-stream": trust the file's magic bytes.
      const type =
        data[0] === 0xff && data[1] === 0xd8 ? "image/jpeg"
        : data.subarray(1, 4).toString() === "PNG" ? "image/png"
        : data.subarray(8, 12).toString() === "WEBP" ? "image/webp"
        : "";
      if (!type) continue;
      if (data.length < 15_000 || data.length > 4_500_000) continue;
      out.push({ url, img: { mime: type as ImageIn["mime"], data } });
    } catch {
      /* skip */
    }
  }
  return out;
}

/** Product photo URLs on the page: og/twitter image, JSON-LD Product images, big <img> naming the model. */
function photosOn(html: string, page: string, modelTokens: string[]): string[] {
  const abs = (u: string) => {
    try {
      return new URL(u.replace(/&amp;/g, "&").trim(), page).href;
    } catch {
      return "";
    }
  };
  const found: string[] = [];
  for (const m of html.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)(?::src)?["'][^>]*>/gi)) {
    const c = m[0].match(/content=["']([^"']+)["']/i);
    if (c) found.push(abs(c[1]));
  }
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n: unknown): void => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== "object") return;
        const o = n as Record<string, unknown>;
        if (String(o["@type"] ?? "").includes("Product")) {
          const img = o.image;
          for (const i of Array.isArray(img) ? img : [img]) {
            if (typeof i === "string") found.push(abs(i));
            else if (i && typeof i === "object" && typeof (i as { url?: unknown }).url === "string") found.push(abs((i as { url: string }).url));
          }
        }
        Object.values(o).forEach(walk);
      };
      walk(JSON.parse(m[1]));
    } catch {
      /* broken JSON-LD */
    }
  }
  const model = compact(modelTokens.join(""));
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const alt = tag.match(/alt=["']([^"']*)["']/i)?.[1] ?? "";
    const srcset = tag.match(/(?:data-)?srcset=["']([^"']+)["']/i)?.[1];
    // Largest srcset entry, else data-src / src.
    const fromSet = srcset
      ?.split(",")
      .map((x) => x.trim().split(/\s+/))
      .map(([u, w]) => ({ u, w: parseInt(w ?? "0", 10) || 0 }))
      .sort((a, b) => b.w - a.w)[0]?.u;
    const big = tag.match(/data-(?:downloadableimagesrc|zoom-image|large(?:_image)?|full(?:size)?|original)=["']([^"']+)["']/i)?.[1];
    const src = big ?? fromSet ?? tag.match(/(?:data-src|src)=["']([^"']+)["']/i)?.[1];
    if (!src) continue;
    const u = abs(src);
    if (compact(u).includes(model) || compact(alt).includes(model)) found.push(u);
  }
  return [...new Set(found.filter((u) => /^https?:/.test(u) && !/\.(svg|gif)(\?|$)|logo|icon|sprite|placeholder|badge|flag/i.test(u)))].slice(0, 8);
}

function youtubeOn(html: string): string[] {
  const ids = [...html.matchAll(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?v=|shorts\/)|youtu\.be\/)([\w-]{11})/g)].map((m) => m[1]);
  return [...new Set(ids)].map((id) => `https://www.youtube.com/watch?v=${id}`);
}

/**
 * Product photos from one official page into the channel's press kit (max 5, real images only).
 * With the agent on, Claude looks at the page's images and keeps only photos of this product.
 */
async function importFromPage(
  channel: string,
  product: string,
  page: string,
  modelTokens: string[],
  via: string,
  log: (m: string) => void,
): Promise<OfficialResult> {
  const dir = path.join(paths.channels, channel, "presskit", slug(product));
  const html = await text(page);
  let photos = dedupeRenditions(photosOn(html, page, modelTokens));
  if (agentEnabled()) {
    // og:images are sometimes site-wide, and many sites use numbered file names.
    const pool = dedupeRenditions([...photos, ...otherImages(html, page, new Set(photos))]).slice(0, 8);
    const loaded = await loadImages(pool);
    const keep = await pickProductPhotos(product, loaded.map((l) => l.img));
    photos = keep.map((i) => loaded[i].url);
    log(`[official] ${product}: agent kept ${keep.length} of ${loaded.length} image(s) on ${new URL(page).hostname}`);
  }
  const youtube = youtubeOn(html);
  let saved = 0;
  for (const url of photos) {
    if (saved >= 5) break;
    try {
      const f = await addPresskitFile(channel, product, url, `Manufacturer product photo (${via}, editorial/review use) - ${page}`);
      // Thumbnails and swatches are useless on a 1080p screen.
      if (f.bytes < 15_000) fs.rmSync(f.file);
      else saved++;
    } catch {
      /* not an image / failed: try the next one */
    }
  }
  if (youtube.length) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "youtube_links.txt"), `# Official videos linked on ${page}\n# Download yourself if you have the rights, then add them in My clips.\n${youtube.join("\n")}\n`);
  }
  return { product, status: saved ? "imported" : "no-photos", page, photos: saved, youtube };
}

/**
 * Web-search path: Claude finds the maker's product / press pages (any brand, any niche); each is
 * tried in order until one gives photos. robots.txt is respected per site.
 */
async function importViaWebSearch(
  channel: string,
  product: string,
  niche: Niche,
  robotsCache: Map<string, Robots>,
  log: (m: string) => void,
): Promise<OfficialResult | null> {
  const research = await researchProduct(channel, product, niche.label, log);
  if (!research?.pages.length) return null;
  const tokens = product.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
  let last: OfficialResult | null = null;
  const good: OfficialResult[] = [];
  let total = 0;
  for (const p of research.pages) {
    // Product pages often have one hero shot; press pages add more angles. Stop at 3 photos.
    if (total >= 3) break;
    const origin = new URL(p.url).origin;
    try {
      if (!robotsCache.has(origin)) robotsCache.set(origin, await robots(origin));
      if (!allowed(robotsCache.get(origin)!, p.url)) {
        last = { product, status: "blocked", page: p.url, photos: 0, youtube: [], message: "robots.txt disallows this page" };
        continue;
      }
      const r = await importFromPage(channel, product, p.url, tokens, `${p.publisher} ${p.kind.replace("_", " ")}, found by web search`, log);
      if (r.photos) {
        total += r.photos;
        good.push(r);
      } else last = r;
    } catch (err) {
      last = err instanceof Blocked
        ? { product, status: "blocked", page: p.url, photos: 0, youtube: [], message: err.message }
        : { product, status: "not-found", page: p.url, photos: 0, youtube: [], message: String((err as Error).message ?? err).slice(0, 160) };
    }
  }
  if (!good.length) return last;
  return { ...good[0], photos: total, youtube: [...new Set(good.flatMap((g) => g.youtube))] };
}

const hasMedia = (dir: string) => fs.existsSync(dir) && fs.readdirSync(dir).some((f) => MEDIA.test(f));

/** Brand domain from the niche table (longest matching brand name wins). */
function brandOf(product: string, brands: Record<string, string>): { brand: string; domain: string } | undefined {
  const p = ` ${product.toLowerCase().replace(/[^a-z0-9&]+/g, " ")} `;
  const hit = Object.keys(brands)
    .filter((b) => p.includes(` ${b.toLowerCase().replace(/[^a-z0-9&]+/g, " ").trim()} `))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? { brand: hit, domain: brands[hit] } : undefined;
}

export async function importOfficial(channel: string, products: string[], niche: Niche, log: (m: string) => void, force = false): Promise<OfficialResult[]> {
  const brands = niche.official?.brands ?? {};
  const root = path.join(paths.channels, channel, "presskit");
  const triedFile = path.join(root, "official_tried.json");
  const tried: Record<string, OfficialResult & { at: string }> = fs.existsSync(triedFile) ? JSON.parse(fs.readFileSync(triedFile, "utf8")) : {};
  const sitemapCache = new Map<string, string[]>();
  const crawlCache = new Map<string, Map<string, string>>();
  const robotsCache = new Map<string, Robots>();
  const results: OfficialResult[] = [];

  for (const product of products) {
    const dir = path.join(root, slug(product));
    const prev = tried[slug(product)];
    if (!force && hasMedia(dir)) {
      results.push({ product, status: "has-media", photos: 0, youtube: prev?.youtube ?? [] });
      continue;
    }
    if (!force && prev && Date.now() - Date.parse(prev.at) < RETRY_DAYS * 864e5) {
      results.push({ ...prev, status: "recent", photos: 0, message: `tried ${prev.at.slice(0, 10)}: ${prev.status}` });
      continue;
    }
    const b = brandOf(product, brands);
    let r: OfficialResult;
    if (!b) {
      r = { product, status: "no-brand", photos: 0, youtube: [], message: `brand not in niches/${niche.name}.json official.brands` };
    } else {
      const origin = `https://${b.domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "")}`;
      const modelTokens = product
        .toLowerCase()
        .replace(b.brand.toLowerCase(), " ")
        .split(/[^a-z0-9]+/)
        .filter((t) => t && !["firearms", "arms", "armory", "usa", "inc"].includes(t));
      try {
        if (!robotsCache.has(origin)) robotsCache.set(origin, await robots(origin));
        const rb = robotsCache.get(origin)!;
        if (!sitemapCache.has(origin)) sitemapCache.set(origin, await sitemapUrls(origin, rb, log));
        const tokensFor = modelTokens.length ? modelTokens : [compact(product)];
        let page = await bestPage(product, sitemapCache.get(origin)!, tokensFor);
        if (!page) {
          if (!crawlCache.has(origin)) crawlCache.set(origin, await crawlLinks(origin, rb, tokensFor.map(compact).filter((t) => t.length > 3), log));
          const links = crawlCache.get(origin)!;
          page = await bestPage(product, [...links.keys()], tokensFor, links);
        }
        if (!page) r = { product, status: "not-found", photos: 0, youtube: [], message: `no product page for "${modelTokens.join(" ")}" on ${b.domain}` };
        else if (!allowed(rb, page)) r = { product, status: "blocked", page, photos: 0, youtube: [], message: "robots.txt disallows this page" };
        else r = await importFromPage(channel, product, page, modelTokens, "official site", log);
      } catch (err) {
        r = err instanceof Blocked
          ? { product, status: "blocked", photos: 0, youtube: [], message: err.message }
          : { product, status: "not-found", photos: 0, youtube: [], message: String((err as Error).message ?? err).slice(0, 160) };
      }
    }
    // No brand in the niche table, no page in the sitemap, or a refusing site: ask web search.
    if (r.status !== "imported") {
      const viaWeb = await importViaWebSearch(channel, product, niche, robotsCache, log);
      if (viaWeb && (viaWeb.status === "imported" || r.status === "no-brand")) r = viaWeb;
    }
    log(`[official] ${product}: ${r.status}${r.photos ? ` (${r.photos} photo${r.photos > 1 ? "s" : ""})` : ""}${r.youtube.length ? `, ${r.youtube.length} YouTube link(s)` : ""}${r.message ? ` - ${r.message}` : ""}`);
    results.push(r);
    tried[slug(product)] = { ...r, at: new Date().toISOString() };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(triedFile, JSON.stringify(tried, null, 1));
  }
  return results;
}
