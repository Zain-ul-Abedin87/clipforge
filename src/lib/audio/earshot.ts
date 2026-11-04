import fs from "node:fs";
import path from "node:path";
import { run, RunResult } from "../exec.js";
import { FeatureSettings, loadFeatures } from "../settings/features.js";

/**
 * earshot (github.com/Leonxlnx/earshot, MIT; models CLAP Apache-2.0 and AST BSD-3-Clause; CPU only):
 *  - `earshot sfx render <id> -o x.wav`: a sound of its code-made bank (252 sounds, no licence needed).
 *    Model-free.
 *  - `earshot timeline <video> --cues cues.json --detail low --json --out r.json`: for each cue (here:
 *    every placed sound effect), the sound that answers it: offset in ms, or "no sound" when nothing
 *    is heard there (the effect is buried under music / voice). Needs its models (~1.1 GB, downloaded once).
 * Arguments and the JSON shape are taken from earshot's own source (timeline.py sync(), forge/sfx.py).
 * Optional: ClipForge works exactly as before when earshot is not installed or switched off.
 */
export type EarshotSettings = FeatureSettings["earshot"];
export type Exec = (cmd: string, args: string[], o?: { timeoutMs?: number }) => Promise<RunResult>;

const exec: Exec = (c, a, o) => run(c, a, o);

/** Is the earshot command there? (`--help` loads no models.) */
export async function earshotAvailable(st: EarshotSettings = loadFeatures().earshot, x: Exec = exec): Promise<boolean> {
  if (!st.enabled) return false;
  const r = await x(st.command, ["--help"], { timeoutMs: 30_000 });
  return r.code === 0;
}

/** One bank sound as a WAV (cached by id). */
export async function renderBankSound(id: string, outFile: string, st: EarshotSettings = loadFeatures().earshot, x: Exec = exec): Promise<string> {
  if (fs.existsSync(outFile)) return outFile;
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const r = await x(st.command, ["sfx", "render", id, "-o", outFile, "--sr", "48000", "--peak", "-1"], { timeoutMs: 120_000 });
  if (r.code !== 0 || !fs.existsSync(outFile)) throw new Error(`earshot sfx render ${id} failed: ${(r.stderr || r.stdout).trim().slice(-200)}`);
  return outFile;
}

export interface Cue {
  t: number;
  kind: string;
  id: string;
}

export interface SyncItem {
  t: number;
  kind?: string;
  id?: string;
  offset_ms: number | null;
  status: string;
}

export interface SyncResult {
  items: SyncItem[];
  /** Share heard within 100 ms. */
  hit100: number;
  medianOffsetMs: number | null;
  /** Cue times where nothing was heard. */
  silent: number[];
}

/** Reads earshot's timeline JSON (result.sync.cues). */
export function parseSync(json: unknown): SyncResult | null {
  const cues = (json as { sync?: { cues?: { items?: SyncItem[]; stats?: Record<string, unknown> } } })?.sync?.cues;
  if (!cues?.items) return null;
  const st = cues.stats ?? {};
  return {
    items: cues.items,
    hit100: Number(st.hit_within_100ms ?? 0),
    medianOffsetMs: typeof st.median_abs_offset_ms === "number" ? st.median_abs_offset_ms : null,
    silent: Array.isArray(st.no_sound) ? (st.no_sound as number[]) : [],
  };
}

/** Are the placed sound effects audible and on time? */
export async function checkSoundEffects(video: string, cues: Cue[], workDir: string, st: EarshotSettings = loadFeatures().earshot, x: Exec = exec): Promise<SyncResult> {
  fs.mkdirSync(workDir, { recursive: true });
  const cueFile = path.join(workDir, "earshot_cues.json");
  const outFile = path.join(workDir, "earshot_timeline.json");
  fs.writeFileSync(cueFile, JSON.stringify({ events: cues.map((c) => ({ t: Math.round(c.t * 1000) / 1000, kind: c.kind, id: c.id })) }, null, 1));
  const r = await x(st.command, ["timeline", video, "--cues", cueFile, "--detail", "low", "--json", "--out", outFile], { timeoutMs: 30 * 60_000 });
  if (r.code !== 0 || !fs.existsSync(outFile)) throw new Error(`earshot timeline failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-240)}`);
  const parsed = parseSync(JSON.parse(fs.readFileSync(outFile, "utf8")));
  if (!parsed) throw new Error("earshot timeline returned no cue sync");
  return parsed;
}
