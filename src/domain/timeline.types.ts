import type { ActiveSubject } from "./product.types.js";
import {
  add, cmp, eq, FrameRate, frameToSeconds, gt, isFrameAligned, lt, parseRational, rat, Rational, secondsToFrame, snapToFrame, sub, toRationalString, ZERO,
} from "./rational.math.js";

/**
 * Multi-track timeline (version 3). Time is exact (Rational seconds, see rational.math.ts), so
 * video, voice, overlays and captions can never drift apart.
 *
 *   voiceover  one or more audio clips (the timing truth)
 *   broll      exclusive video track: exactly one picture at any frame
 *   overlay    cards, lower thirds, HUD / spec callouts (may overlap each other)
 *   captions   timed caption lines
 *   music/sfx  beds and hits
 *
 * Scenes are blocks over the timeline (what the narration is about); clips reference their scene.
 * Pure data + pure helpers; the renderer and planners live in lib/.
 */

export const TIMELINE_VERSION = 3 as const;

export type TrackKind = "voiceover" | "broll" | "overlay" | "captions" | "music" | "sfx";
export type Motion = "none" | "zoom_in" | "zoom_out" | "pan_left" | "pan_right";
export type Transition = "cut" | "fade" | "flash";
/** cover = fill + crop; contain = letterbox; blur_pad = vertical (9:16) source over a blurred copy of itself. */
export type Fit = "cover" | "contain" | "blur_pad";

export interface MediaRef {
  path: string;
  kind: "video" | "image" | "audio";
  /** Where in the source file the clip starts. */
  sourceIn: Rational;
  /** Usable length of the source (if known). */
  sourceDuration?: Rational;
  width?: number;
  height?: number;
}

/** Where a picture came from and why it was chosen (shown as the confidence badge, audited by QA). */
export interface Provenance {
  source: string;
  url?: string;
  author?: string;
  license?: string;
  /** Caption keyword the clip was cut around ("brushless motor"). */
  keyword?: string;
  /** 0..1 */
  confidence?: number;
  /** Exact-model verified (vault / human check). */
  verified?: boolean;
}

interface ClipBase {
  id: string;
  trackId: string;
  /** Timeline start (seconds, frame-aligned). */
  start: Rational;
  duration: Rational;
  sceneId?: number;
  /** Locked clips are kept when a scene is regenerated. */
  locked?: boolean;
}

export interface VideoClip extends ClipBase {
  kind: "video";
  media: MediaRef;
  fit: Fit;
  motion: Motion;
  transitionIn: Transition;
  /**
   * The scene's one picture (Ken Burns / product showcase), as opposed to a 2-3 s pacing sub-shot.
   * Only meaningful when it is the scene's only B-roll clip.
   */
  single?: boolean;
  /** "blur": the picture is a blurred, darkened backdrop for a card drawn over it. */
  backdrop?: "blur";
  /** Visual variation for a reused moment. */
  variant?: "mirror" | "punch" | "mirror_punch";
  provenance: Provenance;
}

export interface AudioClip extends ClipBase {
  kind: "audio";
  media: MediaRef;
  gainDb: number;
  /** Music only: dip under the voice. */
  duck?: boolean;
}

export interface SfxClip extends ClipBase {
  kind: "sfx";
  sfx: string;
  gainDb: number;
}

/** HUD / spec callout that follows a moving product (tracking data from engine/tracking). */
export interface OverlayTracking {
  mode: "static" | "track";
  /** Anchor in the frame, 0..1 (static position, or the tracked point at the clip start). */
  anchor?: { x: number; y: number };
  /** Per-frame positions written by the tracker (relative path). */
  trackFile?: string;
}

export interface OverlayClip extends ClipBase {
  kind: "overlay";
  overlay: {
    type: "image" | "card" | "hud";
    /** PNG / alpha video. */
    path?: string;
    /** Remotion card to render. */
    card?: { comp: string; props: Record<string, unknown> };
    anim?: "slide_up" | "slide_left" | "slide_right" | "fade";
    /** Fade-out time from the clip start. */
    fadeOut?: Rational;
    /** path is an alpha video (Remotion card) that animates itself. */
    video?: boolean;
    tracking?: OverlayTracking;
  };
}

export interface CaptionClip extends ClipBase {
  kind: "caption";
  text: string;
  words?: { text: string; start: Rational; end: Rational }[];
}

export type Clip = VideoClip | AudioClip | SfxClip | OverlayClip | CaptionClip;

export interface Track {
  id: string;
  kind: TrackKind;
  name: string;
  /** Exclusive tracks (B-roll) may not have overlapping clips. */
  exclusive: boolean;
  muted?: boolean;
  clips: Clip[];
}

export interface SceneBlock {
  id: number;
  start: Rational;
  duration: Rational;
  text: string;
  subject: ActiveSubject;
}

/** Render-wide settings that are not clips (channel style). */
export interface RenderSettings {
  /** Caption style; lines come from the aligned words (or the captions track). */
  captions?: { enabled: boolean; [k: string]: unknown };
  logo?: { path: string; position: string; opacity: number } | null;
  sfx?: { enabled: boolean; gainDb: number };
}

export interface MultiTrackTimeline {
  version: typeof TIMELINE_VERSION;
  fps: FrameRate;
  width: number;
  height: number;
  duration: Rational;
  tracks: Track[];
  scenes: SceneBlock[];
  settings?: RenderSettings;
}

export const NO_SUBJECT: ActiveSubject = { productKey: null, confidence: 0, reason: "none" };

// ---------------------------------------------------------------------------------------------
// Helpers

export const clipEnd = (c: Pick<ClipBase, "start" | "duration">) => add(c.start, c.duration);
export const sceneEnd = (s: Pick<SceneBlock, "start" | "duration">) => add(s.start, s.duration);

export function trackOf(tl: MultiTrackTimeline, kind: TrackKind): Track | undefined {
  return tl.tracks.find((t) => t.kind === kind);
}

/** Clips visible / audible at time t (start <= t < end), per track. */
export function clipsAt(tl: MultiTrackTimeline, t: Rational): Clip[] {
  return tl.tracks.flatMap((tr) => tr.clips.filter((c) => !lt(t, c.start) && lt(t, clipEnd(c))));
}

/** First frame and frame count of a clip. */
export function clipFrames(c: Pick<ClipBase, "start" | "duration">, fps: FrameRate): { startFrame: bigint; frames: bigint } {
  const startFrame = secondsToFrame(c.start, fps);
  return { startFrame, frames: secondsToFrame(clipEnd(c), fps) - startFrame };
}

/** Problems that would make a render wrong; empty = valid. */
export function validateTimeline(tl: MultiTrackTimeline): string[] {
  const errors: string[] = [];
  if (tl.version !== TIMELINE_VERSION) errors.push(`version ${tl.version}, expected ${TIMELINE_VERSION}`);
  if (!gt(tl.duration, ZERO)) errors.push("duration must be > 0");
  if (!isFrameAligned(tl.duration, tl.fps)) errors.push("duration is not on a frame boundary");
  const ids = new Set<string>();
  for (const tr of tl.tracks) {
    const sorted = [...tr.clips].sort((a, b) => cmp(a.start, b.start));
    for (const [i, c] of sorted.entries()) {
      const where = `${tr.id}/${c.id}`;
      if (ids.has(c.id)) errors.push(`${where}: duplicate clip id`);
      ids.add(c.id);
      if (c.trackId !== tr.id) errors.push(`${where}: trackId is ${c.trackId}`);
      if (!gt(c.duration, ZERO)) errors.push(`${where}: duration must be > 0`);
      if (lt(c.start, ZERO) || gt(clipEnd(c), tl.duration)) errors.push(`${where}: outside the timeline`);
      if (tr.kind !== "voiceover" && tr.kind !== "music" && (!isFrameAligned(c.start, tl.fps) || !isFrameAligned(c.duration, tl.fps))) errors.push(`${where}: not frame-aligned`);
      if (tr.exclusive && i > 0 && lt(c.start, clipEnd(sorted[i - 1]))) errors.push(`${where}: overlaps ${sorted[i - 1].id}`);
    }
  }
  // Scenes tile the timeline without gaps or overlaps.
  const scenes = [...tl.scenes].sort((a, b) => cmp(a.start, b.start));
  let at = ZERO;
  for (const s of scenes) {
    if (!eq(s.start, at)) errors.push(`scene ${s.id}: starts at ${toRationalString(s.start)}, expected ${toRationalString(at)}`);
    if (!gt(s.duration, ZERO)) errors.push(`scene ${s.id}: duration must be > 0`);
    at = sceneEnd(s);
  }
  if (scenes.length && !eq(at, tl.duration)) errors.push(`scenes end at ${toRationalString(at)}, timeline is ${toRationalString(tl.duration)}`);
  return errors;
}

// ---------------------------------------------------------------------------------------------
// JSON (BigInt is not JSON): every Rational becomes {"$r": "n/d"}

const isRational = (v: unknown): v is Rational => !!v && typeof v === "object" && typeof (v as Rational).n === "bigint" && typeof (v as Rational).d === "bigint";

export function timelineToJson(tl: MultiTrackTimeline, space = 1): string {
  return JSON.stringify(tl, (_k, v) => (isRational(v) ? { $r: toRationalString(v) } : v), space);
}

export function timelineFromJson(text: string): MultiTrackTimeline {
  const tl = JSON.parse(text.replace(/^﻿/, ""), (_k, v) => (v && typeof v === "object" && typeof v.$r === "string" && Object.keys(v).length === 1 ? parseRational(v.$r) : v)) as MultiTrackTimeline;
  if (tl.version !== TIMELINE_VERSION) throw new Error(`not a v${TIMELINE_VERSION} timeline (version ${String(tl.version)})`);
  return tl;
}

// ---------------------------------------------------------------------------------------------
// Migration from the v2 single-track timeline.json (src/commands/timeline.ts), declared
// structurally so the domain does not depend on lib/.

interface LegacyShot {
  path: string;
  kind: "video" | "image";
  in?: number;
  frames: number;
  source?: string;
  url?: string;
  author?: string;
  verified?: boolean;
  variant?: "mirror" | "punch" | "mirror_punch";
}
interface LegacyLayer {
  path: string;
  delay: number;
  anim: "slide_up" | "slide_left" | "slide_right" | "fade";
  out?: number;
  video?: boolean;
  card?: { comp: string; props: Record<string, unknown> };
}
export interface LegacyTimeline {
  version: number;
  fps: number;
  width: number;
  height: number;
  voice: string;
  music: { files: string[]; volumeDb: number };
  motion?: { sfx?: boolean; sfxDb?: number };
  captions?: { enabled: boolean; [k: string]: unknown };
  logo?: { path: string; position: string; opacity: number } | null;
  scenes: {
    id: number;
    startFrame: number;
    endFrame: number;
    asset: { path: string; kind: "video" | "image"; source: string; in?: number; shots?: LegacyShot[] };
    motion: Motion;
    transition: Transition;
    backdrop?: "blur";
    overlays?: LegacyLayer[];
    sfx?: { kind: string; at: number }[];
  }[];
}

/**
 * v2 -> v3. Scene boundaries come from the v2 integer frames, so the result is frame-identical to
 * what the v2 renderer produced. Float offsets inside a scene (sub-shot in-points, layer delays)
 * are converted exactly from their decimal value and snapped to the frame grid.
 */
export function fromLegacyTimeline(legacy: LegacyTimeline, sceneText: Record<number, string> = {}): MultiTrackTimeline {
  const fps = rat(BigInt(legacy.fps));
  const f2s = (f: number) => frameToSeconds(BigInt(f), fps);
  const dec = (x: number) => parseRational(x);
  const last = legacy.scenes[legacy.scenes.length - 1];
  const duration = f2s(last ? last.endFrame : 0);
  const tracks: Track[] = [
    { id: "voice", kind: "voiceover", name: "Voiceover", exclusive: true, clips: [] },
    { id: "broll", kind: "broll", name: "B-roll", exclusive: true, clips: [] },
    { id: "overlay", kind: "overlay", name: "Overlays", exclusive: false, clips: [] },
    { id: "music", kind: "music", name: "Music", exclusive: false, clips: [] },
    { id: "sfx", kind: "sfx", name: "SFX", exclusive: false, clips: [] },
  ];
  const [voice, broll, overlay, music, sfx] = tracks;
  voice.clips.push({ id: "voice_0", trackId: voice.id, kind: "audio", start: ZERO, duration, media: { path: legacy.voice, kind: "audio", sourceIn: ZERO }, gainDb: 0 });
  legacy.music.files.forEach((f, i) =>
    music.clips.push({ id: `music_${i}`, trackId: music.id, kind: "audio", start: ZERO, duration, media: { path: f, kind: "audio", sourceIn: ZERO }, gainDb: legacy.music.volumeDb, duck: true }),
  );
  const scenes: SceneBlock[] = [];
  for (const s of legacy.scenes) {
    const start = f2s(s.startFrame);
    const sceneDur = sub(f2s(s.endFrame), start);
    scenes.push({ id: s.id, start, duration: sceneDur, text: sceneText[s.id] ?? "", subject: NO_SUBJECT });
    const single = !s.asset.shots?.length;
    const shots: LegacyShot[] = single ? [{ path: s.asset.path, kind: s.asset.kind, in: s.asset.in, frames: s.endFrame - s.startFrame, source: s.asset.source }] : s.asset.shots!;
    let frame = s.startFrame;
    shots.forEach((sh, k) => {
      broll.clips.push({
        id: `broll_${s.id}_${k}`, trackId: broll.id, kind: "video", sceneId: s.id,
        start: f2s(frame), duration: f2s(sh.frames),
        media: { path: sh.path, kind: sh.kind, sourceIn: dec(sh.in ?? 0) },
        fit: "cover", motion: s.motion, transitionIn: k === 0 ? s.transition : "cut",
        ...(single ? { single: true } : {}),
        ...(s.backdrop ? { backdrop: s.backdrop } : {}),
        ...(sh.variant ? { variant: sh.variant } : {}),
        provenance: { source: sh.source ?? s.asset.source, ...(sh.url ? { url: sh.url } : {}), ...(sh.author ? { author: sh.author } : {}), ...(sh.verified ? { verified: true } : {}) },
      });
      frame += sh.frames;
    });
    (s.overlays ?? []).forEach((l, k) => {
      const at = snapToFrame(dec(l.delay), fps);
      if (!lt(at, sceneDur)) return;
      const endIn = l.out !== undefined ? snapToFrame(dec(l.out), fps) : sceneDur;
      const dur = sub(lt(endIn, sceneDur) ? endIn : sceneDur, at);
      if (!gt(dur, ZERO)) return;
      overlay.clips.push({
        id: `overlay_${s.id}_${k}`, trackId: overlay.id, kind: "overlay", sceneId: s.id, start: add(start, at), duration: dur,
        overlay: { type: l.card ? "card" : "image", path: l.path, anim: l.anim, ...(l.video ? { video: true } : {}), ...(l.card ? { card: l.card } : {}) },
      });
    });
    (s.sfx ?? []).forEach((e, k) => {
      const at = snapToFrame(dec(e.at), fps);
      const len = frameToSeconds(15n, fps); // half a second at 30 fps
      const end = add(add(start, at), len);
      if (!lt(at, sceneDur) || gt(end, duration)) return;
      sfx.clips.push({ id: `sfx_${s.id}_${k}`, trackId: sfx.id, kind: "sfx", sceneId: s.id, start: add(start, at), duration: len, sfx: e.kind, gainDb: legacy.motion?.sfxDb ?? -14 });
    });
  }
  return {
    version: TIMELINE_VERSION, fps, width: legacy.width, height: legacy.height, duration, tracks, scenes,
    settings: {
      ...(legacy.captions ? { captions: legacy.captions } : {}),
      logo: legacy.logo ?? null,
      sfx: { enabled: legacy.motion?.sfx !== false, gainDb: legacy.motion?.sfxDb ?? -14 },
    },
  };
}
