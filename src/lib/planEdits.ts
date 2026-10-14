import fs from "node:fs";
import path from "node:path";
import type { Scene } from "./scenes.js";

/**
 * Footage searches the user changed in the plan review, keyed by scene start time. A re-planned
 * scene gets its edit back only when it still starts at the same moment with the same words.
 */
export type PlanEdits = Record<string, { text: string; queries: string[]; original: string[] }>;

const file = (dir: string) => path.join(dir, "plan_edits.json");
const key = (start: number) => start.toFixed(2);

export function loadPlanEdits(dir: string): PlanEdits {
  return fs.existsSync(file(dir)) ? JSON.parse(fs.readFileSync(file(dir), "utf8").replace(/^﻿/, "")) : {};
}

/** Cleans what the user typed: trimmed, de-duplicated, at most 4 searches of 80 characters. */
export function cleanQueries(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : String(raw ?? "").split(/[,\n]/);
  return [...new Set(list.map((q) => String(q).trim().slice(0, 80)).filter(Boolean))].slice(0, 4);
}

/** Saves one scene's searches (empty list = undo the edit) and updates scenes.json in place. */
export function savePlanEdit(dir: string, sceneId: number, queries: string[]): Scene {
  const scenesFile = path.join(dir, "scenes.json");
  const scenes = JSON.parse(fs.readFileSync(scenesFile, "utf8").replace(/^﻿/, "")) as Scene[];
  const s = scenes[sceneId];
  if (!s) throw new Error("no such scene");
  if (s.type === "graphic") throw new Error("graphic cards have no footage search");
  const edits = loadPlanEdits(dir);
  const prev = edits[key(s.start)];
  const original = prev?.original ?? s.queries;
  if (queries.length) {
    edits[key(s.start)] = { text: s.text, queries, original };
    s.queries = queries;
    s.edited = true;
  } else {
    delete edits[key(s.start)];
    s.queries = original;
    delete s.edited;
  }
  fs.writeFileSync(file(dir), JSON.stringify(edits, null, 1));
  fs.writeFileSync(scenesFile, JSON.stringify(scenes, null, 1));
  return s;
}

/** Re-applies saved edits after the plan step rebuilt the scenes. */
export function applyPlanEdits(dir: string, scenes: Scene[]): number {
  const edits = loadPlanEdits(dir);
  let n = 0;
  for (const s of scenes) {
    const e = edits[key(s.start)];
    if (e && e.text === s.text && s.type !== "graphic") {
      s.queries = e.queries;
      s.edited = true;
      n++;
    }
  }
  return n;
}
