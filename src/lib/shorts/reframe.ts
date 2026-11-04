/**
 * Reframing a 16:9 source for Shorts / Reels / TikTok (9:16), square posts (1:1) or 16:9.
 *  - fit:    the whole frame at full width over a blurred, zoomed copy of itself (nothing is cut);
 *  - center: a centre crop to the target shape;
 *  - smart:  the crop follows the speaker's face (python/face_track.py samples), holding still and
 *            moving only when the face moves clearly (no jitter), in short smooth pans. With too few
 *            faces it falls back to fit, so no speaker is cut off.
 */
export type ShortFormat = "9:16" | "1:1" | "16:9";
export type Reframe = "fit" | "center" | "smart";

export const DIMS: Record<ShortFormat, { W: number; H: number }> = { "9:16": { W: 1080, H: 1920 }, "1:1": { W: 1080, H: 1080 }, "16:9": { W: 1920, H: 1080 } };

export interface FaceSample {
  t: number;
  cx: number | null;
  size?: number;
}

/** Crop width (source pixels) that gives the target shape at full source height. */
export const cropWidth = (srcW: number, srcH: number, f: ShortFormat) => Math.min(srcW, Math.round((srcH * DIMS[f].W) / DIMS[f].H / 2) * 2);

/**
 * Crop x keyframes from face samples: gaps filled from the nearest face, a 3-sample median, then a
 * hold: the crop moves only when the face's wanted position is more than `deadZone` of the source
 * width away. Returns null when fewer than `minFaces` of the samples saw a face.
 */
export function cropKeyframes(samples: FaceSample[], srcW: number, srcH: number, f: ShortFormat, o: { deadZone?: number; minFaces?: number } = {}): { t: number; x: number }[] | null {
  if (!samples.length) return null;
  const seen = samples.filter((s) => s.cx !== null).length / samples.length;
  if (seen < (o.minFaces ?? 0.3)) return null;
  const cw = cropWidth(srcW, srcH, f);
  const maxX = srcW - cw;
  // Fill each gap with the nearest seen face (before, else after).
  const filled = samples.map((s, i) => {
    if (s.cx !== null) return s.cx;
    for (let d = 1; d < samples.length; d++) {
      const a = samples[i - d]?.cx;
      if (a != null) return a;
      const b = samples[i + d]?.cx;
      if (b != null) return b;
    }
    return 0.5;
  });
  const med = filled.map((_, i) => {
    const w = filled.slice(Math.max(0, i - 1), i + 2).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  const want = med.map((cx) => Math.max(0, Math.min(maxX, Math.round(cx * srcW - cw / 2))));
  const dz = (o.deadZone ?? 0.08) * srcW;
  const keys: { t: number; x: number }[] = [{ t: samples[0].t, x: want[0] }];
  for (let i = 1; i < samples.length; i++) if (Math.abs(want[i] - keys[keys.length - 1].x) > dz) keys.push({ t: samples[i].t, x: want[i] });
  return keys;
}

/** FFmpeg expression for the crop's x at time t: hold each keyframe, pan `pan` seconds into the next. */
export function cropXExpr(keys: { t: number; x: number }[], pan = 0.4): string {
  if (keys.length === 1) return String(keys[0].x);
  let expr = String(keys[keys.length - 1].x);
  for (let i = keys.length - 2; i >= 0; i--) {
    const a = keys[i];
    const b = keys[i + 1];
    const s = Math.max(a.t, b.t - pan);
    // before s: a.x; between s and b.t: linear to b.x; after: the rest.
    expr = `if(lt(t,${s.toFixed(3)}),${a.x},if(lt(t,${b.t.toFixed(3)}),${a.x}+(${b.x - a.x})*(t-${s.toFixed(3)})/${Math.max(0.001, b.t - s).toFixed(3)},${expr}))`;
  }
  return expr;
}

/** The video part of the filter graph (input [0:v], output [vbase]). */
export function reframeFilter(f: ShortFormat, mode: Reframe, srcW: number, srcH: number, keys: { t: number; x: number }[] | null): string {
  const { W, H } = DIMS[f];
  const srcWide = srcW / srcH > W / H + 0.01;
  if (mode === "fit" || !srcWide || (mode === "smart" && !keys)) {
    if (!srcWide && Math.abs(srcW / srcH - W / H) < 0.01) return `[0:v]scale=${W}:${H},setsar=1,fps=30[vbase]`;
    return `[0:v]split=2[a][b];[a]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=28:3,eq=brightness=-0.15[bg];[b]scale=${W}:${H}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=x=(W-w)/2:y=(H-h)/2,setsar=1,fps=30[vbase]`;
  }
  const cw = cropWidth(srcW, srcH, f);
  const x = mode === "center" || !keys ? String(Math.round((srcW - cw) / 2)) : `'${cropXExpr(keys)}'`;
  return `[0:v]crop=${cw}:${srcH}:${x}:0,scale=${W}:${H},setsar=1,fps=30[vbase]`;
}
