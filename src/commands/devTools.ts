import fs from "node:fs";
import path from "node:path";
import { alignTokens } from "../lib/align.js";
import { loadGlossary } from "../lib/glossary.js";
import { run } from "../lib/exec.js";
import { paths } from "../lib/paths.js";
import { projectDir, readJson, writeJson } from "../lib/project.js";
import { norm, tokenize } from "../lib/text.js";
import { ffmpegPath, venvPythonPath } from "../lib/tools.js";
import type { Aligned } from "./align.js";

/** Dev-only: builds inputs/test/ with a synthetic voiceover + ground-truth timings. */
export async function makeTestAudio(opts: { minutes: string; outDir?: string }): Promise<number> {
  const py = venvPythonPath();
  const ff = ffmpegPath();
  if (!py || !ff) {
    console.error("Need project venv and FFmpeg. Run `clipforge doctor`.");
    return 1;
  }
  const outDir = path.resolve(opts.outDir ?? path.join(paths.inputs, "test"));
  const r = await run(
    py,
    [
      path.join(paths.root, "tools", "make_test_voiceover.py"),
      "--glossary", path.join(paths.inputs, "glossary.txt"),
      "--out-dir", outDir,
      "--ffmpeg", ff,
      "--minutes", opts.minutes,
    ],
    { echo: true },
  );
  return r.code;
}

interface Truth {
  duration: number;
  sentences: { id: number; text: string; start: number; end: number }[];
}

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Dev-only: compares aligned.json sentence timings against truth.json. Pass = p95 start error < 0.3s. */
export async function evalDrift(opts: { project: string; truth: string }): Promise<number> {
  const dir = projectDir(opts.project);
  const aligned = readJson<Aligned>(path.join(dir, "aligned.json"));
  const truth = readJson<Truth>(path.resolve(opts.truth));

  const tTokens: { norm: string; sentence: number; first: boolean; last: boolean }[] = [];
  for (const s of truth.sentences) {
    const toks = tokenize(s.text);
    toks.forEach((t, k) => tTokens.push({ norm: norm(t), sentence: s.id, first: k === 0, last: k === toks.length - 1 }));
  }
  const pairs = alignTokens(tTokens.map((t) => t.norm), aligned.words.map((w) => norm(w.word)));

  const startErr: { t: number; err: number; id: number }[] = [];
  const endErr: number[] = [];
  let exact = 0;
  for (const p of pairs) {
    if (p.a < 0) continue;
    if (p.b >= 0 && p.kind === "match") exact++;
    if (p.b < 0 || p.kind !== "match") continue;
    const tt = tTokens[p.a];
    const s = truth.sentences[tt.sentence];
    const w = aligned.words[p.b];
    if (tt.first) startErr.push({ t: s.start, err: w.start - s.start, id: s.id });
    if (tt.last) endErr.push(w.end - s.end);
  }

  const abs = startErr.map((e) => Math.abs(e.err)).sort((a, b) => a - b);
  const absEnd = endErr.map(Math.abs).sort((a, b) => a - b);
  const tenth = Math.max(1, Math.floor(startErr.length / 10));
  const meanAbs = (xs: { err: number }[]) => xs.reduce((s, e) => s + Math.abs(e.err), 0) / xs.length;

  // Product-name spelling check: how often each glossary term appears in truth vs output.
  const truthText = truth.sentences.map((s) => s.text).join(" ");
  const outText = aligned.words.map((w) => w.word).join(" ");
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  const terms = loadGlossary(path.join(paths.inputs, "glossary.txt"))
    .map((g) => ({ term: g, truth: count(truthText, g), output: count(outText, g) }))
    .filter((x) => x.truth > 0);
  const termHits = terms.reduce((s, x) => s + Math.min(x.truth, x.output), 0);
  const termTotal = terms.reduce((s, x) => s + x.truth, 0);

  const report = {
    mode: aligned.mode,
    audioMinutes: r3(truth.duration / 60),
    sentencesTotal: truth.sentences.length,
    sentencesMeasured: startErr.length,
    wordAccuracyPct: r3((100 * exact) / tTokens.length),
    productNamesCorrect: `${termHits}/${termTotal}`,
    start: {
      meanAbs: r3(meanAbs(startErr)),
      median: r3(pct(abs, 50)),
      p95: r3(pct(abs, 95)),
      max: r3(abs[abs.length - 1]),
      bias: r3(startErr.reduce((s, e) => s + e.err, 0) / startErr.length),
      within300msPct: r3((100 * abs.filter((x) => x < 0.3).length) / abs.length),
      first10pctMeanAbs: r3(meanAbs(startErr.slice(0, tenth))),
      last10pctMeanAbs: r3(meanAbs(startErr.slice(-tenth))),
    },
    end: { median: r3(pct(absEnd, 50)), p95: r3(pct(absEnd, 95)) },
    terms,
    worst: [...startErr]
      .sort((a, b) => Math.abs(b.err) - Math.abs(a.err))
      .slice(0, 12)
      .map((e) => ({ at: r3(e.t), err: r3(e.err), text: truth.sentences[e.id].text.slice(0, 70) })),
    pass: pct(abs, 95) < 0.3,
  };
  writeJson(path.join(dir, "drift_report.json"), report);

  console.log(`\nDrift report (${report.mode} mode, ${report.audioMinutes} min)`);
  console.log(`  sentences measured     ${report.sentencesMeasured}/${report.sentencesTotal}`);
  console.log(`  word accuracy          ${report.wordAccuracyPct}%`);
  console.log(`  product names correct  ${report.productNamesCorrect}`);
  console.log(`  start error  mean ${report.start.meanAbs}s | median ${report.start.median}s | p95 ${report.start.p95}s | max ${report.start.max}s | bias ${report.start.bias}s`);
  console.log(`  within 0.3s            ${report.start.within300msPct}%`);
  console.log(`  drift trend            first 10% ${report.start.first10pctMeanAbs}s -> last 10% ${report.start.last10pctMeanAbs}s`);
  console.log(`  end error    median ${report.end.median}s | p95 ${report.end.p95}s`);
  console.log(`\nM1 drift check: ${report.pass ? "PASS" : "FAIL"} (p95 start error < 0.3s)`);
  return report.pass ? 0 : 1;
}
