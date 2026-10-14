import fs from "node:fs";
import path from "node:path";
import { run } from "./exec.js";
import { ffmpegPath } from "./tools.js";
import { paths } from "./paths.js";
import { readJson } from "./project.js";
import type { Scene } from "./scenes.js";
import type { Timeline } from "../commands/timeline.js";
import { readFacts, type ProductFacts } from "./facts.js";
import { readChapters, youtubeChapters } from "./chapters.js";

/**
 * Publish pack (any niche), written after QA to <project>/publish and copied to
 * output/<project>_publish: title.txt, description.txt (SEO: hook, product list with prices,
 * YouTube chapters, disclosure), tags.txt and 2-3 thumbnails (1280x720 JPEG): a sharp frame of a
 * product's own footage + a rank badge, the name and the price, in the channel's card colour.
 */

export interface PublishPack { title: string; description: string; tags: string[]; chapters: string; thumbnails: string[] }

const FONT = path.join(paths.root, "cards", "public", "fonts", "Anton-Regular.ttf");
const ffEsc = (p: string) => p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");

function titleOf(project: Record<string, unknown>, topic: string, n: number): string {
  if (typeof project.title === "string" && project.title.trim()) return project.title.trim();
  const t = topic ? topic.replace(/\b\w/g, (c) => c.toUpperCase()) : "Products Worth Your Money";
  return `${n ? `${n} ` : ""}Best ${t} (${new Date().getFullYear()})`.slice(0, 100);
}

async function thumb(ff: string, src: string, at: number, p: ProductFacts, idx: number, color: string, outDir: string, kicker: string): Promise<string | null> {
  const out = path.join(outDir, `thumbnail_${idx}.jpg`);
  const tf = (name: string, text: string) => {
    const f = path.join(outDir, `.t_${idx}_${name}.txt`);
    fs.writeFileSync(f, text);
    return ffEsc(f);
  };
  const font = ffEsc(FONT);
  const col = color.replace("#", "0x");
  const name = p.name.toUpperCase();
  const nameSize = Math.max(56, Math.min(104, Math.round(1100 / Math.max(8, name.length))));
  const vf = [
    "scale=1280:720:force_original_aspect_ratio=increase", "crop=1280:720", "eq=saturation=1.3:contrast=1.1",
    "drawbox=x=0:y=ih-300:w=iw:h=300:color=black@0.55:t=fill",
    ...(p.rank !== undefined ? [`drawtext=fontfile='${font}':textfile='${tf("rank", `#${p.rank}`)}':fontsize=190:fontcolor=black:box=1:boxcolor=${col}:boxborderw=24:x=60:y=50`] : []),
    `drawtext=fontfile='${font}':textfile='${tf("kick", kicker.toUpperCase())}':fontsize=44:fontcolor=${col}:x=60:y=h-290`,
    `drawtext=fontfile='${font}':textfile='${tf("name", name)}':fontsize=${nameSize}:fontcolor=white:borderw=4:bordercolor=black:x=60:y=h-235`,
    ...(p.price ? [`drawtext=fontfile='${font}':textfile='${tf("price", p.price)}':fontsize=96:fontcolor=black:box=1:boxcolor=${col}:boxborderw=16:x=w-tw-70:y=60`] : []),
  ].join(",");
  const isImg = /\.(jpe?g|png|webp)$/i.test(src);
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", ...(isImg ? [] : ["-ss", String(at)]), "-i", src, "-frames:v", "1", "-vf", vf, "-q:v", "3", out]);
  for (const f of fs.readdirSync(outDir)) if (f.startsWith(`.t_${idx}_`)) fs.rmSync(path.join(outDir, f), { force: true });
  return r.code === 0 && fs.existsSync(out) ? out : null;
}

/** Best own-footage frame of a product: a close-up / promo sub-shot in its chapter, else any. */
function frameFor(tl: Timeline, scenes: Scene[], product: string, start: number, end: number): { src: string; at: number } | null {
  const rank = (s?: string) => (s === "closeup" ? 0 : s === "promo" ? 1 : s === "handson" ? 2 : 3);
  const cands: { src: string; at: number; r: number }[] = [];
  for (const t of tl.scenes) {
    if (t.start < start || t.start >= end || t.backdrop) continue;
    for (const s of t.asset.shots ?? []) if ((s.product === product || scenes.find((x) => x.id === t.id)?.product_name === product) && s.kind === "video" && fs.existsSync(s.path)) cands.push({ src: s.path, at: s.in + Math.min(1, s.frames / 60), r: rank(s.shotType) });
  }
  cands.sort((a, b) => a.r - b.r);
  return cands[0] ?? null;
}

export async function buildPublishPack(dir: string, project: string, log: (m: string) => void): Promise<PublishPack | null> {
  const ff = ffmpegPath();
  const proj = readJson<Record<string, unknown>>(path.join(dir, "project.json"));
  const facts = readFacts(dir);
  const chapters = readChapters(dir);
  const scenes = readJson<Scene[]>(path.join(dir, "scenes.json"));
  const tl = readJson<Timeline>(path.join(dir, "timeline.json"));
  const style = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(paths.channels, String(proj.channel ?? "default"), "style.json"), "utf8").replace(/^\uFEFF/, ""));
    } catch {
      return {};
    }
  })();
  const color = style.cards?.primary ?? "#FFD60A";
  const products = facts?.products ?? [];
  const title = titleOf(proj, facts?.topic ?? "", products.length);
  const yt = youtubeChapters(chapters);
  const hook = scenes.slice(0, 3).map((s) => s.text).join(" ").replace(/\s+/g, " ").trim().slice(0, 220);
  const description = [
    hook + (hook.endsWith(".") ? "" : "..."),
    "",
    ...(products.length ? ["Products in this video:", ...products.map((p) => `${p.rank !== undefined ? `#${p.rank} ` : "- "}${p.name}${p.price ? ` (${p.price})` : ""} - [LINK]`), ""] : []),
    ...(yt ? ["Chapters:", yt, ""] : []),
    "Prices are as stated at recording time and can change.",
    "Some links may be affiliate links: I may earn a small commission at no extra cost to you.",
    "",
    `#${(facts?.topic ?? "review").split(/\s+/).slice(-2).join("")} #${products[0]?.name.replace(/[^A-Za-z0-9]/g, "") ?? "review"} #review`,
  ].join("\n");
  const tags = [...new Set([facts?.topic, ...products.map((p) => p.name), ...products.map((p) => `${p.name} review`), "best " + (facts?.topic ?? "")].filter((x): x is string => !!x && x.trim().length > 2))].slice(0, 15);

  const pub = path.join(dir, "publish");
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, "title.txt"), title + "\n");
  fs.writeFileSync(path.join(pub, "description.txt"), description + "\n");
  fs.writeFileSync(path.join(pub, "tags.txt"), tags.join(", ") + "\n");

  const thumbs: string[] = [];
  if (ff && fs.existsSync(FONT)) {
    const chs = chapters.filter((c) => c.product);
    // Order: the top pick (#1 or the last presented), the first presented, then another one.
    const order = [...chs].sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99));
    const picks = [...new Set([order[0], chs[0], chs[Math.floor(chs.length / 2)], chs[chs.length - 1]].filter(Boolean))].slice(0, 3);
    for (const [k, c] of picks.entries()) {
      const p = products.find((x) => x.name === c.product) ?? { name: c.product!, rank: c.rank, specs: [], pros: [], cons: [] };
      const fr = frameFor(tl, scenes, c.product!, c.start, c.end);
      if (!fr) continue;
      const kicker = k === 0 ? (facts?.topic || "Top pick") : p.price ? "Worth it?" : "Watch before you buy";
      const t = await thumb(ff, fr.src, fr.at, p, k + 1, color, pub, kicker);
      if (t) thumbs.push(t);
    }
  }
  const outDir = path.join(paths.output, `${project}_publish`);
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of fs.readdirSync(pub)) fs.copyFileSync(path.join(pub, f), path.join(outDir, f));
  const pack: PublishPack = { title, description, tags, chapters: yt, thumbnails: thumbs.map((t) => path.basename(t)) };
  fs.writeFileSync(path.join(pub, "publish.json"), JSON.stringify(pack, null, 1));
  fs.copyFileSync(path.join(pub, "publish.json"), path.join(outDir, "publish.json"));
  log(`[publish] title, description, ${thumbs.length} thumbnail(s) -> ${outDir}`);
  return pack;
}
