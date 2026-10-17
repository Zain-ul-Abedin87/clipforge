import fs from "node:fs";
import path from "node:path";
import { add, frameToSeconds, rat, Rational, secondsToFrame, sub, toNumber } from "../../domain/rational.math.js";
import { Clip, clipEnd, MultiTrackTimeline, OverlayClip, Provenance, timelineFromJson, timelineToJson, Track, Transition, validateTimeline, VideoClip, MediaRef } from "../../domain/timeline.types.js";
import { loadTimeline, V3_FILE, writeTimelineV3 } from "../../lib/compiler/timelineCompiler.js";

/**
 * Pre-render editing state of a project: the active v3 timeline, a revision number, undo / redo.
 *
 * Every edit is applied to a copy, snapped to the frame grid and validated (timeline rules + "each
 * scene's B-roll covers the scene exactly"); only then is it committed and written to
 * timeline.v3.json. A failing edit changes nothing. Edits name the revision they were made on
 * (optimistic concurrency), so two open tabs cannot silently overwrite each other.
 */

export class EditError extends Error {
  constructor(
    message: string,
    readonly code: "conflict" | "not_found" | "invalid" = "invalid",
  ) {
    super(message);
  }
}

/** Shortest B-roll / overlay piece an edit may leave (0.2 s / 0.1 s at 30 fps). */
const MIN_BROLL_FRAMES = 6;
const MIN_OVERLAY_FRAMES = 3;
const HISTORY = 50;

export type EditOp =
  | { op: "moveClip"; clipId: string; startFrame: number }
  | { op: "trimEnd"; clipId: string; endFrame: number }
  | { op: "splitClip"; clipId: string; atFrame: number }
  | { op: "deleteClip"; clipId: string }
  | { op: "replaceMedia"; clipId: string; media: { path: string; kind: "video" | "image"; sourceIn?: number }; provenance: Provenance }
  | { op: "setLocked"; clipId: string; locked: boolean }
  | { op: "setTransition"; clipId: string; transition: Transition }
  | { op: "cutRange"; fromFrame: number; toFrame: number };

const TRANSITIONS: Transition[] = ["cut", "fade", "flash"];

interface Session {
  dir: string;
  tl: MultiTrackTimeline;
  revision: number;
  /** v3 file mtime when loaded / last written (external changes are picked up). */
  mtime: number;
  undo: string[];
  redo: string[];
  /** Scenes edited since the last render request. */
  dirty: Set<number>;
}

const fps = (tl: MultiTrackTimeline) => tl.fps;
const f2s = (tl: MultiTrackTimeline, f: number) => frameToSeconds(BigInt(Math.round(f)), fps(tl));
const s2f = (tl: MultiTrackTimeline, t: Rational) => Number(secondsToFrame(t, fps(tl)));
const clone = (tl: MultiTrackTimeline) => timelineFromJson(timelineToJson(tl, 0));

export function findClip(tl: MultiTrackTimeline, clipId: string): { track: Track; clip: Clip; index: number } {
  for (const track of tl.tracks) {
    const index = track.clips.findIndex((c) => c.id === clipId);
    if (index >= 0) return { track, clip: track.clips[index], index };
  }
  throw new EditError(`no clip ${clipId}`, "not_found");
}

/** The scene's B-roll clips in time order. */
const sceneBroll = (tl: MultiTrackTimeline, sceneId: number) =>
  tl.tracks
    .filter((t) => t.kind === "broll")
    .flatMap((t) => t.clips)
    .filter((c): c is VideoClip => c.kind === "video" && c.sceneId === sceneId)
    .sort((a, b) => toNumber(a.start) - toNumber(b.start));

/** Every scene's B-roll starts at the scene start, has no gaps and ends at the scene end. */
export function coverageErrors(tl: MultiTrackTimeline): string[] {
  const errors: string[] = [];
  for (const s of tl.scenes) {
    const clips = sceneBroll(tl, s.id);
    if (!clips.length) {
      errors.push(`scene ${s.id}: no picture`);
      continue;
    }
    let at = s2f(tl, s.start);
    for (const c of clips) {
      if (s2f(tl, c.start) !== at) errors.push(`scene ${s.id}: gap or overlap at frame ${at}`);
      at = s2f(tl, clipEnd(c));
    }
    if (at !== s2f(tl, clipEnd(s))) errors.push(`scene ${s.id}: pictures end at frame ${at}, scene ends at ${s2f(tl, clipEnd(s))}`);
  }
  return errors;
}

/** Applies one operation to `tl` in place (callers pass a copy). Returns the scene ids it touched. */
export function applyOp(tl: MultiTrackTimeline, o: EditOp): number[] {
  if (o.op === "cutRange") return cutRange(tl, o.fromFrame, o.toFrame);
  const { track, clip, index } = findClip(tl, o.clipId);
  const total = s2f(tl, tl.duration);
  const start = s2f(tl, clip.start);
  const end = s2f(tl, clipEnd(clip));
  const touched = new Set<number>(clip.sceneId !== undefined ? [clip.sceneId] : []);
  if (clip.locked && o.op !== "setLocked") throw new EditError(`clip ${clip.id} is locked`);
  const sceneAt = (frame: number) => tl.scenes.find((s) => frame >= s2f(tl, s.start) && frame < s2f(tl, clipEnd(s)))?.id;

  switch (o.op) {
    case "setLocked":
      clip.locked = o.locked || undefined;
      break;

    case "moveClip": {
      if (track.kind === "broll" || track.kind === "voiceover") throw new EditError(`${track.kind} clips cannot be moved; drag the edge between pictures or replace the picture`);
      const len = end - start;
      const to = Math.max(0, Math.min(total - len, Math.round(o.startFrame)));
      clip.start = f2s(tl, to);
      clip.sceneId = sceneAt(to) ?? clip.sceneId;
      if (clip.sceneId !== undefined) touched.add(clip.sceneId);
      break;
    }

    case "trimEnd": {
      const to = Math.round(o.endFrame);
      if (track.kind === "broll") {
        // The edge between two pictures of one scene: the next picture starts later / earlier and
        // keeps showing the same moment of its source (its in-point moves with the edge).
        const list = sceneBroll(tl, clip.sceneId!);
        const k = list.findIndex((c) => c.id === clip.id);
        const next = list[k + 1];
        if (!next) throw new EditError("the last picture of a scene ends with the scene; trim its neighbour instead");
        const nextEnd = s2f(tl, clipEnd(next));
        if (to < start + MIN_BROLL_FRAMES || to > nextEnd - MIN_BROLL_FRAMES) throw new EditError(`edge must stay between frame ${start + MIN_BROLL_FRAMES} and ${nextEnd - MIN_BROLL_FRAMES}`);
        if (next.locked) throw new EditError(`clip ${next.id} is locked`);
        const delta = to - end;
        clip.duration = f2s(tl, to - start);
        next.start = f2s(tl, to);
        next.duration = f2s(tl, nextEnd - to);
        if (next.media.kind === "video") next.media.sourceIn = add(next.media.sourceIn, f2s(tl, delta));
        if (toNumber(next.media.sourceIn) < 0) throw new EditError("the next picture would start before its source begins");
      } else {
        if (track.kind === "voiceover" || track.kind === "music") throw new EditError(`${track.kind} cannot be trimmed here`);
        if (to < start + MIN_OVERLAY_FRAMES || to > total) throw new EditError(`end must be between frame ${start + MIN_OVERLAY_FRAMES} and ${total}`);
        clip.duration = f2s(tl, to - start);
      }
      break;
    }

    case "splitClip": {
      const at = Math.round(o.atFrame);
      const minLen = track.kind === "broll" ? MIN_BROLL_FRAMES : MIN_OVERLAY_FRAMES;
      if (at < start + minLen || at > end - minLen) throw new EditError(`split point must be between frame ${start + minLen} and ${end - minLen}`);
      const ids = new Set(tl.tracks.flatMap((t) => t.clips.map((c) => c.id)));
      let n = 1;
      while (ids.has(`${clip.id}_s${n}`)) n++;
      const right = clone({ ...tl, tracks: [{ ...track, clips: [clip] }] }).tracks[0].clips[0];
      right.id = `${clip.id}_s${n}`;
      right.start = f2s(tl, at);
      right.duration = f2s(tl, end - at);
      clip.duration = f2s(tl, at - start);
      if (right.kind === "video") {
        right.single = undefined;
        right.transitionIn = "cut";
        if (right.media.kind === "video") right.media.sourceIn = add(right.media.sourceIn, f2s(tl, at - start));
        (clip as VideoClip).single = undefined;
      }
      if (right.kind === "overlay" && (right as OverlayClip).overlay.video) throw new EditError("animated cards cannot be split");
      track.clips.splice(index + 1, 0, right);
      break;
    }

    case "deleteClip": {
      if (track.kind === "voiceover") throw new EditError("the voiceover cannot be deleted");
      if (track.kind === "broll") {
        // The neighbour in the same scene takes over the time (previous one extends, else the next one starts earlier).
        const list = sceneBroll(tl, clip.sceneId!);
        if (list.length === 1) throw new EditError("a scene needs a picture: replace it instead of deleting it");
        const k = list.findIndex((c) => c.id === clip.id);
        const prev = list[k - 1];
        const next = list[k + 1];
        if (prev) {
          if (prev.locked) throw new EditError(`clip ${prev.id} is locked`);
          prev.duration = f2s(tl, end - s2f(tl, prev.start));
        } else {
          if (next.locked) throw new EditError(`clip ${next.id} is locked`);
          const nextEnd = s2f(tl, clipEnd(next));
          if (next.media.kind === "video") next.media.sourceIn = sub(next.media.sourceIn, f2s(tl, s2f(tl, next.start) - start));
          if (toNumber(next.media.sourceIn) < 0) next.media.sourceIn = rat(0);
          next.start = f2s(tl, start);
          next.duration = f2s(tl, nextEnd - start);
          next.transitionIn = (clip as VideoClip).transitionIn;
        }
      }
      track.clips.splice(index, 1);
      break;
    }

    case "setTransition": {
      // The renderer plays a transition where a scene starts, so it lives on the scene's first picture.
      if (clip.kind !== "video" || clip.sceneId === undefined) throw new EditError("transitions are set on pictures (B-roll)");
      if (!TRANSITIONS.includes(o.transition)) throw new EditError(`transition must be one of ${TRANSITIONS.join(", ")}`);
      const first = sceneBroll(tl, clip.sceneId)[0];
      if (first.locked) throw new EditError(`clip ${first.id} is locked`);
      first.transitionIn = o.transition;
      // A fade-in also fades the previous scene's end out: that segment changes too.
      const prev = [...tl.scenes].sort((a, b) => toNumber(a.start) - toNumber(b.start)).filter((s) => toNumber(clipEnd(s)) <= toNumber(first.start)).pop();
      if (prev) touched.add(prev.id);
      break;
    }

    case "replaceMedia": {
      if (clip.kind !== "video") throw new EditError("only pictures (B-roll) can be replaced");
      if (!fs.existsSync(o.media.path)) throw new EditError("the new media file does not exist");
      const media: MediaRef = { path: o.media.path, kind: o.media.kind, sourceIn: o.media.kind === "video" ? f2s(tl, Math.round((o.media.sourceIn ?? 0) * toNumber(fps(tl)))) : rat(0) };
      clip.media = media;
      clip.provenance = o.provenance;
      clip.variant = undefined;
      break;
    }

    default:
      throw new EditError(`unknown edit "${(o as { op?: unknown }).op}"`);
  }
  return [...touched];
}

/**
 * Ripple delete (CapCut "cut out"): removes [fromFrame, toFrame) from every track - voice, pictures,
 * overlays, SFX, scenes - and pulls everything after it left. A clip that spans the cut keeps both
 * sides (voice and pictures become two pieces that resume later in the source).
 * Returns the scenes that were cut into (later scenes only shift).
 */
export function cutRange(tl: MultiTrackTimeline, fromFrame: number, toFrame: number): number[] {
  const total = s2f(tl, tl.duration);
  const a = Math.max(0, Math.round(Math.min(fromFrame, toFrame)));
  const b = Math.min(total, Math.round(Math.max(fromFrame, toFrame)));
  const len = b - a;
  if (len < 1) throw new EditError("mark a part to cut out first (In and Out points)");
  if (total - len < 30) throw new EditError("at least 1 second of video has to stay");
  const touched = new Set<number>();
  const ids = new Set(tl.tracks.flatMap((t) => t.clips.map((c) => c.id)));
  const freshId = (base: string) => {
    let n = 1;
    while (ids.has(`${base}_c${n}`)) n++;
    ids.add(`${base}_c${n}`);
    return `${base}_c${n}`;
  };
  const shiftSource = (c: Clip, frames: number) => {
    if ((c.kind === "video" || c.kind === "audio") && c.media.kind !== "image") c.media.sourceIn = add(c.media.sourceIn, f2s(tl, frames));
  };

  for (const track of tl.tracks) {
    // Voice and pictures continue after the cut as a second piece; cards, SFX, music just get shorter.
    const splits = track.kind === "voiceover" || track.kind === "broll";
    const out: Clip[] = [];
    for (const c of track.clips) {
      const s = s2f(tl, c.start);
      const e = s2f(tl, clipEnd(c));
      if (e <= a) out.push(c);
      else if (s >= b) {
        c.start = f2s(tl, s - len);
        out.push(c);
      } else if (s >= a && e <= b) continue; // entirely inside the cut
      else if (s < a && e > b) {
        if (splits) {
          const right = clone({ ...tl, tracks: [{ ...track, clips: [c] }] }).tracks[0].clips[0];
          right.id = freshId(c.id);
          right.start = f2s(tl, a);
          right.duration = f2s(tl, e - b);
          shiftSource(right, b - s);
          if (right.kind === "video") right.transitionIn = "cut";
          c.duration = f2s(tl, a - s);
          out.push(c, right);
        } else {
          c.duration = f2s(tl, e - s - len);
          out.push(c);
        }
      } else if (s < a) {
        c.duration = f2s(tl, a - s);
        out.push(c);
      } else {
        // Starts inside the cut, ends after it: keep the part after the cut.
        shiftSource(c, b - s);
        c.start = f2s(tl, a);
        c.duration = f2s(tl, e - b);
        out.push(c);
      }
    }
    track.clips = out;
  }

  const scenes: typeof tl.scenes = [];
  for (const sc of [...tl.scenes].sort((x, y) => toNumber(x.start) - toNumber(y.start))) {
    const s = s2f(tl, sc.start);
    const e = s2f(tl, clipEnd(sc));
    if (e <= a) scenes.push(sc);
    else if (s >= b) {
      sc.start = f2s(tl, s - len);
      scenes.push(sc);
    } else if (s >= a && e <= b) continue;
    else {
      touched.add(sc.id);
      const keep = (e - s) - (Math.min(e, b) - Math.max(s, a));
      sc.start = f2s(tl, s < a ? s : a);
      sc.duration = f2s(tl, keep);
      scenes.push(sc);
    }
  }
  tl.scenes = scenes;
  // Cards / SFX that now start in another scene belong to that scene (the renderer groups by scene).
  for (const track of tl.tracks) {
    if (track.kind === "broll" || track.kind === "voiceover" || track.kind === "music") continue;
    for (const c of track.clips) {
      const f = s2f(tl, c.start);
      const sc = scenes.find((s) => f >= s2f(tl, s.start) && f < s2f(tl, clipEnd(s)));
      if (sc && c.sceneId !== undefined) c.sceneId = sc.id;
    }
  }
  tl.duration = f2s(tl, total - len);
  return [...touched];
}

export class ProjectStore {
  private sessions = new Map<string, Session>();

  constructor(private readonly dirOf: (project: string) => string) {}

  /** The project's session, (re)loaded from disk when the v3 file changed outside the editor. */
  open(project: string): Session {
    const dir = this.dirOf(project);
    const file = path.join(dir, V3_FILE);
    const cur = this.sessions.get(project);
    const mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
    if (cur && cur.mtime === mtime) return cur;
    const loaded = loadTimeline(dir);
    if (!loaded) throw new EditError(`project ${project} has no timeline yet - run the pipeline through the timeline step`, "not_found");
    // Older projects: create the v3 file so edits have a home.
    if (loaded.source === "v2") writeTimelineV3(dir, loaded.tl);
    const s: Session = { dir, tl: loaded.tl, revision: (cur?.revision ?? 0) + 1, mtime: fs.statSync(file).mtimeMs, undo: [], redo: [], dirty: cur?.dirty ?? new Set() };
    this.sessions.set(project, s);
    return s;
  }

  get(project: string): { revision: number; tl: MultiTrackTimeline; canUndo: boolean; canRedo: boolean; dirty: number[] } {
    const s = this.open(project);
    return { revision: s.revision, tl: s.tl, canUndo: s.undo.length > 0, canRedo: s.redo.length > 0, dirty: [...s.dirty].sort((a, b) => a - b) };
  }

  /** Applies edits atomically (all or nothing) on `baseRevision`; returns the new revision. */
  apply(project: string, baseRevision: number | null, ops: EditOp[]): { revision: number; touched: number[] } {
    const s = this.open(project);
    if (baseRevision !== null && baseRevision !== s.revision) throw new EditError(`timeline changed (revision ${s.revision}, edit was made on ${baseRevision}) - reload`, "conflict");
    if (!ops.length) return { revision: s.revision, touched: [] };
    const next = clone(s.tl);
    const touched = new Set<number>();
    for (const o of ops) for (const id of applyOp(next, o)) touched.add(id);
    const errors = [...validateTimeline(next), ...coverageErrors(next)];
    if (errors.length) throw new EditError(`edit rejected: ${errors.slice(0, 3).join("; ")}`);
    this.commit(s, next);
    for (const id of touched) s.dirty.add(id);
    return { revision: s.revision, touched: [...touched] };
  }

  undo(project: string, baseRevision: number | null): number {
    return this.step(project, baseRevision, "undo");
  }

  redo(project: string, baseRevision: number | null): number {
    return this.step(project, baseRevision, "redo");
  }

  /** Scenes edited since the last call (the render request clears them). */
  takeDirty(project: string): number[] {
    const s = this.open(project);
    const out = [...s.dirty].sort((a, b) => a - b);
    s.dirty.clear();
    return out;
  }

  private step(project: string, baseRevision: number | null, dir: "undo" | "redo"): number {
    const s = this.open(project);
    if (baseRevision !== null && baseRevision !== s.revision) throw new EditError(`timeline changed (revision ${s.revision}) - reload`, "conflict");
    const from = dir === "undo" ? s.undo : s.redo;
    const to = dir === "undo" ? s.redo : s.undo;
    const snap = from.pop();
    if (!snap) throw new EditError(`nothing to ${dir}`);
    to.push(timelineToJson(s.tl, 0));
    const tl = timelineFromJson(snap);
    // Undo / redo can touch any scene: mark the scenes whose pictures differ.
    for (const sc of tl.scenes) if (timelineToJson({ ...tl, tracks: tl.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.sceneId === sc.id) })) }, 0) !== timelineToJson({ ...s.tl, tracks: s.tl.tracks.map((t) => ({ ...t, clips: t.clips.filter((c) => c.sceneId === sc.id) })) }, 0)) s.dirty.add(sc.id);
    this.write(s, tl);
    return s.revision;
  }

  private commit(s: Session, next: MultiTrackTimeline): void {
    s.undo.push(timelineToJson(s.tl, 0));
    if (s.undo.length > HISTORY) s.undo.shift();
    s.redo = [];
    this.write(s, next);
  }

  private write(s: Session, tl: MultiTrackTimeline): void {
    const file = writeTimelineV3(s.dir, tl);
    s.tl = tl;
    s.revision++;
    s.mtime = fs.statSync(file).mtimeMs;
  }
}
