import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Assets } from "../lib/assets/types.js";
import { findVaultFor } from "../lib/agents/youtube/ytExtractor.js";
import { run } from "../lib/exec.js";
import { readJson } from "../lib/project.js";
import type { Scene } from "../lib/scenes.js";
import { ffmpegPath } from "../lib/tools.js";

/**
 * What the studio shows while a video is cooking, before there is a timeline to edit:
 *   - one card per planned scene (text, type, product), with a picture once its footage is chosen;
 *   - a live feed of the exact-model shots being harvested for this video's products.
 * Read straight from the step outputs (scenes.json, assets.json, the model vaults), so it fills in
 * as the pipeline writes them.
 */

export interface StoryScene {
  id: number;
  start: number;
  end: number;
  text: string;
  type: string;
  product: string | null;
  /** Thumbnail of the chosen footage (null until the footage step has picked it). */
  thumb: string | null;
  source: string | null;
}

export interface Storyboard {
  scenes: StoryScene[];
  /** Newest harvested shots first. */
  feed: { url: string; product: string; title: string }[];
  products: { name: string; clips: number }[];
}

const readIf = <T>(f: string): T | null => {
  try {
    return fs.existsSync(f) ? readJson<T>(f) : null;
  } catch {
    return null; // being written right now
  }
};

export function storyboard(project: string, dir: string, since: number): Storyboard {
  const scenes = readIf<Scene[]>(path.join(dir, "scenes.json")) ?? [];
  const assets = readIf<Assets>(path.join(dir, "assets.json")) ?? {};
  const q = encodeURIComponent(project);
  const products = [...new Set(scenes.map((s) => s.product_name).filter((p): p is string => !!p))];
  const feed: (Storyboard["feed"][number] & { at: number })[] = [];
  const counts: Storyboard["products"] = [];
  for (const name of products) {
    const v = findVaultFor(name);
    if (!v) {
      counts.push({ name, clips: 0 });
      continue;
    }
    counts.push({ name, clips: v.manifest.items.filter((i) => i.kind === "video").length });
    const vault = path.basename(v.dir);
    for (const i of v.manifest.items)
      if (i.kind === "image" && Date.parse(i.addedAt ?? "") >= since) feed.push({ url: `/api/vaults/${encodeURIComponent(vault)}/thumb/${encodeURIComponent(i.id)}`, product: name, title: i.title ?? "", at: Date.parse(i.addedAt ?? "") });
  }
  feed.sort((a, b) => b.at - a.at);
  return {
    scenes: scenes.map((s) => {
      const a = assets[String(s.id)];
      return {
        id: s.id,
        start: s.start,
        end: s.end,
        text: s.text,
        type: s.type,
        product: s.product_name ?? null,
        thumb: a && a.path && fs.existsSync(a.path) ? `/api/projects/${q}/storyboard/thumb?scene=${s.id}` : null,
        source: a?.source ?? null,
      };
    }),
    feed: feed.slice(0, 24).map(({ at: _at, ...f }) => f),
    products: counts,
  };
}

/** Small JPEG of a scene's chosen footage (cached under cache/story_thumbs). */
export async function storyThumb(dir: string, sceneId: number): Promise<string | null> {
  const assets = readIf<Assets>(path.join(dir, "assets.json")) ?? {};
  const a = assets[String(sceneId)];
  const ff = ffmpegPath();
  if (!a?.path || !fs.existsSync(a.path) || !ff) return null;
  const at = a.kind === "video" ? (a.in ?? 0) + 0.4 : 0;
  const st = fs.statSync(a.path);
  const key = crypto.createHash("sha1").update(`${path.resolve(a.path)}|${st.mtimeMs}|${at.toFixed(2)}`).digest("hex").slice(0, 16);
  const outDir = path.join(dir, "cache", "story_thumbs");
  const out = path.join(outDir, `${key}.jpg`);
  if (fs.existsSync(out)) return out;
  fs.mkdirSync(outDir, { recursive: true });
  const r = await run(ff, ["-v", "error", "-y", ...(a.kind === "video" ? ["-ss", at.toFixed(2)] : []), "-i", a.path, "-frames:v", "1", "-vf", "scale=320:-2", "-q:v", "5", out], { timeoutMs: 60_000 });
  return r.code === 0 && fs.existsSync(out) ? out : null;
}
