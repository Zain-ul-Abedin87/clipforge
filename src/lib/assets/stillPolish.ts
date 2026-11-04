import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { run } from "../exec.js";
import { paths } from "../paths.js";
import { findOnPath, venvPythonPath } from "../tools.js";
import { FeatureSettings, loadFeatures } from "../settings/features.js";

/**
 * Product photo polish (idea from OpenMontage's enhancement tools, all local and free):
 *  1. upscale a small photo with Real-ESRGAN (realesrgan-ncnn-vulkan, BSD-3, runs on any Vulkan GPU);
 *  2. cut the product out of its background with rembg (u2net by default), so the render's showcase
 *     (src/commands/render.ts prepareShowcase) puts it on its studio gradient with a soft shadow.
 * Both are off by default (features.json "stills"). Results are cached in cache/stills/ by the photo's
 * content and the settings. A failed or doubtful step keeps the photo as it was; it never blocks a render.
 */

export type Runner = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
export type StillSettings = FeatureSettings["stills"];

export interface PolishResult {
  path: string;
  upscaled: number;
  cutout: boolean;
  notes: string[];
}

/** x2 or x4 so the long side reaches minLongSide; 0 = big enough. */
export function upscaleFactor(w: number, h: number, minLongSide: number): number {
  const long = Math.max(w, h);
  if (!long || long >= minLongSide) return 0;
  return long * 2 >= minLongSide ? 2 : 4;
}

/** The parsed answer of python/still_polish.py (null when it printed nothing usable). */
export function parseCut(stdout: string): { ok: boolean; cover?: number; reason?: string } | null {
  const line = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
  try {
    return line ? JSON.parse(line) : null;
  } catch {
    return null;
  }
}

const sha = (s: string | Buffer) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);

export async function polishStill(
  src: string,
  size: { w: number; h: number; alpha: boolean },
  o: { settings?: StillSettings; runner?: Runner; cacheDir?: string; log?: (m: string) => void } = {},
): Promise<PolishResult> {
  const st = o.settings ?? loadFeatures().stills;
  const exec: Runner = o.runner ?? ((c, a) => run(c, a, { timeoutMs: 5 * 60_000 }));
  const log = o.log ?? (() => {});
  const cacheDir = o.cacheDir ?? path.join(paths.root, "cache", "stills");
  fs.mkdirSync(cacheDir, { recursive: true });
  const key = sha(`${sha(fs.readFileSync(src))}|${st.upscale}|${st.minLongSide}|${st.cutout}|${st.cutoutModel}|${st.minCover}|${st.maxCover}`);
  const res: PolishResult = { path: src, upscaled: 0, cutout: false, notes: [] };
  let cur = src;

  const factor = st.upscale ? upscaleFactor(size.w, size.h, st.minLongSide) : 0;
  if (factor) {
    const out = path.join(cacheDir, `${key}_x${factor}.png`);
    const exe = st.realesrgan || findOnPath("realesrgan-ncnn-vulkan") || "";
    if (fs.existsSync(out)) cur = out;
    else if (!exe) res.notes.push("upscale skipped: realesrgan-ncnn-vulkan not found (features.json stills.realesrgan)");
    else {
      const r = await exec(exe, ["-i", cur, "-o", out, "-n", "realesrgan-x4plus", "-s", String(factor)]);
      if (r.code === 0 && fs.existsSync(out)) cur = out;
      else res.notes.push(`upscale failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(-160)}`);
    }
    if (cur !== src) {
      res.upscaled = factor;
      log(`[stills] upscaled x${factor}: ${path.basename(src)} (${size.w}x${size.h})`);
    }
  }

  // A photo that already has transparency is a cut-out (maker sites): nothing to cut.
  if (st.cutout && !size.alpha) {
    const out = path.join(cacheDir, `${key}_cut.png`);
    const failMark = `${out}.fail`;
    if (fs.existsSync(out)) {
      cur = out;
      res.cutout = true;
    } else if (fs.existsSync(failMark)) {
      res.notes.push(`cutout skipped: ${fs.readFileSync(failMark, "utf8")}`);
    } else {
      const py = st.pythonCmd || venvPythonPath() || "python";
      const r = await exec(py, [path.join(paths.python, "still_polish.py"), cur, out, st.cutoutModel, String(st.minCover), String(st.maxCover)]);
      const j = parseCut(r.stdout);
      if (j?.ok && fs.existsSync(out)) {
        cur = out;
        res.cutout = true;
        log(`[stills] cut out: ${path.basename(src)} (${Math.round((j.cover ?? 0) * 100)}% of the picture, ${st.cutoutModel})`);
      } else {
        const why = j?.reason ?? `exit ${r.code}: ${(r.stderr || r.stdout).trim().slice(-160)}`;
        res.notes.push(`cutout skipped: ${why}`);
        // A doubtful cut is remembered (not retried every render); a missing install is not.
        if (j && !j.ok && j.cover !== undefined) fs.writeFileSync(failMark, why);
      }
    }
  }
  for (const n of res.notes) log(`[stills] ${path.basename(src)}: ${n}`);
  res.path = cur;
  return res;
}
