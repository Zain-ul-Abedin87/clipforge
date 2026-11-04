import fs from "node:fs";
import path from "node:path";
import { paths } from "../lib/paths.js";
import { projectDir, readJson, writeJson } from "../lib/project.js";
import { loadFeatures } from "../lib/settings/features.js";
import { remapWords } from "../lib/render/captions.js";
import { compileTimeline, loadTimeline } from "../lib/compiler/timelineCompiler.js";
import { pickShorts, TimedSentence } from "../lib/shorts/pick.js";
import { renderShort } from "../lib/shorts/render.js";
import type { Aligned } from "./align.js";

/**
 * Step "shorts" (after render): N (default 3) vertical Shorts of 30-58 s cut from the finished
 * video at the best self-contained moments, with word-highlight captions. Writes
 * output/<project>_short_<n>.mp4 and <project>/shorts.json (windows, scores, titles).
 */
export async function shorts(opts: { project: string; video?: string }, log: (m: string) => void = console.log): Promise<number> {
  const dir = projectDir(opts.project);
  const cfg = loadFeatures().shorts;
  const video = opts.video ?? path.join(paths.output, `${opts.project}.mp4`);
  if (!fs.existsSync(video)) {
    log(`[shorts] ${video} missing. Run render first.`);
    return 1;
  }
  const alignedFile = path.join(dir, "aligned.json");
  if (!fs.existsSync(alignedFile)) {
    log(`[shorts] aligned.json missing (word timings are needed to cut on sentences and for captions).`);
    return 1;
  }
  const aligned = readJson<Aligned>(alignedFile);
  // Voice-file time -> video time (editor cuts in the voice track).
  let parts: { in: number; dur: number }[] | undefined;
  try {
    const t = loadTimeline(dir);
    parts = t ? compileTimeline(t.tl).audio.voiceParts : undefined;
  } catch {
    parts = undefined;
  }
  const words = remapWords(aligned.words, parts);
  const sentences: TimedSentence[] = (aligned.sentences ?? [])
    .map((s) => {
      const ws = words.filter((w) => w.start >= s.start - 0.01 && w.start < s.end + 0.01);
      return ws.length ? { text: s.text, start: ws[0].start, end: ws[ws.length - 1].end } : null;
    })
    .filter((s): s is TimedSentence => !!s);
  const maxSec = Math.min(cfg.maxSec, 59);
  const picks = await pickShorts(sentences, { count: cfg.count, minSec: cfg.minSec, maxSec, log });
  const made: { file: string; seconds: number; start: number; end: number; score: number; title?: string; hook: string }[] = [];
  for (const [i, w] of picks.entries()) {
    const out = path.join(paths.output, `${opts.project}_short_${i + 1}.mp4`);
    const t0 = Date.now();
    const r = await renderShort(video, w, words, out, { captions: cfg.captions, preset: "bold-pop", maxSec });
    made.push({ file: r.file, seconds: r.seconds, start: w.start, end: w.end, score: w.score, title: w.title, hook: w.hook });
    log(`[shorts] ${path.basename(out)}: ${r.seconds.toFixed(1)} s (9:16${cfg.captions ? ", captions" : ""}) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  writeJson(path.join(dir, "shorts.json"), { video, shorts: made });
  log(`[shorts] ${made.length}/${cfg.count} Short(s) written to ${paths.output}`);
  return made.length === cfg.count ? 0 : 2;
}
