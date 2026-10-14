import fs from "node:fs";
import path from "node:path";
import type { Scene } from "./scenes.js";
import type { Facts } from "./facts.js";
import { productOrder } from "./facts.js";

/**
 * Chapters: every product is one chapter (any niche). A chapter starts at the product's title /
 * rank card ("#2: Name") when there is one, else at the first scene about it, and ends where the
 * next chapter starts. Everything before the first product is "Intro". Pacing (faster cuts right
 * after a boundary), card placement and the YouTube chapter list all use <project>/chapters.json.
 */

export interface Chapter {
  index: number;
  title: string;
  start: number;
  end: number;
  product?: string;
  rank?: number;
  /** First scene id inside the chapter. */
  firstScene: number;
}

export function buildChapters(scenes: Scene[], facts: Facts | null): Chapter[] {
  if (!scenes.length) return [];
  const total = scenes[scenes.length - 1].end;
  const names = productOrder(scenes);
  const planned = new Set(names);
  for (const p of facts?.products ?? []) if (!names.includes(p.name) && scenes.some((s) => s.text.toLowerCase().includes(p.name.toLowerCase()))) names.push(p.name);
  const starts: { name: string; i: number }[] = [];
  for (const name of names) {
    const lc = name.toLowerCase();
    const first = scenes.findIndex((s) => s.product_name === name || (s.graphic && s.graphic.title.toLowerCase().includes(lc)) || (!planned.has(name) && s.text.toLowerCase().includes(lc)));
    if (first < 0) continue;
    // A title card right before the first scene (often without product_name) opens the chapter.
    let i = first;
    const prev = scenes[i - 1];
    if (prev?.graphic && ["title_card", "intro_card"].includes(prev.graphic.kind) && prev.graphic.title.toLowerCase().includes(lc)) i--;
    starts.push({ name, i });
  }
  starts.sort((a, b) => a.i - b.i);
  const uniq = starts.filter((s, k) => k === 0 || s.i > starts[k - 1].i);
  const out: Chapter[] = [];
  if (!uniq.length || uniq[0].i > 0) out.push({ index: 0, title: "Intro", start: 0, end: 0, firstScene: scenes[0].id });
  for (const s of uniq) {
    const f = facts?.products.find((p) => p.name === s.name);
    out.push({ index: out.length, title: s.name, start: scenes[s.i].start, end: 0, product: s.name, rank: f?.rank, firstScene: scenes[s.i].id });
  }
  if (out.length) out[0].start = 0;
  for (let k = 0; k < out.length; k++) out[k].end = k + 1 < out.length ? out[k + 1].start : total;
  return out;
}

const fmt = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(x).padStart(2, "0")}` : `${m}:${String(x).padStart(2, "0")}`;
};

/** YouTube chapter list: starts at 0:00, at least 3 chapters, each >= 10 s (YouTube's rules). */
export function youtubeChapters(ch: Chapter[]): string {
  const ok = ch.filter((c, k) => k === 0 || c.start - ch[k - 1].start >= 10);
  if (ok.length < 3) return "";
  return ok.map((c) => `${fmt(c.start)} ${c.rank !== undefined ? `#${c.rank} ` : ""}${c.title}`).join("\n");
}

export function writeChapters(dir: string, ch: Chapter[]): void {
  fs.writeFileSync(path.join(dir, "chapters.json"), JSON.stringify(ch, null, 1));
  const yt = youtubeChapters(ch);
  fs.mkdirSync(path.join(dir, "publish"), { recursive: true });
  fs.writeFileSync(path.join(dir, "publish", "chapters.txt"), (yt || ch.map((c) => `${fmt(c.start)} ${c.title}`).join("\n")) + "\n");
}

export function readChapters(dir: string): Chapter[] {
  const f = path.join(dir, "chapters.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Chapter[]) : [];
}
