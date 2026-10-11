import fs from "node:fs";
import path from "node:path";
import type { Asset, Assets } from "../lib/assets/types.js";
import { paths } from "../lib/paths.js";
import { fingerprint, isCached, markDone, projectDir, readJson, writeJson } from "../lib/project.js";
import type { Scene } from "../lib/scenes.js";
import { loadStyle } from "../lib/style.js";
import type { CaptionStyle } from "../lib/render/captions.js";
import { CardStyle, Layer, renderCardLayers, renderLowerThird, renderRankBadge } from "../lib/assets/graphics.js";
import type { Section } from "../lib/scenes.js";
import type { SfxKind } from "../lib/render/sfx.js";

export const FPS = 30;

export type Motion = "none" | "zoom_in" | "zoom_out" | "pan_left" | "pan_right";
export type Transition = "cut" | "fade" | "flash";

export interface TimelineScene {
  id: number;
  start: number;
  end: number;
  /** Frame-exact boundaries (cumulative rounding, so the total never drifts from the audio). */
  startFrame: number;
  endFrame: number;
  asset: Pick<Asset, "path" | "kind" | "source" | "duration" | "in">;
  motion: Motion;
  transition: Transition;
  /** Animated transparent layers drawn over the scene (card text, lower third, rank badge). */
  overlays?: Layer[];
  /** Sound effects, seconds after the scene starts. */
  sfx?: { kind: SfxKind; at: number }[];
}

export interface Timeline {
  version: 2;
  fps: number;
  width: number;
  height: number;
  duration: number;
  voice: string;
  music: { files: string[]; volumeDb: number; duckDb: number };
  /** Channel logo in a corner of every scene (null when the channel has none). */
  logo?: { path: string; position: string; opacity: number } | null;
  /** Motion graphics on/off and sound-effect level. */
  motion: { graphics: boolean; sfx: boolean; sfxDb: number };
  captions: CaptionStyle;
  scenes: TimelineScene[];
}

const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".ogg", ".flac"]);

/**
 * Step 5: scenes + assets + style -> timeline.json. The file is meant to be hand-editable: change a
 * motion, a transition, a clip in-point or the music volume, then re-run render.
 */
export async function timeline(opts: { project: string; force?: boolean }, log: (m: string) => void = console.log): Promise<number> {
  const dir = projectDir(opts.project);
  const files = ["scenes.json", "assets.json"].map((f) => path.join(dir, f));
  for (const f of files) {
    if (!fs.existsSync(f)) {
      log(`[timeline] ${f} missing. Run plan and assets first.`);
      return 1;
    }
  }
  const project = readJson<{ audio: string; channel?: string }>(path.join(dir, "project.json"));
  const channel = project.channel ?? "default";
  const chDir = path.join(paths.channels, channel);
  const style = loadStyle(channel);

  const inputs = {
    scenes: fingerprint(files[0]),
    assets: fingerprint(files[1]),
    style: fingerprint(path.join(chDir, "style.json")),
    music: musicFiles(chDir, style).join("|"),
    sections: fingerprint(path.join(dir, "sections.json")),
    graphicsVersion: "mg-1",
    logo: JSON.stringify(logoOf(style)) + fingerprint(logoOf(style)?.path),
  };
  if (!opts.force && isCached(dir, "timeline", inputs, ["timeline.json"])) {
    log(`[timeline] cached -> ${path.join(dir, "timeline.json")} (use --force to redo)`);
    return 0;
  }

  const scenes = readJson<Scene[]>(files[0]);
  const assets = readJson<Assets>(files[1]);
  const cap = (style.captions ?? {}) as Record<string, unknown>;
  const colors = (style.colors ?? {}) as Record<string, string>;
  const music = (style.music ?? {}) as Record<string, number>;
  const res = (style.resolution ?? {}) as Record<string, number>;

  // Stills alternate gentle moves so a run of images does not feel static; cards only breathe.
  const stillMoves: Motion[] = ["zoom_in", "pan_right", "zoom_out", "pan_left"];
  let stillIdx = 0;
  const sections = fs.existsSync(path.join(dir, "sections.json")) ? readJson<Section[]>(path.join(dir, "sections.json")) : [];
  const mg = (style.motionGraphics ?? {}) as Record<string, unknown>;
  const motionCfg = { graphics: mg.enabled !== false, sfx: mg.sfx !== false, sfxDb: Number(mg.sfxDb ?? -14) };
  const tl: TimelineScene[] = scenes.map((s) => {
    const a = assets[String(s.id)];
    let motion: Motion = "none";
    if (a.kind === "image") motion = a.source === "graphic" ? "zoom_in" : stillMoves[stillIdx++ % stillMoves.length];
    const isCard = a.source === "graphic" && s.type === "graphic";
    return {
      id: s.id,
      start: s.start,
      end: s.end,
      startFrame: Math.round(s.start * FPS),
      endFrame: Math.round(s.end * FPS),
      asset: { path: a.path, kind: a.kind, source: a.source, duration: a.duration, in: a.in ?? 0 },
      motion,
      // Dip to/from black around title-style cards marks a new section; everything else hard-cuts.
      transition: isCard && s.graphic?.kind === "title_card" ? "flash" : "cut",
    };
  });

  if (motionCfg.graphics) await addMotionGraphics(tl, scenes, assets, sections, style, path.join(dir, "graphics"));

  const out: Timeline = {
    version: 2,
    fps: FPS,
    width: res.width ?? 1920,
    height: res.height ?? 1080,
    duration: scenes[scenes.length - 1].end,
    voice: project.audio,
    music: { files: musicFiles(chDir, style), volumeDb: music.volumeDb ?? -18, duckDb: music.duckDb ?? -10 },
    motion: motionCfg,
    logo: logoOf(style),
    captions: {
      enabled: cap.enabled !== false,
      font: "Arial",
      fontSize: Number(cap.fontSize ?? 54),
      maxWordsPerLine: Number(cap.maxWordsPerLine ?? 7),
      background: String(cap.background ?? "rgba(0,0,0,0.55)"),
      textColor: colors.text ?? "#FFFFFF",
      marginV: 70,
    },
    scenes: tl,
  };
  writeJson(path.join(dir, "timeline.json"), out);
  markDone(dir, "timeline", inputs);
  const moves = tl.reduce<Record<string, number>>((m, s) => ((m[s.motion] = (m[s.motion] ?? 0) + 1), m), {});
  log(`[timeline] ${tl.length} scenes, ${(out.duration / 60).toFixed(1)} min, motions ${JSON.stringify(moves)}`);
  log(`[timeline] music: ${out.music.files.length ? out.music.files.map((f) => path.basename(f)).join(", ") : "none (add files to channels/" + channel + "/music)"}`);
  log(`[timeline] captions: ${out.captions.enabled ? "on" : "off"}`);
  const ov = tl.reduce((n, s) => n + (s.overlays?.length ?? 0), 0);
  const fx = tl.reduce((n, s) => n + (s.sfx?.length ?? 0), 0);
  log(`[timeline] motion graphics: ${motionCfg.graphics ? `${ov} animated layers, ${fx} sound effects` : "off"}`);
  log(`[timeline] wrote ${path.join(dir, "timeline.json")}`);
  return 0;
}

function musicFiles(chDir: string, style: Record<string, unknown>): string[] {
  const folder = path.join(chDir, String((style.music as Record<string, unknown> | undefined)?.folder ?? "music"));
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((f) => AUDIO_EXT.has(path.extname(f).toLowerCase()))
    .sort()
    .map((f) => path.join(folder, f));
}

function logoOf(style: Record<string, unknown>): Timeline["logo"] {
  const l = (style.logo ?? {}) as Record<string, unknown>;
  if (typeof l.path !== "string" || !fs.existsSync(l.path)) return null;
  return { path: l.path, position: String(l.position ?? "top-right"), opacity: Number(l.opacity ?? 0.8) };
}

function cardStyleOf(style: Record<string, unknown>): CardStyle {
  const colors = (style.colors ?? {}) as Record<string, string>;
  const fonts = (style.fonts ?? {}) as Record<string, string>;
  return {
    primary: colors.primary ?? "#E8A317",
    secondary: colors.secondary ?? "#1C1C1C",
    text: colors.text ?? "#FFFFFF",
    accent: colors.accent ?? "#C0392B",
    titleFont: fonts.title,
    bodyFont: fonts.body,
  };
}

/**
 * Motion graphics, the editor's layer on top of the footage:
 * - graphic cards: empty card background + text groups sliding in one after another (+ sfx)
 * - first product shot of each ranked item: lower third "#5 | NAME"
 * - every footage scene inside a ranked item: small "#5" corner badge
 */
async function addMotionGraphics(
  tl: TimelineScene[],
  scenes: Scene[],
  assets: Assets,
  sections: Section[],
  style: Record<string, unknown>,
  outDir: string,
): Promise<void> {
  const cs = cardStyleOf(style);
  const lowerThirdDone = new Set<number>();
  for (const [i, t] of tl.entries()) {
    const scene = scenes[i];
    const a = assets[String(scene.id)];
    const sec = sections.find((x) => x.id === scene.section);
    const dur = t.end - t.start;

    if (scene.type === "graphic" && scene.graphic && a.source === "graphic") {
      const { background, layers } = await renderCardLayers(scene.graphic, cs, outDir);
      t.asset = { ...t.asset, path: background };
      t.motion = "none"; // the text layers carry the motion; a zooming background would drift under them
      t.overlays = layers;
      t.sfx =
        scene.graphic.kind === "title_card"
          ? [{ kind: "whoosh", at: 0 }]
          : layers.slice(1).map((l) => ({ kind: "pop" as const, at: l.delay }));
      continue;
    }

    const overlays: Layer[] = [];
    if (sec?.kind === "item" && sec.rank !== undefined) {
      overlays.push({ path: await renderRankBadge(sec.rank, cs, outDir), delay: 0.15, anim: "fade" });
      if (scene.type === "product" && scene.product_name && !lowerThirdDone.has(sec.id)) {
        lowerThirdDone.add(sec.id);
        overlays.push({
          path: await renderLowerThird(sec.rank, scene.product_name, cs, outDir),
          delay: 0.4,
          anim: "slide_left",
          out: Math.max(1.2, Math.min(dur - 0.4, 4.5)),
        });
        t.sfx = [{ kind: "whoosh", at: 0.35 }];
      }
    }
    if (overlays.length) t.overlays = overlays;
  }
}
