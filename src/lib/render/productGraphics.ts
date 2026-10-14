import type { Layer } from "../assets/graphics.js";
import type { TimelineScene } from "../../commands/timeline.js";
import type { Scene } from "../scenes.js";
import type { Chapter } from "../chapters.js";
import type { Facts, ProductFacts } from "../facts.js";
import { numOf } from "../facts.js";
import type { CardComp, CardPreset } from "../stylePreset.js";
import { themeOf } from "../stylePreset.js";

/**
 * More motion graphics per product chapter (any niche): spec bars, pros/cons, price tag, and one
 * comparison table across products near the end of the last product chapter. Rules:
 * - a graphic every ~graphicsEverySec (style preset, default 25 s) inside each product chapter,
 *   the first one >= 8 s after the chapter starts (the lower third / rank card own the opening);
 * - only on footage scenes (no card backdrops), >= 3.2 s long, with no other card or spec chip
 *   overlapping, and never within 2 s of another card;
 * - values come from facts.json (script extraction); a graphic with no data is skipped.
 * Placed graphics are Remotion cards (rendered + cached by applyRemotionCards); with Remotion
 * missing they are dropped (they have no drawtext version).
 */

type Busy = { a: number; b: number }[];

function busyOf(tl: TimelineScene[]): Busy {
  const out: Busy = [];
  for (const t of tl) {
    if (t.backdrop || t.asset.source === "graphic") out.push({ a: t.start, b: t.end });
    for (const l of t.overlays ?? []) {
      if (l.anim === "fade" && !l.card) continue; // corner rank badge
      out.push({ a: t.start + l.delay, b: t.start + (l.out ?? t.end - t.start) });
    }
  }
  return out;
}
const free = (busy: Busy, a: number, b: number, gap = 2) => !busy.some((x) => a < x.b + gap && b > x.a - gap);

function specRows(p: ProductFacts, all: ProductFacts[]) {
  return p.specs.slice(0, 5).map((s) => {
    const n = numOf(s.value);
    const peers = all.map((q) => q.specs.find((x) => x.label.toLowerCase() === s.label.toLowerCase())).filter(Boolean).map((x) => numOf(x!.value)).filter((x): x is number => x !== null);
    const max = Math.max(...peers, n ?? 0);
    return { label: s.label, value: s.value, pct: n !== null && max > 0 ? (peers.length > 1 ? n / max : 0.75) : 0.6 };
  });
}

export function compareRows(products: ProductFacts[]): { label: string; values: string[] }[] {
  const rows: { label: string; values: string[] }[] = [];
  if (products.some((p) => p.price)) rows.push({ label: "Price", values: products.map((p) => p.price ?? "-") });
  const labels = new Map<string, number>();
  for (const p of products) for (const s of p.specs) labels.set(s.label.toLowerCase(), (labels.get(s.label.toLowerCase()) ?? 0) + 1);
  const shared = [...labels.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([l]) => l);
  for (const l of shared.slice(0, 5)) {
    const label = products.flatMap((p) => p.specs).find((s) => s.label.toLowerCase() === l)!.label;
    rows.push({ label, values: products.map((p) => p.specs.find((s) => s.label.toLowerCase() === l)?.value ?? "-") });
  }
  return rows;
}

export function placeChapterGraphics(tl: TimelineScene[], scenes: Scene[], chapters: Chapter[], facts: Facts | null, preset: CardPreset, png: string, log: (m: string) => void): number {
  if (!facts?.products.length) {
    log("[graphics] no facts: extra product graphics skipped");
    return 0;
  }
  const busy = busyOf(tl);
  const theme = preset.custom ? themeOf(preset) : undefined;
  const isFootage = (i: number) => scenes[i]?.type !== "graphic" && !tl[i].backdrop && tl[i].asset.source !== "graphic";
  let added = 0;
  const place = (fromT: number, toT: number, comp: CardComp, props: Record<string, unknown>, secs: number): number | null => {
    for (const [i, t] of tl.entries()) {
      if (t.start < fromT || t.start > toT || !isFootage(i)) continue;
      const dur = t.end - t.start;
      if (dur < 3.2) continue;
      const delay = 0.25, out = Math.min(dur - 0.15, delay + secs);
      if (!free(busy, t.start + delay, t.start + out)) continue;
      const layer: Layer = { path: png, delay, anim: "fade", out, card: { comp, props: theme ? { ...props, theme } : props, seconds: out - delay } };
      (t.overlays ??= []).push(layer);
      (t.sfx ??= []).push({ kind: "whoosh", at: delay });
      busy.push({ a: t.start + delay, b: t.start + out });
      added++;
      return t.start;
    }
    return null;
  };
  const hasComp = (c: Chapter, comp: string) => tl.some((t) => t.start >= c.start && t.start < c.end && (t.overlays ?? []).some((l) => l.card?.comp === comp));
  const priceShown = (c: Chapter) => tl.some((t) => t.start >= c.start && t.start < c.end && (t.overlays ?? []).some((l) => l.card?.comp === "PriceCard" || l.card?.comp === "PriceTag"));
  const productChapters = chapters.filter((c) => c.product);
  for (const c of productChapters) {
    const f = facts.products.find((p) => p.name.toLowerCase() === c.product!.toLowerCase());
    if (!f) continue;
    const queue: { comp: CardComp; props: Record<string, unknown>; secs: number }[] = [];
    const bars = { comp: "SpecBars" as CardComp, props: { title: f.name, rows: specRows(f, facts.products) }, secs: 5 };
    // A chapter that already has a spec card gets the bars last (different info first).
    if (preset.set.has("SpecBars") && f.specs.length >= 2 && !hasComp(c, "SpecCard")) queue.push(bars);
    if (preset.set.has("PriceTag") && f.price && !priceShown(c)) queue.push({ comp: "PriceTag", props: { name: f.name, price: f.price, note: "" }, secs: 3.6 });
    if (preset.set.has("ProsCons") && f.pros.length + f.cons.length >= 2 && !hasComp(c, "ProsCons")) queue.push({ comp: "ProsCons", props: { title: f.name, pros: f.pros, cons: f.cons }, secs: 5.5 });
    if (preset.set.has("SpecBars") && f.specs.length >= 2 && hasComp(c, "SpecCard")) queue.push(bars);
    let t = c.start + 8;
    for (const q of queue) {
      if (t > c.end - 5) break;
      // First free footage scene at/after the slot; the next graphic comes ~graphicsEverySec later.
      const at = place(t, c.end - 4, q.comp, q.props, q.secs);
      if (at !== null) t = at + preset.graphicsEverySec;
    }
  }
  if (preset.set.has("CompareTable") && productChapters.length >= 2) {
    const ps = productChapters.map((c) => facts.products.find((p) => p.name.toLowerCase() === c.product!.toLowerCase())).filter((p): p is ProductFacts => !!p);
    const rows = compareRows(ps);
    const last = productChapters[productChapters.length - 1];
    if (rows.length >= 2) {
      const ok = null !== place(Math.max(last.start + 8, last.end - 25), last.end - 3, "CompareTable", { title: facts.topic || "Head to head", products: ps.map((p) => p.name), rows, highlight: ps.length - 1 }, 6) || null !== place(last.start + 6, last.end - 3, "CompareTable", { title: facts.topic || "Head to head", products: ps.map((p) => p.name), rows, highlight: ps.length - 1 }, 6);
      if (!ok) log("[graphics] comparison table: no free footage scene >= 3.2 s near the end");
    }
  }
  log(`[graphics] ${added} extra product graphic(s) placed (every ~${preset.graphicsEverySec} s per chapter)`);
  return added;
}
