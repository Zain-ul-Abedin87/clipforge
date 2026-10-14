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
  const script = path.join(paths.python, "retail_images.py");
  if (!py || !fs.existsSync(script)) return 0;
  const dir = path.join(paths.channels, channel, "presskit", slug(product));
  fs.mkdirSync(dir, { recursive: true });
  const have = fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).length;
  if (have >= want) return 0;
  const brand = product.split(/\s+/)[0].toLowerCase();
  const seen = new Set<string>();
  let saved = 0;
  for (const q of [`${product} ${category}`.trim(), `${product} official product photo`, `${product} amazon`]) {
    if (have + saved >= want + 4) break; // a few spare: some will fail the exact-model check
    const r = await run(py, [script, q, "40"], { timeoutMs: 60_000 });
    let j: { ok: boolean; error?: string; images?: { url: string; width: number; height: number; source: string; title: string }[] };
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
      .filter((x) => x.url && Math.max(x.width, x.height) >= 700)
      .filter((x) => RETAIL.test(x.url + " " + x.source) || (x.source + x.url).toLowerCase().includes(brand))
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
        saved++;
      } catch { /* blocked image host: skip */ }
    }
  }
  log(`[retail] ${product}: ${saved} official/retailer image(s) saved for the exact-model check`);
  return saved;
}
