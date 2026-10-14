import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import type { Layer } from "../assets/graphics.js";
import type { TimelineScene } from "../../commands/timeline.js";

/**
 * Animated cards from the Remotion sub-project in cards/ (rank, price, spec, lower third). All
 * cards of a video are rendered in one batch (one bundle) to ProRes 4444 with alpha and cached in
 * cache/cards by a hash of the card, its props, its length and the cards/ source. A layer whose
 * card rendered becomes a video layer (render.ts overlays it with eof_action=pass); when Remotion
 * is missing or a card fails, the layer keeps its drawtext PNG (the old look).
 * CARDS=off keeps the drawtext cards.
 */

const CARDS_DIR = path.join(paths.root, "cards");
const CACHE = path.join(paths.root, "cache", "cards");
const FPS = 30;

export const remotionCardsAvailable = () =>
  env("CARDS", "on").toLowerCase() !== "off" && fs.existsSync(path.join(CARDS_DIR, "node_modules", "@remotion", "renderer")) && fs.existsSync(path.join(CARDS_DIR, "render.mjs"));

function sourceHash(): string {
  const h = crypto.createHash("sha1");
  for (const f of ["src/Cards.tsx", "src/Root.tsx", "render.mjs"]) {
    const p = path.join(CARDS_DIR, f);
    if (fs.existsSync(p)) h.update(fs.readFileSync(p));
  }
  return h.digest("hex").slice(0, 8);
}

/** Card length: until the layer's own fade-out, else to the end of the scene (2-6 s). */
function cardFrames(l: Layer, sceneDur: number): number {
  const secs = l.card?.seconds ?? (l.out !== undefined ? l.out - l.delay + 0.3 : sceneDur - l.delay);
  return Math.max(30, Math.min(6 * FPS, Math.round(secs * FPS)));
}

export async function applyRemotionCards(tl: TimelineScene[], log: (m: string) => void): Promise<void> {
  const want: { l: Layer; frames: number; file: string; key: string }[] = [];
  for (const t of tl) for (const l of t.overlays ?? []) if (l.card) {
    const frames = cardFrames(l, t.end - t.start);
    want.push({ l, frames, file: "", key: "" });
  }
  if (!want.length) return;
  if (!remotionCardsAvailable()) {
    log(`[cards] Remotion cards off or not installed (cards/node_modules missing): ${want.length} card(s) stay drawtext`);
    return;
  }
  const src = sourceHash();
  fs.mkdirSync(CACHE, { recursive: true });
  for (const w of want) {
    w.key = crypto.createHash("sha1").update(JSON.stringify({ c: w.l.card!.comp, p: w.l.card!.props, f: w.frames, src })).digest("hex").slice(0, 16);
    w.file = path.join(CACHE, `${w.l.card!.comp}_${w.key}.mov`);
  }
  const jobs = [...new Map(want.filter((w) => !fs.existsSync(w.file)).map((w) => [w.key, { id: w.l.card!.comp, props: w.l.card!.props, frames: w.frames, out: w.file }])).values()];
  if (jobs.length) {
    const t0 = Date.now();
    const jobFile = path.join(CACHE, `jobs_${process.pid}.json`);
    fs.writeFileSync(jobFile, JSON.stringify(jobs));
    const r = await run(process.execPath, [path.join(CARDS_DIR, "render.mjs"), jobFile], { timeoutMs: 30 * 60_000 });
    fs.rmSync(jobFile, { force: true });
    const failed = r.stdout.split("\n").filter((x) => x.includes('"error"')).length;
    log(`[cards] Remotion rendered ${jobs.length - failed}/${jobs.length} card(s) in ${Math.round((Date.now() - t0) / 1000)} s${r.code !== 0 ? ` (exit ${r.code}: ${r.stderr.trim().split("\n").pop()?.slice(0, 160)})` : ""}`);
  }
  let used = 0;
  for (const w of want) {
    if (!fs.existsSync(w.file) || fs.statSync(w.file).size < 1000) continue;
    w.l.path = w.file;
    w.l.video = true;
    used++;
  }
  log(`[cards] ${used}/${want.length} card(s) are animated Remotion cards (cached ${want.length - jobs.length}), ${want.length - used} drawtext fallback`);
  // Old cards nobody used for 14 days: ProRes files are 10-20 MB each.
  const cutoff = Date.now() - 14 * 86400_000;
  for (const f of fs.readdirSync(CACHE)) {
    const p = path.join(CACHE, f);
    if (f.endsWith(".mov") && fs.statSync(p).atimeMs < cutoff && fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
  }
}
