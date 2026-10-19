import { toNumber } from "../domain/rational.math.js";
import { AudioClip, MultiTrackTimeline } from "../domain/timeline.types.js";
import { remapWords } from "./render/captions.js";

/**
 * Transcript editing: the spoken words on the timeline's clock, and the cuts that remove words or
 * tighten pauses. Word times come from aligned.json (time in the voice file); after parts of the
 * voice were cut out in the studio they are re-timed like the captions are, and words inside a cut
 * part are gone. Pure functions: the editor API turns the ranges they return into `cutRange` edits.
 */

export interface TranscriptWord {
  text: string;
  startFrame: number;
  endFrame: number;
}

/** A pause between two words (or before the first one) that is long enough to tighten. */
export interface Pause {
  /** Index of the word the pause comes after (-1: before the first word). */
  afterWord: number;
  startFrame: number;
  endFrame: number;
  /** The part to remove: the pause minus the silence that is kept. */
  cutFrom: number;
  cutTo: number;
}

/** The voice file's pieces on the timeline, in order: {seconds into the file, seconds long}. */
export function voiceParts(tl: MultiTrackTimeline): { in: number; dur: number }[] {
  return tl.tracks
    .filter((t) => t.kind === "voiceover" && !t.muted)
    .flatMap((t) => t.clips)
    .filter((c): c is AudioClip => c.kind === "audio")
    .sort((a, b) => toNumber(a.start) - toNumber(b.start))
    .map((c) => ({ in: toNumber(c.media.sourceIn), dur: toNumber(c.duration) }));
}

/**
 * A word's start frame is rounded DOWN: a cut that begins at that frame then starts at or before the
 * word's real start, so the word is inside the cut part (remapWords drops words by their real start)
 * and a cut that ends at the next word's frame never swallows it.
 */
export function transcriptWords(tl: MultiTrackTimeline, aligned: { word: string; start: number; end: number }[]): TranscriptWord[] {
  const fps = toNumber(tl.fps);
  return remapWords(aligned, voiceParts(tl)).map((w) => {
    const startFrame = Math.floor(w.start * fps + 1e-6);
    return { text: w.word, startFrame, endFrame: Math.max(startFrame + 1, Math.round(w.end * fps)) };
  });
}

/**
 * Pauses of at least `minGapSec`, each to be shortened to `keepSec`. The silence before the first
 * word counts; the tail after the last word does not (the video's end is left alone).
 */
export function findPauses(words: TranscriptWord[], fps: number, minGapSec: number, keepSec: number): Pause[] {
  const min = Math.max(1, Math.round(minGapSec * fps));
  const keep = Math.max(0, Math.round(keepSec * fps));
  const out: Pause[] = [];
  let prevEnd = 0;
  words.forEach((w, i) => {
    const gap = w.startFrame - prevEnd;
    if (gap >= min && gap - keep > 0) out.push({ afterWord: i - 1, startFrame: prevEnd, endFrame: w.startFrame, cutFrom: prevEnd + keep, cutTo: w.startFrame });
    prevEnd = Math.max(prevEnd, w.endFrame);
  });
  return out;
}

/**
 * The part of the timeline that deleting words `from..to` removes: from the first word's start to
 * the next word's start, so the pause that came before the deleted words stays and the next word
 * follows it directly. Deleting the first words also removes the silence before them, and deleting
 * the last words ends at their end.
 */
export function wordsCutRange(words: TranscriptWord[], from: number, to: number): { fromFrame: number; toFrame: number } {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= words.length) throw new RangeError(`word range ${from}..${to} is outside the transcript (${words.length} words)`);
  const fromFrame = from === 0 ? 0 : words[from].startFrame;
  const next = words[to + 1];
  return { fromFrame, toFrame: Math.max(fromFrame + 1, next ? next.startFrame : words[to].endFrame) };
}
