import fs from "node:fs";
import path from "node:path";
import type { ActiveSubject } from "../../domain/product.types.js";
import { FPS_30, frameToSeconds, Rational, secondsToFrame, sub, toNumber } from "../../domain/rational.math.js";
import {
  AudioClip, clipEnd, clipFrames, fromLegacyTimeline, LegacyTimeline, MultiTrackTimeline, OverlayClip, SfxClip, timelineFromJson, timelineToJson, validateTimeline, VideoClip,
} from "../../domain/timeline.types.js";
import { readJson } from "../project.js";

/**
 * v3 multi-track timeline -> what the renderer executes:
 *   - one render job per scene (frame-exact start / length, its B-roll shots, overlays, SFX,
 *     transition / fade, backdrop), in the per-scene shape the segment filter graph builder takes;
 *   - the audio plan (voice, music bed and its gain, SFX events) and render settings.
 * The v3 file (timeline.v3.json) is the source of truth; projects without one are migrated from
 * timeline.json (v2) on the fly, frame-identical.
 */

export const V3_FILE = "timeline.v3.json";
export const V2_FILE = "timeline.json";

/** One B-roll piece inside a scene (pacing sub-shot or the scene's single picture). */
export interface CompiledShot {
  path: string;
  kind: "video" | "image";
  /** Seconds into the source file. */
  in: number;
  frames: number;
  source: string;
  url?: string;
  author?: string;
  verified?: boolean;
  variant?: "mirror" | "punch" | "mirror_punch";
}

export interface CompiledLayer {
  path: string;
  /** Seconds after the scene starts. */
  delay: number;
  anim: "slide_up" | "slide_left" | "slide_right" | "fade";
  out?: number;
  video?: boolean;
  card?: { comp: string; props: Record<string, unknown> };
}

/** A scene in the shape the segment renderer (render.ts segmentArgs) consumes. */
export interface CompiledScene {
  id: number;
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  text: string;
  subject: ActiveSubject;
  asset: { path: string; kind: "video" | "image"; source: string; in?: number; shots?: CompiledShot[] };
  motion: VideoClip["motion"];
  transition: VideoClip["transitionIn"];
  backdrop?: "blur";
  overlays: CompiledLayer[];
  sfx: { kind: string; at: number }[];
}

export interface AudioPlan {
  voice: string;
  /**
   * Set when parts of the voice were cut out in the editor: the pieces of the voice file to play,
   * back to back (seconds into the file). Absent = the whole file from 0.
   */
  voiceParts?: { in: number; dur: number }[];
  music: { files: string[]; volumeDb: number };
  sfx: { enabled: boolean; gainDb: number; events: { kind: string; at: number }[] };
}

export interface CompiledTimeline {
  fps: number;
  width: number;
  height: number;
  /** Exact length (end of the last scene). */
  duration: Rational;
  totalFrames: number;
  scenes: CompiledScene[];
  audio: AudioPlan;
  captions: { enabled: boolean; [k: string]: unknown };
  logo: { path: string; position: string; opacity: number } | null;
}

/**
 * timeline.v3.json when present and current; timeline.json (v2) migrated when there is no v3 file
 * or when timeline.json was edited after it (scene swaps in the simple UI, hand edits) - then the v3
 * file is rewritten, keeping its scene text and locked subjects. Null when neither exists.
 */
export function loadTimeline(dir: string): { tl: MultiTrackTimeline; source: "v3" | "v2" | "v2-synced" } | null {
  const v3 = path.join(dir, V3_FILE);
  const v2 = path.join(dir, V2_FILE);
  const hasV3 = fs.existsSync(v3);
  const hasV2 = fs.existsSync(v2);
  if (!hasV3 && !hasV2) return null;
  if (hasV3 && (!hasV2 || fs.statSync(v2).mtimeMs <= fs.statSync(v3).mtimeMs)) return { tl: timelineFromJson(fs.readFileSync(v3, "utf8")), source: "v3" };
  const prev = hasV3 ? timelineFromJson(fs.readFileSync(v3, "utf8")) : null;
  const tl = fromLegacyTimeline(readJson<LegacyTimeline>(v2), Object.fromEntries((prev?.scenes ?? []).map((s) => [s.id, s.text])));
  if (prev) for (const s of tl.scenes) s.subject = prev.scenes.find((p) => p.id === s.id)?.subject ?? s.subject;
  if (!hasV3) return { tl, source: "v2" };
  writeTimelineV3(dir, tl);
  return { tl, source: "v2-synced" };
}

export function writeTimelineV3(dir: string, tl: MultiTrackTimeline): string {
  const errors = validateTimeline(tl);
  if (errors.length) throw new Error(`invalid v3 timeline: ${errors.slice(0, 5).join("; ")}`);
  const f = path.join(dir, V3_FILE);
  fs.writeFileSync(f, timelineToJson(tl));
  return f;
}

const sec = (r: Rational) => Math.round(toNumber(r) * 1e6) / 1e6;

/** Compiles a valid v3 timeline for the renderer. Throws on validation errors or a non-30 fps rate. */
export function compileTimeline(tl: MultiTrackTimeline): CompiledTimeline {
  const errors = validateTimeline(tl);
  if (errors.length) throw new Error(`timeline is not renderable: ${errors.slice(0, 5).join("; ")}`);
  // The segment filter graphs (zoompan, fades, Remotion cards) are built for 30 fps.
  if (tl.fps.n !== 30n || tl.fps.d !== 1n) throw new Error(`only 30 fps timelines can be rendered (got ${tl.fps.n}/${tl.fps.d})`);
  const fps = tl.fps;
  const clipsOf = <T>(kind: string) => tl.tracks.filter((t) => t.kind === kind && !t.muted).flatMap((t) => t.clips) as T[];
  const broll = clipsOf<VideoClip>("broll").filter((c) => c.kind === "video");
  const overlays = clipsOf<OverlayClip>("overlay").filter((c) => c.kind === "overlay");
  const sfxClips = clipsOf<SfxClip>("sfx").filter((c) => c.kind === "sfx");
  const inScene = (start: Rational, end: Rational) => (c: { start: Rational }) => !(toNumber(c.start) < toNumber(start)) && toNumber(c.start) < toNumber(end);

  const scenes: CompiledScene[] = [...tl.scenes]
    .sort((a, b) => toNumber(a.start) - toNumber(b.start))
    .map((s) => {
      const end = clipEnd(s);
      const startFrame = Number(secondsToFrame(s.start, fps));
      const endFrame = Number(secondsToFrame(end, fps));
      const own = broll.filter((c) => (c.sceneId !== undefined ? c.sceneId === s.id : inScene(s.start, end)(c))).sort((a, b) => toNumber(a.start) - toNumber(b.start));
      if (!own.length) throw new Error(`scene ${s.id} has no B-roll clip`);
      const shots: CompiledShot[] = own.map((c) => ({
        path: c.media.path,
        kind: c.media.kind === "image" ? "image" : "video",
        in: sec(c.media.sourceIn),
        frames: Number(clipFrames(c, fps).frames),
        source: c.provenance.source,
        ...(c.provenance.url ? { url: c.provenance.url } : {}),
        ...(c.provenance.author ? { author: c.provenance.author } : {}),
        ...(c.provenance.verified ? { verified: true } : {}),
        ...(c.variant ? { variant: c.variant } : {}),
      }));
      const first = own[0];
      const single = own.length === 1 && first.single === true;
      const layers: CompiledLayer[] = overlays
        .filter((o) => (o.sceneId !== undefined ? o.sceneId === s.id : inScene(s.start, end)(o)))
        .map((o) => {
          const delay = sec(sub(o.start, s.start));
          const out = sec(sub(clipEnd(o), s.start));
          return {
            path: o.overlay.path ?? "",
            delay,
            anim: o.overlay.anim ?? "fade",
            ...(out < sec(s.duration) - 1e-6 ? { out } : {}),
            ...(o.overlay.video ? { video: true } : {}),
            ...(o.overlay.card ? { card: o.overlay.card } : {}),
          };
        });
      return {
        id: s.id,
        start: sec(s.start),
        end: sec(end),
        startFrame,
        endFrame,
        text: s.text,
        subject: s.subject,
        asset: single ? { path: shots[0].path, kind: shots[0].kind, source: shots[0].source, in: shots[0].in } : { path: shots[0].path, kind: shots[0].kind, source: shots[0].source, in: shots[0].in, shots },
        motion: first.motion,
        transition: first.transitionIn,
        ...(first.backdrop ? { backdrop: first.backdrop } : {}),
        overlays: layers,
        sfx: sfxClips.filter((c) => (c.sceneId !== undefined ? c.sceneId === s.id : inScene(s.start, end)(c))).map((c) => ({ kind: c.sfx, at: sec(sub(c.start, s.start)) })),
      };
    });

  const voices = clipsOf<AudioClip>("voiceover").filter((c) => c.kind === "audio").sort((a, b) => toNumber(a.start) - toNumber(b.start));
  const voice = voices[0];
  if (!voice) throw new Error("timeline has no voiceover clip");
  const cut = voices.length > 1 || sec(voice.media.sourceIn) !== 0 || sec(voice.start) !== 0;
  const music = clipsOf<AudioClip>("music").filter((c) => c.kind === "audio");
  const sfxSettings = tl.settings?.sfx ?? { enabled: true, gainDb: -14 };
  const totalFrames = scenes.length ? scenes[scenes.length - 1].endFrame : 0;
  return {
    fps: 30,
    width: tl.width,
    height: tl.height,
    duration: frameToSeconds(BigInt(totalFrames), fps),
    totalFrames,
    scenes,
    audio: {
      voice: voice.media.path,
      ...(cut ? { voiceParts: voices.map((v) => ({ in: sec(v.media.sourceIn), dur: sec(v.duration) })) } : {}),
      music: { files: music.map((m) => m.media.path), volumeDb: music[0]?.gainDb ?? -18 },
      sfx: { enabled: sfxSettings.enabled, gainDb: sfxSettings.gainDb, events: sfxClips.map((c) => ({ kind: c.sfx, at: sec(c.start) })) },
    },
    captions: tl.settings?.captions ?? { enabled: false },
    logo: tl.settings?.logo ?? null,
  };
}

/** The first `frames` frames of a compiled timeline (quick previews: render --limit). */
export function limitFrames(c: CompiledTimeline, frames: number): CompiledTimeline {
  if (frames >= c.totalFrames) return c;
  const scenes = c.scenes.filter((s) => s.startFrame < frames).map((s) => (s.endFrame > frames ? { ...s, endFrame: frames, end: frames / c.fps } : s));
  const total = scenes.length ? scenes[scenes.length - 1].endFrame : 0;
  return { ...c, scenes, totalFrames: total, duration: frameToSeconds(BigInt(total), FPS_30) };
}
