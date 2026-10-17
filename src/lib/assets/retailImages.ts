import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { venvPythonPath } from "../tools.js";
import { slug, USER_AGENT } from "./presskit.js";

/**
 * Best-effort official / retailer product images (any niche). When a product has fewer than
 * `want` photos in its press-kit folder, DuckDuckGo image results from the manufacturer's site and
 * big retailers (Amazon, Home Depot, Lowe's, Walmart, Best Buy, Target, ...) are downloaded into
 * channels/<ch>/presskit/<product>/retail_*.jpg. They are NOT trusted: the timeline's exact-model
 * check decides which ones may be shown. Blocked / rate-limited searches are skipped quietly.
 * RETAIL_IMAGES=off disables it.
 */

const RETAIL = /(amazon\.|media-amazon|homedepot|lowes|walmart|bestbuy|target\.com|scene7|acmetools|northerntool|tractorsupply|costco|bhphotovideo|newegg|crutchfield|wayfair|ebayimg)/i;

export async function fetchRetailImages(channel: string, product: string, category: string, want: number, log: (m: string) => void): Promise<number> {
  if (env("RETAIL_IMAGES", "on").toLowerCase() === "off") return 0;
  const py = venvPythonPath();
  const script = path.join(paths.python, "product_web.py");
  if (!py || !fs.existsSync(script)) return 0;
  const dir = path.join(paths.channels, channel, "presskit", slug(product));
  fs.mkdirSync(dir, { recursive: true });
  const have = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
  if (have >= want) return 0;
  const brand = product.split(/\s+/)[0].toLowerCase();
  const modelWords = product.toLowerCase().split(/\s+/).slice(1).filter((w) => w.length > 1);
  const seen = new Set<string>();
  let saved = 0;
  for (const q of [`${product} ${category}`.trim(), `${product} official product photo`, `${product} amazon`]) {
    if (have + saved >= want + 4) break; // a few spare: some will fail the exact-model check
    const r = await run(py, [script, "images", q, "40"], { timeoutMs: 60_000 });
    let j: { ok: boolean; error?: string; images?: { url: string; width: number; height: number; source: string; title: string; provider?: string }[] };
    try {
      j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}");
    } catch {
      j = { ok: false, error: r.stderr.slice(-160) };
    }
    if (!j.ok) {
      log(`[retail] ${product}: image search skipped (${String(j.error ?? "no result").slice(0, 120)})`);
      return saved;
    }
    const imgs = (j.images ?? [])
      .filter((x) => x.url && (!x.width || Math.max(x.width, x.height) >= 700)) // Bing gives no size: the 30 KB file check below guards
      // Retailer / brand hosts, Amazon gallery images and Google/Bing image results that name the
      // model; every saved photo still has to pass the timeline's exact-model vision check.
      .filter((x) => RETAIL.test(x.url + " " + x.source) || (x.source + x.url).toLowerCase().includes(brand) || x.provider === "amazon" || ((x.provider === "google" || x.provider === "bing") && modelWords.every((w) => (x.title + " " + x.url + " " + x.source).toLowerCase().includes(w))))
      .sort((a, b) => Number(b.source.toLowerCase().includes(brand)) - Number(a.source.toLowerCase().includes(brand)) || b.width * b.height - a.width * a.height);
    for (const im of imgs) {
      if (have + saved >= want + 4) break;
      if (seen.has(im.url)) continue;
      seen.add(im.url);
      try {
        const res = await fetch(im.url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(20_000) });
        const type = res.headers.get("content-type") ?? "";
        if (!res.ok || !/image\/(jpeg|png|webp)/.test(type)) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 30_000) continue;
        const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
        const file = path.join(dir, `retail_${crypto.createHash("sha1").update(im.url).digest("hex").slice(0, 10)}.${ext}`);
        fs.writeFileSync(file, buf);
        // Source log (original image URL, page/site, query) so every retail photo can be traced.
        const logFile = path.join(dir, "retail_sources.json");
        const srcLog: Record<string, unknown> = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : {};
        srcLog[path.basename(file)] = { url: im.url, provider: im.provider ?? "duckduckgo", source: im.source, title: im.title, query: q, width: im.width, height: im.height, added: new Date().toISOString() };
        fs.writeFileSync(logFile, JSON.stringify(srcLog, null, 1));
        saved++;
      } catch { /* blocked image host: skip */ }
    }
  }
  log(`[retail] ${product}: ${saved} official/retailer image(s) saved for the exact-model check`);
  return saved;
}

/** Product videos from Amazon and Google/Bing video search (python/product_web.py "videos"). Best-effort, [] on failure. */
export async function productWebVideos(query: string, log: (m: string) => void): Promise<{ url: string; title: string; provider: string; page: string }[]> {
  const py = venvPythonPath();
  const script = path.join(paths.python, "product_web.py");
  if (!py || !fs.existsSync(script)) return [];
  const r = await run(py, [script, "videos", query, "20"], { timeoutMs: 90_000 }).catch(() => null);
  if (!r) return [];
  try {
    const j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}") as { ok: boolean; videos?: { url: string; title: string; provider: string; page: string }[]; errors?: string[] };
    if (j.errors?.length) log(`[web_videos] "${query}": ${j.errors.join(" | ").slice(0, 200)}`);
    // Amazon first, then non-YouTube pages, then YouTube (the YouTube search covers those already).
    const rank = (v: { url: string; provider: string }) => (v.provider === "amazon" ? 0 : /youtube\.com|youtu\.be/.test(v.url) ? 2 : 1);
    return (j.videos ?? []).sort((a, b) => rank(a) - rank(b));
  } catch {
    return [];
  }
}
