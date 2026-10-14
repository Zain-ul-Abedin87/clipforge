import fs from "node:fs";
import path from "node:path";
import { env } from "../env.js";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { ffmpegPath, venvPythonPath } from "../tools.js";
import { verifyCandidates, visionVerifyEnabled } from "../agent/visionVerify.js";
import type { PoolShot } from "./productPool.js";

/**
 * Per-shot QA (python/shot_qa.py): PySceneDetect AdaptiveDetector cuts every file into shots,
 * CLIP labels each shot (close-up / talking / range / hands / table / text) and the auto-editor
 * motion score marks static stretches. Used twice:
 * - filterPoolByShotQa: talking-head and frozen pool shots are dropped before pacing, unsure shots
 *   are asked to Claude (Haiku), and every kept shot carries its motion curve so pacing can avoid
 *   static 2-3 s windows.
 * - the QA step runs it on the rendered video to count close-ups and catch repeated segments.
 * SHOT_QA=off disables it. Results are cached per file in cache/shot_qa.
 */

export interface QaShot {
  start: number;
  end: number;
  label: string;
  verdict: "talking" | "static" | "text" | "closeup" | "uncertain" | "accept";
  probs: Record<string, number>;
  moving: number;
  face: boolean;
  edge: number;
  frames: string[];
  emb?: number[];
}
export interface QaFile {
  duration: number;
  shots: QaShot[];
  motion_fps?: number;
  motion?: number[];
  talking_share: number;
  static_share: number;
  closeup_share: number;
  error?: string;
}

export const shotQaEnabled = () => env("SHOT_QA", "on").toLowerCase() !== "off" && !!venvPythonPath() && fs.existsSync(path.join(paths.python, "shot_qa.py"));

export async function runShotQa(files: { key: string; path: string }[], category: string, log: (m: string) => void, embeddings = true): Promise<Record<string, QaFile> | null> {
  const py = venvPythonPath();
  if (!py || !files.length) return null;
  const tmp = path.join(paths.root, "cache", "shot_qa");
  fs.mkdirSync(tmp, { recursive: true });
  const stamp = `${process.pid}_${Date.now()}`;
  const jobFile = path.join(tmp, `job_${stamp}.json`);
  const outFile = path.join(tmp, `out_${stamp}.json`);
  fs.writeFileSync(jobFile, JSON.stringify({ category, files, cache_dir: tmp, min_scene_len: 12, embeddings }));
  const r = await run(py, [path.join(paths.python, "shot_qa.py"), "--job", jobFile, "--out", outFile, "--models-dir", path.join(paths.root, "models", "fastembed"), "--ffmpeg", ffmpegPath() ?? "ffmpeg"], { timeoutMs: 60 * 60_000 });
  fs.rmSync(jobFile, { force: true });
  if (r.code !== 0 || !fs.existsSync(outFile)) {
    log(`[shot-qa] failed: ${(r.stderr.trim().split("\n").pop() ?? "").slice(0, 200)}`);
    return null;
  }
  const res = JSON.parse(fs.readFileSync(outFile, "utf8")) as { files: Record<string, QaFile> };
  fs.rmSync(outFile, { force: true });
  return res.files;
}

/** Share of moving frames (> 2 % pixels changed) in [t, t+len) of a motion curve. */
export function movingShare(motion: number[] | undefined, fps: number, t: number, len: number): number {
  if (!motion?.length) return 1;
  const a = Math.max(1, Math.floor(t * fps));
  const b = Math.min(motion.length, Math.ceil((t + len) * fps));
  if (b - a < 2) return 1;
  let n = 0;
  for (let i = a; i < b; i++) if (motion[i] > 0.02) n++;
  return n / (b - a);
}

/** Drops talking heads / frozen shots from the product pool; attaches motion curves for pacing. */
export async function filterPoolByShotQa(pool: PoolShot[], category: string, log: (m: string) => void): Promise<PoolShot[]> {
  if (!shotQaEnabled() || !pool.length) return pool;
  const t0 = Date.now();
  const res = await runShotQa(pool.map((p) => ({ key: p.id, path: p.path })), category, log, false);
  if (!res) return pool;
  const unsure: PoolShot[] = [];
  const keep: PoolShot[] = [];
  let talking = 0, frozen = 0;
  for (const p of pool) {
    const q = res[p.id];
    if (!q || q.error || !q.shots.length) {
      keep.push(p);
      continue;
    }
    const tot = q.shots.reduce((s, x) => s + (x.end - x.start), 0) || 1;
    const share = (pred: (x: QaShot) => boolean) => q.shots.filter(pred).reduce((s, x) => s + (x.end - x.start), 0) / tot;
    const moving = q.shots.reduce((s, x) => s + x.moving * (x.end - x.start), 0) / tot;
    const shot = Object.assign(p, { motion: q.motion, motionFps: q.motion_fps ?? 10, qaLabel: q.shots[0].label });
    if (q.talking_share >= 0.5) {
      talking++;
      continue;
    }
    // Frozen: almost nothing moves over the whole file (a tripod close-up that still breathes passes).
    if (moving < 0.2) {
      frozen++;
      continue;
    }
    if (q.closeup_share >= 0.5) shot.shotType = "closeup";
    if (share((x) => x.verdict === "uncertain") >= 0.5) unsure.push(shot);
    keep.push(shot);
  }
  // Unsure shots: one yes/no question to Claude (cached in cache/shot_qa/vision.json).
  let haikuDropped = 0;
  if (unsure.length && visionVerifyEnabled()) {
    const items = unsure.map((p, k) => ({
      sceneId: k,
      text: `Footage that clearly shows a ${category || "product"} itself (handled, fired or in close-up). A person talking to the camera, a title card or no ${category || "product"} = fits false.`,
      before: "",
      cands: [{ id: p.id, frames: res[p.id].shots.flatMap((x) => x.frames).slice(0, 3) }],
    }));
    const verdicts = await verifyCandidates(items, `${category} product footage`, path.join(paths.root, "cache", "shot_qa", "vision.json"), log);
    for (const [k, p] of unsure.entries()) {
      if (verdicts.get(`${k}|${p.id}`) === false) {
        keep.splice(keep.indexOf(p), 1);
        haikuDropped++;
      }
    }
  }
  log(`[shot-qa] pool: ${pool.length} -> ${keep.length} shots (${talking} talking-head, ${frozen} frozen, ${haikuDropped} rejected by Claude of ${unsure.length} unsure), ${Math.round((Date.now() - t0) / 1000)} s`);
  return keep;
}

const cos = (a: number[], b: number[]) => {
  let s = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) (s += a[i] * b[i]), (na += a[i] * a[i]), (nb += b[i] * b[i]);
  return s / Math.sqrt(na * nb || 1);
};

export interface RenderedShotStats {
  shots: number;
  avgShot: number;
  cutsPerMin: number;
  closeupShare: number;
  talking: { start: number; end: number; p: number }[];
  statics: { start: number; end: number }[];
  repeats: { a: number; b: number; sim: number }[];
}

/**
 * Shot stats of a finished video. Repeats: two non-neighbouring shots (both >= 0.6 s, not text
 * cards) whose CLIP embeddings are > 0.97 alike (0.95 flagged different hands-on shots of the same gun). `skip` masks card stretches (seconds).
 */
export function renderedStats(q: QaFile, skip: (t: number) => boolean): RenderedShotStats {
  const shots = q.shots;
  const dur = q.duration || shots.reduce((s, x) => Math.max(s, x.end), 0);
  const real = shots.filter((x) => !skip((x.start + x.end) / 2));
  const tot = real.reduce((s, x) => s + (x.end - x.start), 0) || 1;
  const repeats: RenderedShotStats["repeats"] = [];
  const usable = real.filter((x) => x.end - x.start >= 0.6 && x.verdict !== "text" && x.emb);
  for (let i = 0; i < usable.length; i++)
    for (let j = i + 2; j < usable.length; j++) {
      const sim = cos(usable[i].emb!, usable[j].emb!);
      if (sim > 0.97) repeats.push({ a: usable[i].start, b: usable[j].start, sim: Math.round(sim * 1000) / 1000 });
    }
  return {
    shots: shots.length,
    avgShot: dur / Math.max(1, shots.length),
    cutsPerMin: (shots.length - 1) / (dur / 60 || 1),
    closeupShare: real.filter((x) => x.verdict === "closeup").reduce((s, x) => s + (x.end - x.start), 0) / tot,
    talking: real.filter((x) => x.verdict === "talking" && x.end - x.start >= 0.6).map((x) => ({ start: x.start, end: x.end, p: x.probs.talking })),
    statics: real.filter((x) => x.verdict === "static" && x.end - x.start >= 2).map((x) => ({ start: x.start, end: x.end })),
    repeats,
  };
}
