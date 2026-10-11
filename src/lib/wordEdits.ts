import fs from "node:fs";
import path from "node:path";

/** Caption/transcript corrections made in the review page, keyed by word start time. */
export type WordEdits = Record<string, { from: string; to: string }>;

const file = (dir: string) => path.join(dir, "word_edits.json");
const key = (start: number) => start.toFixed(2);

export function loadWordEdits(dir: string): WordEdits {
  return fs.existsSync(file(dir)) ? JSON.parse(fs.readFileSync(file(dir), "utf8").replace(/^﻿/, "")) : {};
}

export function saveWordEdit(dir: string, start: number, from: string, to: string): void {
  const edits = loadWordEdits(dir);
  if (to === from) delete edits[key(start)];
  else edits[key(start)] = { from: edits[key(start)]?.from ?? from, to };
  fs.writeFileSync(file(dir), JSON.stringify(edits, null, 1));
}

/**
 * Re-applies edits after the align step rebuilt the words. A word is matched by start time
 * (to 10 ms) and its original spelling, so an edit never lands on a different word.
 */
export function applyWordEdits<T extends { word: string; start: number; edited?: boolean }>(dir: string, words: T[]): number {
  const edits = loadWordEdits(dir);
  let n = 0;
  for (const w of words) {
    const e = edits[key(w.start)];
    if (e && (w.word === e.from || w.word === e.to)) {
      w.word = e.to;
      w.edited = true;
      n++;
    }
  }
  return n;
}
