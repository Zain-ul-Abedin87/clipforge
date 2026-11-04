import fs from "node:fs";
import path from "node:path";
import { paths } from "../paths.js";
import type { ThumbResult } from "./thumbnails.js";

/** Thumbnail concepts for a project: its title, channel brief, format, and the last scan's outliers. */
export async function projectThumbnails(project: string, o: { title?: string; log?: (m: string) => void; fetchImpl?: typeof fetch } = {}): Promise<ThumbResult> {
  const dir = path.join(paths.workspace, project);
  if (!fs.existsSync(dir)) throw new Error(`no project ${project}`);
  const pj = path.join(dir, "project.json");
  const cj = path.join(dir, "pipeline.json");
  const p = fs.existsSync(pj) ? (JSON.parse(fs.readFileSync(pj, "utf8")) as { title?: string; channel?: string }) : {};
  const c = fs.existsSync(cj) ? (JSON.parse(fs.readFileSync(cj, "utf8")) as { topic?: string; channel?: string; format?: string }) : {};
  const title = (o.title ?? p.title ?? c.topic ?? "").trim();
  if (!title) throw new Error("The project has no title yet.");
  const { lastResearch } = await import("../research/index.js");
  const { loadBrief } = await import("../channelBrief.js");
  const { pickRefs, thumbnailConcepts } = await import("./thumbnails.js");
  const outliers = lastResearch()?.outliers ?? [];
  if (!outliers.length) o.log?.("[thumbnails] no research scan yet: concepts from the title alone (run a scan on the Research page for competitor references)");
  return thumbnailConcepts({ dir, title, refs: pickRefs(title, outliers), brief: loadBrief(c.channel ?? p.channel), format: c.format, log: o.log, fetchImpl: o.fetchImpl });
}

export function readThumbnails(project: string): ThumbResult | null {
  const f = path.join(paths.workspace, project, "thumbnail_concepts.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as ThumbResult) : null;
}
