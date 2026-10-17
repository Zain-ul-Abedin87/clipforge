import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { slug, USER_AGENT } from "./presskit.js";
import Anthropic from "@anthropic-ai/sdk";
import { agentEnabled, agentModel } from "../agent/footage.js";
import { llm } from "../agents/llm/llm.js";

/**
 * Haiku: the most specific shopping category the TEXT supports (this product's narration + official
 * page title), plus likely official page URLs. Cached per product in <project>/product_categories.json
 * so every step of the plan uses the same category.
 */
export async function haikuHints(projectDir: string, product: string, nicheCategory: string, context: string, officialTitle: string, log: (m: string) => void): Promise<{ category: string; urls: string[] }> {
  const cacheF = path.join(projectDir, "product_categories.json");
  const cache: Record<string, { category: string; urls: string[] }> = fs.existsSync(cacheF) ? JSON.parse(fs.readFileSync(cacheF, "utf8")) : {};
  if (cache[product]?.category) return cache[product];
  const fb = { category: nicheCategory, urls: [] as string[] };
  if (!agentEnabled()) return fb;
  try {
    const res = await llm().messages.create({
      model: agentModel(),
      max_tokens: 400,
      system: 'You classify one product for retail search. Use ONLY what the given narration and official page title support; do not guess a sub-type the text does not state. Give the most specific category the text supports (2-4 words, e.g. "walk-behind lawn mower", "wireless earbuds"); if the text only supports a general type, give that general type (e.g. "lawn mower"). Reply with ONLY JSON: {"category": "...", "evidence": "<short quote from the text>", "urls": ["<up to 5 likely official manufacturer product-page URLs for this exact model>"]}',
      messages: [{ role: "user", content: JSON.stringify({ product, niche_category: nicheCategory, narration: context.slice(0, 3000), official_page_title: officialTitle || null }) }],
    });
    const txt = res.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    const j = JSON.parse(txt.slice(txt.indexOf("{"), txt.lastIndexOf("}") + 1));
    const out = { category: String(j.category || nicheCategory).trim().toLowerCase(), urls: (j.urls ?? []).filter((u: string) => /^https?:\/\//.test(u)).slice(0, 5) };
    log(`[browser] ${product}: category "${out.category}" (evidence: ${String(j.evidence ?? "").slice(0, 80)})`);
    cache[product] = out;
    fs.writeFileSync(cacheF, JSON.stringify(cache, null, 1));
    return out;
  } catch (err) {
    log(`[browser] ${product}: Haiku hints failed (${String(err).slice(0, 80)})`);
    return fb;
  }
}

export interface BrowserResult { videos: string[]; summary: string }

export async function browserProduct(channel: string, projectDir: string, product: string, category: string, log: (m: string) => void, context = ""): Promise<BrowserResult> {
  const none = { videos: [], summary: "off" };
  if (env("PRODUCT_BROWSER", "on").toLowerCase() === "off") return none;
  const script = path.join(paths.root, "scripts", "product_browser.mjs");
  if (!fs.existsSync(script)) return none;
  const cacheF = path.join(projectDir, "browser_product.json");
  const cache: Record<string, any> = fs.existsSync(cacheF) ? JSON.parse(fs.readFileSync(cacheF, "utf8")) : {};
  let j = cache[product];
  // Re-run when the cached attempt found neither an Amazon listing nor an official page.
  if (!j || !j.ok || (!j.amazon?.exactModel && !j.official?.url)) {
    const hints = await haikuHints(projectDir, product, category, context, String(j?.official?.title ?? j?.official?.name ?? ""), log);
    log(`[browser] ${product}: category "${hints.category}", ${hints.urls.length} Haiku URL guess(es)`);
    const r = await run(process.execPath, [script, product, hints.category, JSON.stringify(hints.urls)], { timeoutMs: 420_000 });
    try { j = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? "{}"); } catch { j = { ok: false, error: r.stderr.slice(-200) }; }
    j.at = new Date().toISOString();
    cache[product] = j;
    fs.writeFileSync(cacheF, JSON.stringify(cache, null, 1));
  }
  if (!j.ok) {
    log(`[browser] ${product}: failed (${String(j.error).slice(0, 160)})`);
    return { videos: [], summary: "failed" };
  }
  const dir = path.join(paths.channels, channel, "presskit", slug(product));
  fs.mkdirSync(dir, { recursive: true });
  const logFile = path.join(dir, "retail_sources.json");
  const srcLog: Record<string, unknown> = fs.existsSync(logFile) ? JSON.parse(fs.readFileSync(logFile, "utf8")) : {};
  const counts: Record<string, number> = {};
  const save = async (url: string, provider: string, page: string, title: string): Promise<void> => {
    const file0 = `${provider}_${crypto.createHash("sha1").update(url).digest("hex").slice(0, 10)}`;
    if (fs.readdirSync(dir).some((f) => f.startsWith(file0))) return void (counts[provider] = (counts[provider] ?? 0) + 1);
    try {
      const res = await fetch(url, { headers: { "user-agent": USER_AGENT, referer: page }, signal: AbortSignal.timeout(20_000) });
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !/image\/(jpeg|png|webp)/.test(type)) return;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 25_000) return; // icons/thumbnails
      const file = `${file0}.${type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg"}`;
      fs.writeFileSync(path.join(dir, file), buf);
      srcLog[file] = { url, provider: `${provider} (headless browser)`, source: page, title, added: new Date().toISOString() };
      counts[provider] = (counts[provider] ?? 0) + 1;
    } catch { /* host refused */ }
  };
  const a = j.amazon, o = j.official;
  // Only pages whose title names the exact model contribute (the vision check runs again later).
  if (a?.exactModel && !a.blocked) for (const u of a.images ?? []) await save(u, "amazon", a.url, a.title);
  if (o?.url && o.exactModel !== false) for (const u of (o.images ?? []).slice(0, 20)) await save(u, "official", o.url, o.name || o.title);
  fs.writeFileSync(logFile, JSON.stringify(srcLog, null, 1));
  // Specs -> facts.json (products[].webSpecs, with source); the script's own facts stay untouched.
  const webSpecs = [
    ...(a?.exactModel ? (a.specs ?? []).map((s: any) => ({ ...s, source: a.url })) : []),
    ...(a?.exactModel ? (a.bullets ?? []).slice(0, 6).map((b: string) => ({ label: "feature", value: b.slice(0, 160), source: a.url })) : []),
    ...(o?.exactModel ? (o.specs ?? []).map((s: any) => ({ ...s, source: o.url })) : []),
  ];
  const factsF = path.join(projectDir, "facts.json");
  if (fs.existsSync(factsF) && (webSpecs.length || a?.price)) {
    const fj = JSON.parse(fs.readFileSync(factsF, "utf8"));
    const p = (fj.facts?.products ?? fj.products ?? []).find((x: any) => String(x.name).toLowerCase() === product.toLowerCase());
    if (p) {
      p.webSpecs = webSpecs;
      if (a?.exactModel && a.price) p.webPrice = { value: a.price, source: a.url };
      fs.writeFileSync(factsF, JSON.stringify(fj, null, 2));
    }
  }
  const videos = [...new Set([...(a?.exactModel ? a.videos ?? [] : []), ...(o?.exactModel !== false ? o?.videos ?? [] : [])])].filter((v) => /^https?:/.test(v));
  const summary = `amazon: ${a ? (a.blocked ? "captcha" : a.exactModel ? `"${String(a.title).slice(0, 60)}" ${a.price || "no price"}, ${a.images?.length ?? 0} img, ${a.videos?.length ?? 0} vid, ${(a.specs?.length ?? 0) + (a.bullets?.length ?? 0)} spec/bullets` : `no exact model (${a.note ?? a.title ?? ""})`) : "error"}; saved ${counts.amazon ?? 0}`
    + ` | official: ${o?.url ? `${o.url} exact=${o.exactModel}, ${o.images?.length ?? 0} img, ${o.videos?.length ?? 0} vid, ${o.specs?.length ?? 0} specs` : o?.note ?? "none"}; saved ${counts.official ?? 0}`
    + (j.errors?.length ? ` | errors: ${j.errors.join("; ").slice(0, 200)}` : "");
  log(`[browser] ${product}: ${summary}`);
  return { videos, summary };
}
