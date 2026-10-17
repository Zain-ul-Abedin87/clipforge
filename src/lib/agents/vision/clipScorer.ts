import fs from "node:fs";
import path from "node:path";
import { env } from "../../env.js";
import { run } from "../../exec.js";
import { paths } from "../../paths.js";
import { venvPythonPath } from "../../tools.js";

/**
 * CLIP shot filter (python/clip_score.py, local ONNX model). Each frame is scored against positive
 * prompts (the product on screen) and negative prompts (talking heads, logos, title cards); a shot
 * is kept when its best positive beats its worst negative.
 *
 * Profiles:
 *  - machine: one strict "machine in action" prompt; every presenter-like frame is rejected
 *    (walkaround B-roll of mowers, cars, tools).
 *  - handson (relaxed): several product prompts including hands holding / using it; hands on the
 *    product are fine, only faces talking to camera, logos and title cards are rejected
 *    (gadget close-ups, caption-keyword clips).
 */

export type ScoringProfile = "machine" | "handson";
export const SCORING_PROFILES: ScoringProfile[] = ["machine", "handson"];

export interface ShotThresholds {
  /** Minimum CLIP similarity to the (best) positive prompt. */
  minPositive: number;
  /** A negative score this high rejects the shot outright. */
  maxNegative: number;
  /** The positive must beat the worst negative by this much. */
  margin: number;
}

const num = (name: string, d: number) => {
  const raw = env(name, "");
  const v = Number(raw);
  return raw !== "" && Number.isFinite(v) ? v : d;
};

/**
 * machine: calibrated on real frames (dealer talking beside the mower, channel cartoon logo vs.
 * walkaround B-roll). handson: calibrated on the same frames with the relaxed prompt set (see
 * tests/vision.test.ts for the measured scores).
 */
export function thresholdsFor(profile: ScoringProfile = "machine"): ShotThresholds {
  if (profile === "handson") {
    return { minPositive: num("HANDSON_MIN_POSITIVE", 0.2), maxNegative: num("HANDSON_MAX_NEGATIVE", 0.34), margin: num("HANDSON_MARGIN", 0) };
  }
  return { minPositive: num("HARVEST_MIN_POSITIVE", 0.2), maxNegative: num("HARVEST_MAX_NEGATIVE", 0.34), margin: num("HARVEST_MARGIN", 0.005) };
}
/** Back-compat name (machine profile). */
export const defaultThresholds = (): ShotThresholds => thresholdsFor("machine");

export type ShotVerdict = "keep" | "talking_head" | "off_topic";

/** keep = product footage; talking_head = a presenter / face dominates; off_topic = logo, title card or not the product. */
export function classifyShot(pos: number, neg: number, t: ShotThresholds = defaultThresholds(), negKind: "person" | "graphic" = "person"): ShotVerdict {
  if (neg >= t.maxNegative || neg >= pos - t.margin) return negKind === "person" ? "talking_head" : "off_topic";
  if (pos < t.minPositive) return "off_topic";
  return "keep";
}

export const positivePrompt = (brand: string, model: string, category: string) => `${brand} ${model} ${category} machine closeup action outdoors`;
/** The talking-head prompt; always the first negative. */
export const NEGATIVE_PROMPT = "a person talking to the camera face portrait man speaking in studio";

export interface PromptSet {
  profile: ScoringProfile;
  positives: string[];
  negatives: { text: string; kind: "person" | "graphic" }[];
  /** [feature, prompt] pairs; the best-scoring feature tags the shot. */
  features: [string, string][];
}

/** The negative prompts of the machine profile (kept for callers that list them). */
export const negativePrompts = (category: string) => promptSet("machine", "", "", category).negatives;

export function promptSet(profile: ScoringProfile, brand: string, model: string, category: string, features: string[] = []): PromptSet {
  const name = `${brand} ${model}`.trim();
  const graphic = [
    { text: "a cartoon logo intro animation", kind: "graphic" as const },
    { text: "a title card with text on a plain background", kind: "graphic" as const },
  ];
  // Relaxed = more ways to count as product footage (detail close-ups, gloved hands on a part),
  // never fewer negatives: measured on real frames, dropping the presenter prompt let a dealer
  // talking beside the product and a cartoon channel logo through.
  const positives =
    profile === "handson"
      ? [positivePrompt(brand, model, category), `${name} ${category} close up`, `close up detail of a ${category} part`]
      : [positivePrompt(brand, model, category)];
  const negatives = [
    { text: NEGATIVE_PROMPT, kind: "person" as const },
    { text: `a man standing in a shop talking to the camera next to a ${category}`, kind: "person" as const },
    { text: "close up of a person face talking", kind: "person" as const },
    ...graphic,
  ];
  return { profile, positives, negatives, features: features.map((f) => [f, `${name} ${category} ${f} close up`]) };
}

export interface ShotScore {
  /** Best positive score. */
  pos: number;
  /** Worst (highest) negative score and its kind. */
  neg: number;
  negKind: "person" | "graphic";
  /** Features by score, best first. */
  features: [string, number][];
}

/** Best positive vs worst negative for one frame, from raw "text|image" scores. */
export function combine(set: PromptSet, raw: Record<string, number>, key: string): ShotScore {
  const pos = Math.max(...set.positives.map((_, i) => raw[`p${i}|${key}`] ?? 0));
  const negs = set.negatives.map((n, i) => ({ kind: n.kind, v: raw[`n${i}|${key}`] ?? 1 })).sort((a, b) => b.v - a.v);
  const features = set.features.map(([f], i) => [f, raw[`f${i}|${key}`] ?? 0] as [string, number]).sort((a, b) => b[1] - a[1]);
  return { pos, neg: negs[0]?.v ?? 0, negKind: negs[0]?.kind ?? "person", features };
}

export const judge = (s: ShotScore, t: ShotThresholds) => classifyShot(s.pos, s.neg, t, s.negKind);

/** Scores frames (key -> jpg) against a prompt set; null when CLIP is unavailable. */
export async function scoreShots(frames: Map<string, string>, set: PromptSet, workDir: string): Promise<Map<string, ShotScore> | null> {
  const bin = venvPythonPath();
  const script = path.join(paths.python, "clip_score.py");
  if (!bin || !fs.existsSync(script) || !frames.size) return frames.size ? null : new Map();
  const texts: Record<string, string> = {};
  set.positives.forEach((t, i) => (texts[`p${i}`] = t));
  set.negatives.forEach((n, i) => (texts[`n${i}`] = n.text));
  set.features.forEach(([, t], i) => (texts[`f${i}`] = t));
  const job = { texts, images: Object.fromEntries(frames), pairs: [...frames.keys()].flatMap((k) => Object.keys(texts).map((t) => [t, k])) };
  fs.mkdirSync(workDir, { recursive: true });
  const jobFile = path.join(workDir, "clip_job.json");
  const outFile = path.join(workDir, "clip_out.json");
  fs.writeFileSync(jobFile, JSON.stringify(job));
  fs.rmSync(outFile, { force: true });
  const r = await run(bin, [script, "--job", jobFile, "--out", outFile, "--models-dir", path.join(paths.root, "models", "fastembed")], { timeoutMs: 15 * 60_000 });
  if (r.code !== 0 || !fs.existsSync(outFile)) return null;
  const raw = (JSON.parse(fs.readFileSync(outFile, "utf8")) as { scores: Record<string, number> }).scores;
  return new Map([...frames.keys()].map((k) => [k, combine(set, raw, k)]));
}

export const clipAvailable = () => !!venvPythonPath() && fs.existsSync(path.join(paths.python, "clip_score.py"));
