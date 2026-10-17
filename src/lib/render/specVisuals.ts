import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { env, hasKey } from "../env.js";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { ffprobePath } from "../tools.js";
import type { Facts, ProductFacts, Spec } from "../facts.js";
import { numOf } from "../facts.js";
import type { SubShot } from "../pacing.js";
import { llm, llmAvailable } from "../agents/llm/llm.js";

/**
 * Spec visuals (any niche), values only from facts.json (script / official / retailer specs):
 *  - GaugeCard for numeric specs ("163 cc", "21 in", "5000 mAh"): needle sweep + optional bars
 *    comparing the same spec across the video's products.
 *  - PartCallout for named parts ("Deck: 14-gauge steel"): Haiku vision finds the part's bounding
 *    box on a verified product photo (cached in <project>/callout_boxes.json); the card zooms to it.
 *    Not found -> the caller falls back to a plain SpecCard row.
 *  - PhotoParallax: verified product stills in the pacing timeline become 2.5D parallax clips with
 *    a light sweep (rendered by cards/render.mjs, cached in cache/cards).
 */

const CARDS_DIR = path.join(paths.root, "cards");
const PUB = path.join(CARDS_DIR, "public", "callout");

export interface GaugeSpec { label: string; value: string; pct: number; compare?: { name: string; value: string; pct: number; me?: boolean }[] }
export interface CalloutSpec { label: string; value: string; photo?: string; box?: { x: number; y: number; w: number; h: number }; aspect?: number }
export interface ProductVisuals { gauges: GaugeSpec[]; callouts: CalloutSpec[] }

/** "163 cc", "$399", "21 in", "6.5 hp", "5,000 mAh", "48 inches" - a number with a short unit. */
export const isNumericSpec = (v: string) => /^\s*[~≈]?\s*\$?\d[\d,]*(\.\d+)?\s*[a-zA-Z%"”'°/.]{0,8}\s*$/.test(v) && numOf(v) !== null;

/** Copies a photo into cards/public/callout under a content hash; returns the staticFile path. */
export function publishPhoto(file: string): string {
  fs.mkdirSync(PUB, { recursive: true });
  const h = crypto.createHash("sha1").update(fs.readFileSync(file)).digest("hex").slice(0, 12);
  const name = `${h}${path.extname(file).toLowerCase() || ".jpg"}`;
  const dst = path.join(PUB, name);
  if (!fs.existsSync(dst)) fs.copyFileSync(file, dst);
  return `callout/${name}`;
}

export async function imageAspect(file: string): Promise<number> {
  const fp = ffprobePath();
  if (!fp) return 1.5;
  const r = await run(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file]).catch(() => null);
  const [w, h] = (r?.stdout.trim() ?? "").split(",").map(Number);
  return w > 0 && h > 0 ? w / h : 1.5;
}

const BoxSchema = z.object({ found: z.boolean(), x: z.number(), y: z.number(), w: z.number(), h: z.number(), reason: z.string() });
const mime = (f: string) => (/\.png$/i.test(f) ? "image/png" : /\.webp$/i.test(f) ? "image/webp" : "image/jpeg");

async function partBox(dir: string, product: string, spec: Spec, photo: string, log: (m: string) => void): Promise<{ x: number; y: number; w: number; h: number } | null> {
  const cacheF = path.join(dir, "callout_boxes.json");
  const cache: Record<string, { found: boolean; box?: { x: number; y: number; w: number; h: number } }> = fs.existsSync(cacheF) ? JSON.parse(fs.readFileSync(cacheF, "utf8")) : {};
  const key = crypto.createHash("sha1").update(`${product}|${spec.label}|${spec.value}|${fs.statSync(photo).size}|${path.basename(photo)}|v1`).digest("hex").slice(0, 16);
  if (cache[key]) return cache[key].found ? cache[key].box ?? null : null;
  if (!llmAvailable()) return null;
  let out: { found: boolean; box?: { x: number; y: number; w: number; h: number } } = { found: false };
  try {
    const model = env("CALLOUT_MODEL", "claude-haiku-4-5");
    const res = await llm().messages.parse({
      model,
      max_tokens: 300,
      output_config: { format: zodOutputFormat(BoxSchema) },
      system: "You locate one physical part of a product in a photo. Return found=true only if that part is clearly visible; then x,y,w,h = its bounding box as fractions of the image width/height (0-1, x,y = top-left). If the spec is not a visible physical part (e.g. a warranty, a weight, a material you cannot point at) or it is hidden, found=false. reason: max 10 words.",
      messages: [{ role: "user", content: [
        { type: "image", source: { type: "base64", media_type: mime(photo), data: fs.readFileSync(photo).toString("base64") } },
        { type: "text", text: `Product: ${product}. Part / spec: "${spec.label}: ${spec.value}". Where is the ${spec.label.toLowerCase()} in this photo?` },
      ] }],
    });
    const b = res.parsed_output;
    if (b?.found && b.w > 0.02 && b.h > 0.02 && b.x >= 0 && b.y >= 0 && b.x + b.w <= 1.05 && b.y + b.h <= 1.05) out = { found: true, box: { x: b.x, y: b.y, w: Math.min(b.w, 1 - b.x), h: Math.min(b.h, 1 - b.y) } };
    log(`[callout] ${product} / ${spec.label}: ${out.found ? "found" : "not found"} (${b?.reason ?? "-"})`);
  } catch (err) {
    log(`[callout] ${product} / ${spec.label}: vision failed (${String((err as Error).message ?? err).slice(0, 100)})`);
    return null;
  }
  cache[key] = out;
  fs.writeFileSync(cacheF, JSON.stringify(cache, null, 1));
  return out.found ? out.box ?? null : null;
}

export async function prepareSpecVisuals(dir: string, facts: Facts | null, photosOf: (p: string) => string[], log: (m: string) => void): Promise<Map<string, ProductVisuals>> {
  const outMap = new Map<string, ProductVisuals>();
  if (!facts?.products.length || env("SPEC_VISUALS", "on").toLowerCase() === "off") return outMap;
  for (const p of facts.products) {
    const v: ProductVisuals = { gauges: [], callouts: [] };
    for (const s of p.specs) {
      if (isNumericSpec(s.value)) {
        const n = numOf(s.value)!;
        const peers = facts.products
          .map((q: ProductFacts) => ({ q, sp: q.specs.find((x) => x.label.toLowerCase() === s.label.toLowerCase()) }))
          .filter((x) => x.sp && isNumericSpec(x.sp.value))
          .map((x) => ({ name: x.q.name, value: x.sp!.value, n: numOf(x.sp!.value)! }));
        const max = Math.max(n, ...peers.map((x) => x.n));
        v.gauges.push({
          label: s.label, value: s.value,
          // Without peers the needle stops at ~3/4 (no invented maximum is shown, only the value).
          pct: peers.length > 1 ? n / (max * 1.1) : 0.72,
          compare: peers.length > 1 ? peers.map((x) => ({ name: x.name, value: x.value, pct: x.n / max, me: x.name === p.name })) : undefined,
        });
      } else {
        v.callouts.push({ label: s.label, value: s.value });
      }
    }
    // Locate up to 2 named parts on verified photos (largest photos first).
    const photos = photosOf(p.name).filter((f) => fs.existsSync(f)).sort((a, b) => fs.statSync(b).size - fs.statSync(a).size).slice(0, 3);
    let located = 0;
    for (const c of v.callouts) {
      if (located >= 2) break;
      for (const ph of photos) {
        const box = await partBox(dir, p.name, c, ph, log);
        if (box) {
          c.photo = publishPhoto(ph);
          c.box = box;
          c.aspect = await imageAspect(ph);
          located++;
          break;
        }
      }
    }
    log(`[spec-visuals] ${p.name}: ${v.gauges.length} gauge(s) [${v.gauges.map((g) => g.label).join(", ")}], ${located}/${v.callouts.length} part callout(s) located`);
    outMap.set(p.name.toLowerCase(), v);
  }
  return outMap;
}

/** Turns verified product stills in the pacing timeline into 2.5D parallax clips (Remotion). */
export async function parallaxStills(tl: { asset: { shots?: SubShot[] } }[], log: (m: string) => void): Promise<number> {
  if (env("PHOTO_PARALLAX", "on").toLowerCase() === "off") return 0;
  if (!fs.existsSync(path.join(CARDS_DIR, "node_modules", "@remotion", "renderer"))) return 0;
  const shots = tl.flatMap((t) => t.asset.shots ?? []).filter((x) => x.kind === "image" && x.verified && x.product && fs.existsSync(x.path));
  if (!shots.length) return 0;
  const cache = path.join(paths.root, "cache", "cards");
  fs.mkdirSync(cache, { recursive: true });
  const src = crypto.createHash("sha1").update(fs.readFileSync(path.join(CARDS_DIR, "src", "Cards.tsx"))).digest("hex").slice(0, 8);
  const jobs: { id: string; props: Record<string, unknown>; frames: number; out: string }[] = [];
  const outOf = new Map<SubShot, string>();
  for (const x of shots) {
    const photo = publishPhoto(x.path);
    const props = { photo, aspect: await imageAspect(x.path) };
    const frames = Math.max(15, x.frames);
    const key = crypto.createHash("sha1").update(JSON.stringify({ props, frames, src })).digest("hex").slice(0, 16);
    const out = path.join(cache, `PhotoParallax_${key}.mov`);
    outOf.set(x, out);
    if (!fs.existsSync(out) && !jobs.some((j) => j.out === out)) jobs.push({ id: "PhotoParallax", props, frames, out });
  }
  if (jobs.length) {
    const jobFile = path.join(cache, `jobs_parallax_${process.pid}.json`);
    fs.writeFileSync(jobFile, JSON.stringify(jobs));
    const t0 = Date.now();
    await run(process.execPath, [path.join(CARDS_DIR, "render.mjs"), jobFile], { timeoutMs: 30 * 60_000 }).catch(() => null);
    fs.rmSync(jobFile, { force: true });
    log(`[parallax] rendered ${jobs.length} 2.5D photo clip(s) in ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  let n = 0;
  for (const [x, out] of outOf) {
    if (!fs.existsSync(out) || fs.statSync(out).size < 1000) continue;
    x.path = out;
    x.kind = "video";
    x.in = 0;
    n++;
  }
  log(`[parallax] ${n}/${shots.length} verified product still(s) shown as 2.5D parallax + light sweep`);
  return n;
}
