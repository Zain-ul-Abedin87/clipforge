import { spawn } from "node:child_process";

/**
 * Picture checks a viewer notices at once (ported from video-director's qa_video.py, MIT, by win4r;
 * thresholds kept as published there):
 *  - frame 0: flat or black (the thumbnail and muted autoplay show it)  -> fail
 *  - single-frame flashes: one frame unlike both neighbours, which match each other -> fail
 *  - pops: smaller one-frame spikes (3x both neighbours) -> warn
 *  - captions readable on a phone: font >= 48 px at a 1080 short side, contrast >= 7:1 -> warn / fail
 * Frames are analysed as tiny greyscale copies, streamed (the film is never held in memory).
 */

export const ANALYSIS_W = 128;
export const CAPTION_FLOOR_PX = 48;
export const HOOK_FLOOR_PX = 84;
export const MIN_CONTRAST = 7;

export interface FrameStats {
  n: number;
  mean: number[];
  std: number[];
  /** Mean absolute difference to the previous frame (0 for frame 0). */
  d: number[];
  /** skip[i] = |f[i+1] - f[i-1]| (NaN at both ends). */
  skip: number[];
}

/** Per-frame stats of grey frames (each `w * h` bytes), fed one frame at a time. */
export class FrameStatsBuilder {
  private prev: Uint8Array | null = null;
  private prev2: Uint8Array | null = null;
  private s: FrameStats = { n: 0, mean: [], std: [], d: [], skip: [NaN] };
  push(f: Uint8Array): void {
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < f.length; i++) {
      sum += f[i];
      sq += f[i] * f[i];
    }
    const m = sum / f.length;
    this.s.mean.push(m);
    this.s.std.push(Math.sqrt(Math.max(0, sq / f.length - m * m)));
    this.s.d.push(this.prev ? meanAbsDiff(f, this.prev) : 0);
    if (this.prev2) this.s.skip.push(meanAbsDiff(f, this.prev2));
    this.prev2 = this.prev;
    this.prev = f;
    this.s.n++;
  }
  done(): FrameStats {
    const s = this.s;
    const skip = s.n >= 2 ? [...s.skip, NaN].slice(0, s.n) : Array(s.n).fill(NaN);
    return { ...s, skip };
  }
}

function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  let t = 0;
  for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]);
  return t / a.length;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export interface PictureFindings {
  frame0: { mean: number; contrast: number; ok: boolean };
  /** Seconds. */
  flashes: number[];
  pops: number[];
}

export function analysePicture(st: FrameStats, fps: number): PictureFindings {
  const { d, skip, n } = st;
  const med = n > 2 ? median(d.slice(1)) : 0;
  const tFlash = Math.max(2, 4 * med);
  const flashes: number[] = [];
  for (let i = 1; i < n - 1; i++) if (d[i] > tFlash && d[i + 1] > tFlash && skip[i] < 0.35 * Math.min(d[i], d[i + 1])) flashes.push(i);
  const flashFrames = new Set([...flashes, ...flashes.map((i) => i + 1)]);
  const isCut = (i: number) => {
    const local = [...d.slice(Math.max(1, i - 15), i), ...d.slice(i + 1, Math.min(n, i + 16))];
    return d[i] > Math.max(6, 3.5 * (median(local) + 0.5));
  };
  const pops: number[] = [];
  for (let i = 1; i < n - 1; i++) if (!flashFrames.has(i) && d[i] > 2 && d[i] > 3 * Math.max(d[i - 1], d[i + 1]) && !isCut(i)) pops.push(i);
  const r = (x: number) => Math.round(x * 10) / 10;
  const f0 = { mean: r(st.mean[0] ?? 0), contrast: r(st.std[0] ?? 0) };
  return { frame0: { ...f0, ok: n > 0 && !(f0.contrast < 6 || f0.mean < 8) }, flashes: flashes.map((i) => Math.round((i / fps) * 1000) / 1000), pops: pops.map((i) => Math.round((i / fps) * 1000) / 1000) };
}

/** Streams the video through FFmpeg as tiny grey frames. */
export function frameStats(ff: string, video: string, w: number, h: number): Promise<FrameStats> {
  const ah = Math.max(2, Math.round((ANALYSIS_W * h) / w / 2) * 2);
  const size = ANALYSIS_W * ah;
  return new Promise((resolve, reject) => {
    const p = spawn(ff, ["-v", "error", "-i", video, "-vf", `scale=${ANALYSIS_W}:${ah}:flags=area,format=gray`, "-f", "rawvideo", "-"], { windowsHide: true });
    const b = new FrameStatsBuilder();
    let buf: Buffer = Buffer.alloc(0);
    p.stdout.on("data", (c: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, c]) : c;
      while (buf.length >= size) {
        b.push(new Uint8Array(buf.subarray(0, size)));
        buf = buf.subarray(size);
      }
    });
    let err = "";
    p.stderr.on("data", (c) => (err += c));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(b.done()) : reject(new Error(`ffmpeg ${code}: ${err.slice(-200)}`))));
  });
}

// ---------------------------------------------------------------- caption readability

/** sRGB 0-255 -> relative luminance (WCAG). */
export function luminance(r: number, g: number, b: number): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
export const contrastRatio = (l1: number, l2: number) => (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

/**
 * Ink vs background contrast and font size of the text in an RGB crop (video-director's
 * measure_text): Otsu splits luminance in two, the smaller class is the glyphs; cap height runs
 * from the tallest glyph top to the baseline; font px = cap / 0.72, scaled to a 1080 short side.
 */
export function measureText(rgb: Uint8Array, w: number, h: number, shortSide: number): { fontPx: number; contrast: number } {
  const n = w * h;
  const lum = new Float64Array(n);
  const hist = new Array(256).fill(0);
  for (let i = 0; i < n; i++) {
    lum[i] = luminance(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    hist[Math.min(255, Math.floor(lum[i] * 256))]++;
  }
  // Otsu threshold on the luminance histogram.
  let w0 = 0;
  let mu = 0;
  let total = 0;
  for (let k = 0; k < 256; k++) total += (k / 256) * hist[k];
  const muT = total / n;
  let best = 0;
  let thr = 0;
  for (let k = 0; k < 256; k++) {
    w0 += hist[k] / n;
    mu += ((k / 256) * hist[k]) / n;
    const between = (muT * w0 - mu) ** 2 / (w0 * (1 - w0) + 1e-12);
    if (between > best) [best, thr] = [between, (k + 1) / 256];
  }
  const hi = Array.from(lum, (l) => l > thr);
  const hiShare = hi.filter(Boolean).length / n;
  const ink = hi.map((x) => (hiShare <= 0.5 ? x : !x));
  const inkN = ink.filter(Boolean).length;
  if (!inkN || inkN === n) return { fontPx: 0, contrast: 1 };
  const inkL: number[] = [];
  const bgL: number[] = [];
  for (let i = 0; i < n; i++) (ink[i] ? inkL : bgL).push(lum[i]);
  const contrast = contrastRatio(median(inkL), median(bgL));
  const rows = Array.from({ length: h }, (_, y) => ink.slice(y * w, y * w + w).filter(Boolean).length);
  const maxRow = Math.max(...rows);
  const dense = rows.map((c, y) => (c >= 0.25 * maxRow ? y : -1)).filter((y) => y >= 0);
  const top = rows.findIndex((c) => c >= Math.max(1, 0.03 * maxRow));
  const cap = ((dense[dense.length - 1] - top + 1) * 1080) / shortSide;
  return { fontPx: Math.round((cap / 0.72) * 10) / 10, contrast: Math.round(contrast * 10) / 10 };
}

/** RGB pixels of a crop of the frame at `t` seconds (FFmpeg, one frame); null on failure. */
export function grabCrop(ff: string, video: string, t: number, box: { x: number; y: number; w: number; h: number }): Promise<Uint8Array | null> {
  return new Promise((resolve) => {
    const p = spawn(ff, ["-v", "error", "-ss", t.toFixed(3), "-i", video, "-frames:v", "1", "-vf", `crop=${box.w}:${box.h}:${box.x}:${box.y}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { windowsHide: true });
    const parts: Buffer[] = [];
    const timer = setTimeout(() => p.kill(), 30_000);
    p.stdout.on("data", (c: Buffer) => parts.push(c));
    p.on("error", () => resolve(null));
    p.on("close", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(parts);
      resolve(code === 0 && out.length === box.w * box.h * 3 ? new Uint8Array(out) : null);
    });
  });
}
