/**
 * Caption lines in frames, for the Remotion caption component (cards/src/Captions.tsx) and the
 * studio preview. Shared by Node and the browser bundle: no imports.
 *
 * Sync target: every word is highlighted within +-100 ms of when it is spoken (align timings).
 * A frame at 30 fps is 33 ms, so rounding to the nearest frame keeps the error <= 17 ms.
 */

export interface TimedWord {
  text: string;
  start: number;
  end: number;
}
export interface TimedLine {
  start: number;
  end: number;
  text: string;
  words?: TimedWord[];
}

export interface FrameWord {
  text: string;
  startFrame: number;
  endFrame: number;
}
export interface FrameLine {
  startFrame: number;
  endFrame: number;
  text: string;
  words?: FrameWord[];
}

export function toFrameLines(lines: TimedLine[], fps: number, offsetSec = 0): FrameLine[] {
  const f = (sec: number) => Math.round((sec - offsetSec) * fps);
  return lines.map((l) => ({
    startFrame: f(l.start),
    endFrame: Math.max(f(l.start) + 1, f(l.end)),
    text: l.text,
    ...(l.words ? { words: l.words.map((w) => ({ text: w.text, startFrame: f(w.start), endFrame: Math.max(f(w.start) + 1, f(w.end)) })) } : {}),
  }));
}

/** Index of the word highlighted at `frame` (the last word that has started), or -1 before the first. */
export function activeWord(line: FrameLine, frame: number): number {
  const ws = line.words ?? [];
  let k = -1;
  for (let i = 0; i < ws.length; i++) if (frame >= ws[i].startFrame) k = i;
  return k;
}

/**
 * Largest gap (ms) between when a word is spoken and the frame its highlight starts, over all
 * words. QA / tests require <= 100 ms.
 */
export function maxHighlightErrorMs(lines: TimedLine[], frames: FrameLine[], fps: number, offsetSec = 0): number {
  let worst = 0;
  lines.forEach((l, i) => {
    (l.words ?? []).forEach((w, k) => {
      const fw = frames[i]?.words?.[k];
      if (!fw) return;
      worst = Math.max(worst, Math.abs(fw.startFrame / fps + offsetSec - w.start) * 1000);
    });
  });
  return Math.round(worst * 10) / 10;
}
