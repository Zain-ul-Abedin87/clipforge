// Exact-model product data via a real headless browser (Playwright Chromium), any kind of product.
// Usage: node scripts/product_browser.mjs "<product>" "<category>" [officialUrl]
// Prints ONE JSON line: { ok, amazon: {...}|null, official: {...}|null, errors: [] }.
// Polite: one page at a time, normal desktop UA, 2-4 s pauses, no logins, no cookies reused.
import { chromium } from "playwright";

const [product = "", category = "", hintsArg = "[]"] = process.argv.slice(2);
let urlHints = []; try { urlHints = JSON.parse(hintsArg); } catch { urlHints = /^https?:/.test(hintsArg) ? [hintsArg] : []; }
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const polite = () => sleep(2000 + Math.random() * 2000);
const words = product.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
const brand = words[0] ?? "";
const nameMatch = (t) => { const s = String(t || "").toLowerCase(); return words.every((w) => s.includes(w)); };
const RETAIL = /(amazon|ebay|walmart|homedepot|lowes|target|bestbuy|youtube|facebook|reddit|wikipedia|pinterest|instagram|tiktok|bing\.|google\.|duckduckgo|craigslist|tractorsupply|acmetools|northerntool|costco)/i;
const errors = [];
// Replacement parts / accessories that merely name the model ("Air Filter for Toro ...") are not the product.
const ACCESSORY = /\b(for|fits?|compatible with|replacement|replaces)\b/i;
// Whole-product listings pass (the vision exact-model check decides later); only "X for <model>" parts fail.
const isProduct = (t) => { const s = String(t); const i = s.toLowerCase().indexOf(brand); return nameMatch(s) && !(i > 0 && ACCESSORY.test(s.slice(0, i))); };
const LAUNCH = { headless: true, args: ["--disable-blink-features=AutomationControlled"] };

// Web search through the same browser: DuckDuckGo HTML, then Bing (redirect links decoded).
async function searchLinks(ctx, q) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await searchOnce(ctx, q);
    if (r.length) return r;
    await sleep(5000 * 2 ** attempt + Math.random() * 2000); // backoff: 5 s, 10 s, 20 s
  }
  return [];
}
async function searchOnce(ctx, q) {
  const page = await ctx.newPage();
  const out = [];
  try {
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(1500);
    for (const h of await page.$$eval("a.result__a", (as) => as.map((a) => a.href))) { const m = h.match(/uddg=([^&]+)/); out.push(m ? decodeURIComponent(m[1]) : h); }
    if (!out.length) {
      await polite();
      await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=en-US`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await sleep(1500);
      for (const h of await page.$$eval("li.b_algo h2 a", (as) => as.map((a) => a.href))) {
        const m = h.match(/[?&]u=a1([^&]+)/);
        if (m) { try { out.push(Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")); } catch {} } else out.push(h);
      }
    }
  } catch (e) { errors.push(`search "${q}": ${String(e).slice(0, 120)}`); } finally { await page.close(); }
  return out.filter((u) => /^https?:\/\//.test(u));
}

async function amazon(ctx) {
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(`${product} ${category}`.trim())}`, { waitUntil: "domcontentloaded", timeout: 45000 });
    await polite();
    const results = await page.$$eval('[data-component-type="s-search-result"]', (els) => els.slice(0, 20).map((e) => {
      const a = e.querySelector("h2 a, a.a-link-normal.s-no-outline, a.a-link-normal[href*='/dp/']");
      return { title: (e.querySelector("h2")?.textContent || "").trim(), href: a ? a.href : "", sponsored: /Sponsored/i.test(e.textContent || "") };
    }));
    const byBrand = (r) => (String(r.title).toLowerCase().startsWith(brand) ? 0 : 1);
    const hit = results.filter((r) => r.href && isProduct(r.title)).sort((x, y) => byBrand(x) - byBrand(y) || Number(x.sponsored) - Number(y.sponsored))[0];
    let target = hit?.href;
    if (!target) {
      // Search page refused (bot wall) or no exact match: find the /dp/ page through web search.
      await polite();
      const links = await searchLinks(ctx, `${product} ${category} amazon.com`);
      target = links.find((u) => /amazon\.com\/(.*\/)?dp\/[A-Z0-9]{10}/.test(u) && nameMatch(decodeURIComponent(u).replace(/[-_/]/g, " ")))
        ?? links.find((u) => /amazon\.com\/(.*\/)?dp\/[A-Z0-9]{10}/.test(u));
      if (!target) return { searched: page.url(), searchBlocked: !(await page.title()), results: results.length, note: "no exact-model result (search page " + ((await page.title()) || "blocked") + ")" };
    }
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 45000 });
    await polite();
    const data = await page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      const imgs = new Set();
      for (const m of html.matchAll(/"hiRes":"(https:[^"]+)"/g)) imgs.add(m[1]);
      if (!imgs.size) for (const m of html.matchAll(/"large":"(https:[^"]+)"/g)) imgs.add(m[1]);
      const dyn = document.querySelector("#landingImage")?.getAttribute("data-a-dynamic-image");
      if (dyn) try { for (const u of Object.keys(JSON.parse(dyn))) imgs.add(u); } catch {}
      const vids = new Set();
      for (const m of html.matchAll(/"(?:url|videoUrl)":"(https:[^"]+?\.mp4[^"]*)"/g)) vids.add(m[1].replace(/\\u002F/g, "/"));
      const rows = [];
      for (const tr of document.querySelectorAll("#productDetails_techSpec_section_1 tr, #productDetails_detailBullets_sections1 tr, #prodDetails tr, #poExpander tr, table.a-normal.a-spacing-micro tr")) {
        const k = tr.querySelector("th, td.a-span3")?.textContent?.trim(), v = tr.querySelector("td:last-child")?.textContent?.trim();
        if (k && v && k !== v && k.length < 60 && v.length < 120) rows.push({ label: k.replace(/\s+/g, " "), value: v.replace(/[\u200e\u200f]/g, "").replace(/\s+/g, " ") });
      }
      return {
        title: document.querySelector("#productTitle")?.textContent?.trim() ?? "",
        price: document.querySelector("#corePrice_feature_div .a-offscreen, .a-price .a-offscreen")?.textContent?.trim() ?? "",
        bullets: [...document.querySelectorAll("#feature-bullets li span.a-list-item")].map((e) => e.textContent.trim()).filter(Boolean).slice(0, 10),
        specs: rows.slice(0, 30), images: [...imgs].slice(0, 20), videos: [...vids].slice(0, 6),
      };
    });
    const blocked = /captcha|robot check/i.test(await page.title());
    return { url: page.url().split("?")[0], blocked: blocked || !data.title, exactModel: isProduct(data.title), ...data };
  } catch (e) { errors.push(`amazon: ${String(e).slice(0, 160)}`); return null; } finally { await page.close(); }
}

async function pageOk(ctx, url) {
  const page = await ctx.newPage();
  try {
    const r = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    if (!r || r.status() >= 400) return "";
    const t = `${await page.title()} ${page.url()}`.replace(/[-_/]/g, " ");
    return nameMatch(t) ? page.url() : "";
  } catch { return ""; } finally { await page.close(); }
}
async function findOfficial(ctx) {
  // 1) Haiku URL guesses, 2) web search (DDG -> Bing, retry + backoff), 3) brand-domain guess.
  for (const u of urlHints) { const ok = await pageOk(ctx, u); if (ok) return ok; await polite(); }
  const links = await searchLinks(ctx, `${product} ${category} official`);
  const ok = links.filter((u) => { try { return !RETAIL.test(new URL(u).hostname) && !/manual|support|parts/i.test(u); } catch { return false; } });
  const hit = ok.find((u) => new URL(u).hostname.includes(brand) && words.slice(1).some((w) => u.toLowerCase().includes(w))) ?? ok.find((u) => new URL(u).hostname.includes(brand));
  if (hit) return hit;
  const page = await ctx.newPage();
  try {
    await page.goto(`https://www.${brand}.com/`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);
    const as = await page.$$eval("a[href]", (xs) => xs.map((a) => ({ href: a.href, text: `${a.textContent} ${a.href}` })));
    const m = as.find((a) => words.slice(1).every((w) => a.text.toLowerCase().replace(/[-_/]/g, " ").includes(w)));
    return m?.href ?? "";
  } catch { return ""; } finally { await page.close(); }
}

async function official(ctx) {
  const url = await findOfficial(ctx);
  if (!url) return { note: "official page not found" };
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    await polite();
    await page.mouse.wheel(0, 4000).catch(() => {});
    await sleep(1500);
    const data = await page.evaluate(() => {
      const imgs = new Set(), vids = new Set(), specs = [];
      const og = document.querySelector('meta[property="og:image"]')?.getAttribute("content"); if (og) imgs.add(og);
      const walk = (o) => { if (!o || typeof o !== "object") return; if (Array.isArray(o)) return o.forEach(walk);
        if (o.image) [].concat(o.image).forEach((i) => imgs.add(typeof i === "string" ? i : i?.url));
        if (o.contentUrl) vids.add(o.contentUrl); if (o.embedUrl) vids.add(o.embedUrl);
        if (o.additionalProperty) [].concat(o.additionalProperty).forEach((p) => p?.name && p?.value && specs.push({ label: String(p.name), value: String(p.value) }));
        Object.values(o).forEach(walk); };
      let name = "";
      for (const s of document.querySelectorAll('script[type="application/ld+json"]')) try { const j = JSON.parse(s.textContent); walk(j); name ||= [].concat(j).find((x) => x?.["@type"] === "Product")?.name ?? ""; } catch {}
      for (const im of document.querySelectorAll("img")) {
        const src = im.currentSrc || im.src || im.getAttribute("data-src") || "";
        const w = im.naturalWidth || 0;
        if (/^https?:/.test(src) && (w >= 600 || /zoom|large|hires|gallery|product/i.test(src + im.className))) imgs.add(src);
      }
      for (const v of document.querySelectorAll("video source, video")) { const s = v.src || v.getAttribute("src"); if (s && /^https?:/.test(s)) vids.add(s); }
      for (const f of document.querySelectorAll('iframe[src*="youtube"], a[href*="youtube.com/watch"], a[href*="youtu.be/"]')) { const s = f.src || f.href; if (s) vids.add(s.replace(/\/embed\/([\w-]{11}).*/, "/watch?v=$1")); }
      for (const tr of document.querySelectorAll("table tr, dl")) {
        const k = tr.querySelector("th, dt, td:first-child")?.textContent?.trim(), v = tr.querySelector("td:last-child, dd")?.textContent?.trim();
        if (k && v && k !== v && k.length < 50 && v.length < 100) specs.push({ label: k.replace(/\s+/g, " "), value: v.replace(/\s+/g, " ") });
      }
      return { title: document.title, name, images: [...imgs].filter(Boolean).slice(0, 30), videos: [...vids].filter(Boolean).slice(0, 10), specs: specs.slice(0, 40) };
    });
    return { url: page.url(), exactModel: nameMatch(`${data.name || data.title} ${new URL(page.url()).hostname} ${decodeURIComponent(new URL(page.url()).pathname).replace(/[-_/]/g, " ")}`), ...data };
  } catch (e) { errors.push(`official: ${String(e).slice(0, 160)}`); return { url, note: "load failed" }; } finally { await page.close(); }
}

let browser;
try {
  browser = await chromium.launch(LAUNCH);
  const ctx = await browser.newContext({ userAgent: UA, locale: "en-US", viewport: { width: 1366, height: 900 }, extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" } });
  const a = await amazon(ctx);
  await polite();
  const o = await official(ctx);
  console.log(JSON.stringify({ ok: true, amazon: a, official: o, errors }));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e).slice(0, 300), errors }));
} finally { await browser?.close(); }
