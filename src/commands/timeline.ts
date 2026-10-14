import fs from "node:fs";
import path from "node:path";
import type { Asset, Assets } from "../lib/assets/types.js";
import { paths } from "../lib/paths.js";
import { fingerprint, isCached, markDone, projectDir, readJson, writeJson } from "../lib/project.js";
import type { Scene } from "../lib/scenes.js";
import { loadStyle } from "../lib/style.js";
import type { CaptionStyle } from "../lib/render/captions.js";
import { CardStyle, Layer, renderCardLayers, renderLowerThird, renderRankBadge, renderSidePanel, renderSpecChip } from "../lib/assets/graphics.js";
import { slug } from "../lib/assets/presskit.js";
import { readResearch } from "../lib/agent/webResearch.js";
import type { Section } from "../lib/scenes.js";
import type { SfxKind } from "../lib/render/sfx.js";
import { applyPacing, pacingConfig, SubShot, Word } from "../lib/pacing.js";
import { exactModelPrompt, productRegions, readPoolStatus, readProductPool } from "../lib/assets/productPool.js";
import { verifyCandidates, visionVerifyEnabled } from "../lib/agent/visionVerify.js";
import { loadProjectNiche } from "../lib/niche.js";
import { env } from "../lib/env.js";
import { applyRemotionCards } from "../lib/render/remotionCards.js";
import { filterPoolByShotQa } from "../lib/assets/shotQa.js";
import { poolConfig } from "../lib/assets/productPool.js";
import { extractFacts, readFacts, type Facts } from "../lib/facts.js";
import { buildChapters, writeChapters } from "../lib/chapters.js";
import { cardPreset, pacingTarget, themeOf } from "../lib/stylePreset.js";
import { placeChapterGraphics } from "../lib/render/productGraphics.js";
import { reapplySwaps } from "../lib/sceneReview.js";

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
  asset: Pick<Asset, "path" | "kind" | "source" | "duration" | "in"> & { shots?: SubShot[] };
  motion: Motion;
  transition: Transition;
  /** Animated transparent layers drawn over the scene (card text, lower third, rank badge). */
  overlays?: Layer[];
  /** Sound effects, seconds after the scene starts. */
  sfx?: { kind: SfxKind; at: number }[];
  /** "blur": the footage is a blurred, darkened backdrop for card text drawn over it. */
  backdrop?: "blur";
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
  const project = readJson<{ name?: string; audio: string; channel?: string; niche?: string; footage?: string }>(path.join(dir, "project.json"));
  if (!project.name) project.name = opts.project;
  const channel = project.channel ?? "default";
  const chDir = path.join(paths.channels, channel);
  const style = loadStyle(channel);

  const inputs = {
    scenes: fingerprint(files[0]),
    assets: fingerprint(files[1]),
    style: fingerprint(path.join(chDir, "style.json")),
    music: musicFiles(chDir, style).join("|"),
    sections: fingerprint(path.join(dir, "sections.json")),
    graphicsVersion: "mg-5-chapters",
    cardsPreset: JSON.stringify(style.cards ?? null) + JSON.stringify(style.pacing ?? null),
    facts: fingerprint(path.join(dir, "facts.json")),
    swaps: fingerprint(path.join(dir, "review_swaps.json")),
    shotQa: env("SHOT_QA", "on") + "shotqa-1" + env("CARDS", "on"),
    // Spec chips come from web research saved in the press kit.
    specs: specFingerprint(channel, readJson<Scene[]>(files[0])),
    logo: JSON.stringify(logoOf(style)) + fingerprint(logoOf(style)?.path),
    pacing: JSON.stringify(pacingConfig(loadProjectNiche(project, style), env("PACING", "on").toLowerCase() === "off")) + "pace-3-ledger",
    pool: fingerprint(path.join(dir, "product_pool.json")) + fingerprint(path.join(dir, "product_pool_status.json")),
    aligned: fingerprint(path.join(dir, "aligned.json")),
  };
  if (!opts.force && isCached(dir, "timeline", inputs, ["timeline.json"])) {
    log(`[timeline] cached -> ${path.join(dir, "timeline.json")} (use --force to redo)`);
    return 0;
  }

  const scenes = readJson<Scene[]>(files[0]);
  const assets = readJson<Assets>(files[1]);
  // Script facts (name, price, specs per product) and chapters (one per product).
  const facts: Facts | null = await extractFacts(dir, scenes, log).catch((e) => (log(`[facts] failed: ${String(e).slice(0, 160)}`), readFacts(dir)));
  FACTS = facts;
  const chapters = buildChapters(scenes, facts);
  writeChapters(dir, chapters);
  log(`[chapters] ${chapters.length}: ${chapters.map((c) => `${c.title} @${c.start.toFixed(1)}s`).join(", ")}`);
  const preset = cardPreset(style);
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

  // Exact-model check on every product photo shown under a product (press kit / official / any
  // image in the presskit folder). Only confirmed photos are used; unchecked = not used.
  VERIFIED_PHOTOS = await verifyProductPhotos(dir, channel, scenes, poolConfig(loadProjectNiche(project, style)).category, log);
  if (motionCfg.graphics) await addMotionGraphics(tl, scenes, assets, sections, style, path.join(dir, "graphics"), channel);
  const pace = pacingConfig(loadProjectNiche(project, style), env("PACING", "on").toLowerCase() === "off");
  // Channel preset overrides the niche shot length; every chapter start gets the opening pace.
  pace.targetShotSec = pacingTarget(style) ?? pace.targetShotSec;
  pace.chapterStarts = chapters.filter((c) => c.product).map((c) => c.start);
  if (pace.enabled && fs.existsSync(path.join(dir, "aligned.json"))) {
    const words = readJson<{ words: Word[] }>(path.join(dir, "aligned.json")).words;
    const nicheCfg = loadProjectNiche(project, style) as unknown as { productPool?: { mix?: Record<string, number>; rankCardAtSec?: [number, number] } };
    const niche = loadProjectNiche(project, style);
    const pool = await filterPoolByShotQa(readProductPool(dir), poolConfig(niche).category, log);
    const shares = applyPacing(tl, scenes, words, pool, pace, log, {
      photosOf: (p) => productPhotos(channel, p),
      mix: nicheCfg.productPool?.mix,
      maxStockShare: Number(env("MAX_STOCK_SHARE", "0.2")),
    });
    const status = readPoolStatus(dir);
    const report = shares.map((sh) => ({ ...sh, poolVerified: status[sh.product]?.verified ?? pool.filter((p) => p.product === sh.product && p.verified).length, poolTarget: status[sh.product]?.need, insufficient: status[sh.product]?.insufficient ?? !pool.some((p) => p.product === sh.product && p.verified) }));
    writeJson(path.join(dir, "footage_share.json"), report);
    for (const r of report) if (r.insufficient) log(`[timeline] WARNING insufficient footage for ${r.product}: ${r.poolVerified} verified clip(s) (target ${r.poolTarget ?? "?"}); chapter is ${Math.round(r.verifiedShare * 100)}% verified`);
    if (motionCfg.graphics) await addRankPriceCards(tl, scenes, sections, cardStyleOf(style), path.join(dir, "graphics"), nicheCfg.productPool?.rankCardAtSec ?? [11, 14], log);
  }
  if (motionCfg.graphics && preset.set.size) {
    const blank = path.join(dir, "graphics", "blank.png");
    placeChapterGraphics(tl, scenes, chapters, facts, preset, blank, log);
    // Card set from the channel preset; the theme (colours, font) goes to every card.
    for (const t of tl) for (const l of t.overlays ?? []) {
      if (!l.card) continue;
      if (!preset.set.has(l.card.comp)) delete l.card;
      else if (preset.custom) l.card.props = { ...l.card.props, theme: themeOf(preset) };
    }
  }
  // Animated Remotion cards (cards/) replace the drawtext PNGs; any card that fails keeps its PNG.
  if (motionCfg.graphics) await applyRemotionCards(tl, log);
  // New product graphics have no drawtext version: drop them when Remotion did not render them.
  for (const t of tl) if (t.overlays) t.overlays = t.overlays.filter((l) => l.video || !l.path.endsWith("blank.png"));
  reapplySwaps(dir, tl, log);

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
  channel: string,
): Promise<void> {
  const cs = cardStyleOf(style);
  const lowerThirdDone = new Set<number>();
  // Spec chips go on one shot per product: the first that shows the product's own media (own clip,
  // press kit / official photo, Wikimedia photo), else its first non-card shot.
  const OWN_MEDIA = new Set(["local", "presskit", "wikimedia"]);
  const chipScene = new Map<string, number>();
  const photoTurn = new Map<string, number>();
  for (const [i, sc] of scenes.entries()) {
    const name = sc.product_name;
    const src = assets[String(sc.id)]?.source;
    const len = tl[i].end - tl[i].start;
    if (sc.type !== "product" || !name || src === "graphic" || len < 3) continue;
    const prev = chipScene.get(name);
    const prevOwn = prev !== undefined && OWN_MEDIA.has(assets[String(prev)]?.source ?? "");
    if (prev === undefined || (!prevOwn && OWN_MEDIA.has(src ?? ""))) chipScene.set(name, sc.id);
  }
  for (const [i, t] of tl.entries()) {
    const scene = scenes[i];
    const a = assets[String(scene.id)];
    const sec = sections.find((x) => x.id === scene.section);
    const dur = t.end - t.start;

    if (scene.type === "graphic" && scene.graphic && a.source === "graphic") {
      // Product cards (price, "up next", specs) sit on the product's own photo, not on black.
      const g = scene.graphic;
      const photos = scene.product_name ? productPhotos(channel, scene.product_name) : [];
      const pcFacts = g.kind === "pros_cons" ? FACTS?.products.find((p) => p.name.toLowerCase() === (scene.product_name ?? "").toLowerCase()) : undefined;
      if (photos.length && (["price_badge", "title_card", "spec_card"].includes(g.kind) || (g.kind === "pros_cons" && pcFacts))) {
        const photo = photos[(photoTurn.get(scene.product_name!) ?? 0) % photos.length];
        photoTurn.set(scene.product_name!, (photoTurn.get(scene.product_name!) ?? 0) + 1);
        const kicker = g.kind === "price_badge" ? "Price" : g.kind === "title_card" ? (g.rank !== undefined ? `Number ${g.rank}` : "Up next") : g.kind === "pros_cons" ? "Pros & cons" : "Specs";
        // Values only from the script fact sheet (facts.json), never planner text or web research.
        const fx = FACTS?.products.find((p) => p.name.toLowerCase() === scene.product_name!.toLowerCase());
        const big = g.kind === "price_badge" ? fx?.price : g.kind === "spec_card" && fx?.specs[0] ? `${fx.specs[0].label}: ${fx.specs[0].value}` : undefined;
        t.asset = { path: photo, kind: "image", source: "presskit", duration: undefined, in: 0 };
        t.motion = "zoom_in";
        t.overlays = [{ path: await renderSidePanel(kicker, scene.product_name!, big, cs, outDir), delay: 0.2, anim: "slide_right", card: cardFor(g, scene.product_name!) }];
        t.sfx = [{ kind: "whoosh", at: 0.15 }];
        continue;
      }
      // Other cards (intro, outro, cards without a product photo): text over the nearest footage,
      // blurred and darkened, instead of a flat black card.
      const near = nearestFootage(tl, i);
      if (near) {
        const { layers } = await renderCardLayers(scene.graphic, cs, outDir);
        t.asset = { ...near.asset };
        t.motion = near.asset.kind === "image" ? "zoom_in" : "none";
        t.backdrop = "blur";
        t.overlays = layers;
        t.sfx = g.kind === "title_card" ? [{ kind: "whoosh", at: 0 }] : layers.slice(1).map((l) => ({ kind: "pop" as const, at: l.delay }));
        continue;
      }
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
          card: { comp: "LowerThird", props: { title: scene.product_name, rank: sec.rank, sub: "" } },
          delay: 0.4,
          anim: "slide_left",
          out: Math.max(1.2, Math.min(dur - 0.4, 4.5)),
        });
        t.sfx = [{ kind: "whoosh", at: 0.35 }];
      }
    }
    // The product's script facts as chips (see chipScene above); web research is never shown on screen.
    const chipFacts = scene.product_name && chipScene.get(scene.product_name) === scene.id ? FACTS?.products.find((p) => p.name.toLowerCase() === scene.product_name!.toLowerCase()) : undefined;
    const specs = (chipFacts?.specs ?? []).filter((x) => x.value).map((x) => `${x.label} ${x.value}`);
    if (specs.length) {
      const out = Math.min(dur - 0.35, 7);
      const shown = specs.slice(0, dur >= 5 ? 4 : 2);
      for (const [k, spec] of shown.entries()) {
        const delay = Math.round((0.9 + k * 0.35) * 100) / 100;
        if (delay + 0.6 > out) break;
        overlays.push({ path: await renderSpecChip(spec, k, cs, outDir), delay, anim: "slide_right", out });
        (t.sfx ??= []).push({ kind: "pop", at: delay });
      }
    }
    if (overlays.length) t.overlays = overlays;
  }
}

/**
 * Channel study: the first rank/price card lands ~11-14 s after a product is introduced. Where the
 * planner put no card in that window, a side-panel card ("#3" / "Price $599") slides in over the
 * footage at that point for ~3.5 s.
 */
async function addRankPriceCards(
  tl: TimelineScene[],
  scenes: Scene[],
  sections: Section[],
  cs: CardStyle,
  outDir: string,
  win: [number, number],
  log: (m: string) => void,
): Promise<void> {
  let added = 0, skipped = 0;
  for (const [name, region] of productRegions(scenes)) {
    const first = region.find((x) => x.type !== "graphic");
    if (!first) continue;
    const t0 = first.start;
    const at = t0 + (win[0] + win[1]) / 2;
    const hasCard = scenes.some((x) => x.type === "graphic" && x.start >= t0 + win[0] - 3 && x.start <= t0 + win[1] + 2);
    if (hasCard) {
      skipped++;
      continue;
    }
    const i = tl.findIndex((t, k) => t.start <= at && t.end > at && scenes[k].type !== "graphic" && !t.backdrop);
    if (i < 0) continue;
    const t = tl[i];
    const delay = Math.round((at - t.start) * 100) / 100;
    if (t.end - at < 1.5) continue;
    const f = FACTS?.products.find((p) => p.name.toLowerCase() === name.toLowerCase());
    // A planned price card elsewhere in this product's region already shows the price: rank card here.
    const pricedElsewhere = region.some((x) => x.graphic?.kind === "price_badge");
    const price = pricedElsewhere ? undefined : f?.price;
    const sec0 = sections.find((x) => x.id === first.section);
    const sec = sec0?.rank === undefined && f?.rank !== undefined ? { ...sec0!, rank: f.rank } : sec0;
    const kicker = price ? "Price" : sec?.rank !== undefined ? `#${sec.rank}` : "Pick";
    const card: Layer["card"] = price
      ? { comp: "PriceCard", props: { name, price } }
      : sec?.rank !== undefined
        ? { comp: "RankCard", props: { rank: sec.rank, name } }
        : { comp: "LowerThird", props: { title: name, sub: f?.verdict ?? "Top pick", rank: null } };
    const layer: Layer = { path: await renderSidePanel(kicker, name, price, cs, outDir), delay, anim: "slide_right", out: Math.min(t.end - t.start - 0.2, delay + 3.5), card };
    // Drop spec chips that would collide with the panel.
    t.overlays = [...(t.overlays ?? []).filter((l) => !(l.anim === "slide_right" && (l.out ?? 99) > delay)), layer];
    (t.sfx ??= []).push({ kind: "whoosh", at: Math.max(0, delay - 0.05) });
    added++;
  }
  log(`[timeline] rank/price cards at +${win[0]}-${win[1]} s: ${added} added, ${skipped} product(s) already had a card there`);
}

/** Remotion card for a product graphic scene (price / "number N" / specs) over its photo. */
let FACTS: Facts | null = null;

function cardFor(g: Scene["graphic"] & object, name: string): Layer["card"] {
  const f = FACTS?.products.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (g.kind === "price_badge" && f?.price) return { comp: "PriceCard", props: { name, price: f.price } };
  // Spec card rows from the script facts (label / value pairs), not the planner's one-line text.
  if (g.kind === "pros_cons" && f && f.pros.length + f.cons.length >= 2) return { comp: "ProsCons", props: { title: name, pros: f.pros, cons: f.cons } };
  if (g.kind === "spec_card" && f && f.specs.length >= 2) return { comp: "SpecCard", props: { title: name, rows: f.specs.slice(0, 5).map((x) => [x.label, x.value]) } };
  if (g.kind === "title_card" && g.rank !== undefined) return { comp: "RankCard", props: { rank: g.rank, name } };
  if (g.kind === "title_card") return { comp: "LowerThird", props: { title: name, sub: "Up next", rank: null } };
  return undefined;
}

/** Product photos that passed the exact-model check (set per run by verifyProductPhotos). */
let VERIFIED_PHOTOS: Map<string, Set<string>> | null = null;

function allProductPhotos(channel: string, product: string): string[] {
  const dir = path.join(paths.channels, channel, "presskit", slug(product));
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort().map((f) => path.join(dir, f));
}

/** The product's photos in the channel press kit, only those Claude confirmed show the exact model. */
function productPhotos(channel: string, product: string): string[] {
  const ok = VERIFIED_PHOTOS?.get(product);
  return allProductPhotos(channel, product).filter((f) => ok?.has(f));
}

async function verifyProductPhotos(dir: string, channel: string, scenes: Scene[], category: string, log: (m: string) => void): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  const names = [...productRegions(scenes).keys()];
  if (!visionVerifyEnabled()) {
    log("[photos] exact-model check unavailable (no ANTHROPIC_API_KEY / VISION_VERIFY=off): product photos are not used");
    for (const n of names) out.set(n, new Set());
    return out;
  }
  for (const [k, n] of names.entries()) {
    const files = allProductPhotos(channel, n);
    const set = new Set<string>();
    out.set(n, set);
    if (!files.length) continue;
    const items = [];
    for (let i = 0; i < files.length; i += 4) items.push({ sceneId: 8000 + k * 100 + i, text: exactModelPrompt(n, category), before: "", cands: files.slice(i, i + 4).map((f) => ({ id: path.basename(f), frames: [f] })) });
    const v = await verifyCandidates(items, `${n} review`, path.join(dir, "vision_photos.json"), log);
    files.forEach((f, i) => {
      if (v.get(`${8000 + k * 100 + Math.floor(i / 4) * 4}|${path.basename(f)}`) === true) set.add(f);
    });
    log(`[photos] ${n}: ${set.size}/${files.length} product photo(s) confirmed as the exact model`);
  }
  return out;
}

/** Closest real footage (video first) around scene i, for a card's blurred backdrop. */
function nearestFootage(tl: TimelineScene[], i: number): TimelineScene | undefined {
  for (let d = 1; d < tl.length; d++) {
    for (const j of [i + d, i - d]) {
      const t = tl[j];
      if (t && t.asset.source !== "graphic" && t.asset.kind === "video") return t;
    }
  }
  return undefined;
}

/** Changes when any product's saved specs change, so the timeline picks up new research. */
function specFingerprint(channel: string, scenes: Scene[]): string {
  const names = [...new Set(scenes.map((s) => s.product_name).filter((n): n is string => !!n))].sort();
  return names.map((n) => `${n}:${(readResearch(channel, n)?.specs ?? []).join("|")}`).join(";") + "|exact-model-1";
}
