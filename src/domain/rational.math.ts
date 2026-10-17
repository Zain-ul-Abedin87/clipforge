/**
 * Exact rational arithmetic for timeline time (no floating point).
 *
 * Every time value is n/d seconds with BigInt numerator and denominator, always normalised
 * (gcd-reduced, d > 0). Frame rates are rationals too (30/1, 30000/1001), so frame <-> time
 * conversions are exact and accumulating thousands of scene durations never drifts away from the
 * voiceover. JSON stores rationals as "n/d" strings (BigInt is not JSON-serialisable).
 *
 * Written for ClipForge from the multi-track / rational-time idea used by NLE data models
 * (e.g. the Concat project's approach); no third-party code is copied.
 */

export interface Rational {
  readonly n: bigint;
  readonly d: bigint;
}

/** "1001/30000" (or an integer "12"): the JSON form of a Rational. */
export type RationalString = string;

const abs = (x: bigint) => (x < 0n ? -x : x);

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1n;
}

/** n/d, normalised. Throws on a zero denominator. */
export function rat(n: bigint | number, d: bigint | number = 1n): Rational {
  let N = typeof n === "bigint" ? n : intOf(n, "numerator");
  let D = typeof d === "bigint" ? d : intOf(d, "denominator");
  if (D === 0n) throw new RangeError("rational with zero denominator");
  if (D < 0n) [N, D] = [-N, -D];
  const g = gcd(N, D);
  return Object.freeze({ n: N / g, d: D / g });
}

function intOf(x: number, what: string): bigint {
  if (!Number.isInteger(x)) throw new RangeError(`${what} must be an integer, got ${x} (use fromDecimal for decimals)`);
  return BigInt(x);
}

export const ZERO = rat(0n);
export const ONE = rat(1n);

/**
 * Exact value of a decimal written in base 10 ("2.035", 2.035, "-0.5", "1e-3"). A JS number is
 * converted through its shortest decimal string, so 0.1 becomes exactly 1/10 (not 0.1000000000000000055...).
 */
export function fromDecimal(x: number | string): Rational {
  const s = typeof x === "number" ? (Number.isFinite(x) ? x.toString() : "") : x.trim();
  const m = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(s);
  if (!s || !m || (!m[2] && !m[3])) throw new RangeError(`not a decimal number: ${x}`);
  const frac = m[3] ?? "";
  const exp = Number(m[4] ?? 0) - frac.length;
  let n = BigInt(`${m[1]}${m[2] || "0"}${frac}`);
  let d = 1n;
  if (exp >= 0) n *= 10n ** BigInt(exp);
  else d = 10n ** BigInt(-exp);
  return rat(n, d);
}

/** Parses "n/d", "n" or a decimal string. */
export function parseRational(s: RationalString | number): Rational {
  if (typeof s === "number") return fromDecimal(s);
  const m = /^\s*([+-]?\d+)\s*\/\s*(\d+)\s*$/.exec(s);
  return m ? rat(BigInt(m[1]), BigInt(m[2])) : fromDecimal(s);
}

export const toRationalString = (r: Rational): RationalString => (r.d === 1n ? r.n.toString() : `${r.n}/${r.d}`);

export const add = (a: Rational, b: Rational) => rat(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Rational, b: Rational) => rat(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Rational, b: Rational) => rat(a.n * b.n, a.d * b.d);
export function div(a: Rational, b: Rational): Rational {
  if (b.n === 0n) throw new RangeError("division by zero");
  return rat(a.n * b.d, a.d * b.n);
}
export const neg = (a: Rational) => rat(-a.n, a.d);
export const sum = (xs: Rational[]) => xs.reduce(add, ZERO);

/** -1, 0, 1 */
export function cmp(a: Rational, b: Rational): -1 | 0 | 1 {
  const x = a.n * b.d - b.n * a.d;
  return x < 0n ? -1 : x > 0n ? 1 : 0;
}
export const eq = (a: Rational, b: Rational) => a.n === b.n && a.d === b.d;
export const lt = (a: Rational, b: Rational) => cmp(a, b) < 0;
export const lte = (a: Rational, b: Rational) => cmp(a, b) <= 0;
export const gt = (a: Rational, b: Rational) => cmp(a, b) > 0;
export const gte = (a: Rational, b: Rational) => cmp(a, b) >= 0;
export const min = (a: Rational, b: Rational) => (lte(a, b) ? a : b);
export const max = (a: Rational, b: Rational) => (gte(a, b) ? a : b);
export const isZero = (a: Rational) => a.n === 0n;

/** Largest integer <= r. */
export function floor(r: Rational): bigint {
  const q = r.n / r.d;
  return r.n < 0n && q * r.d !== r.n ? q - 1n : q;
}
/** Smallest integer >= r. */
export const ceil = (r: Rational): bigint => -floor(neg(r));
/** Nearest integer; exact halves round up (towards +infinity), deterministically. */
export const round = (r: Rational): bigint => floor(add(r, rat(1n, 2n)));

/** For display / FFmpeg arguments only: never feed the result back into timeline math. */
export const toNumber = (r: Rational) => Number(r.n) / Number(r.d);
/** Fixed-decimal string for FFmpeg ("12.033333"), computed exactly then rounded half-up. */
export function toFixed(r: Rational, digits = 6): string {
  const scale = 10n ** BigInt(digits);
  const v = round(mul(r, rat(scale)));
  const sign = v < 0n ? "-" : "";
  const a = abs(v);
  const int = a / scale;
  const frac = (a % scale).toString().padStart(digits, "0");
  return digits ? `${sign}${int}.${frac}` : `${sign}${int}`;
}

// ---------------------------------------------------------------------------------------------
// Frames

/** Frame rate as frames per second, e.g. rat(30) or rat(30000, 1001). */
export type FrameRate = Rational;
export const FPS_30 = rat(30n);
export const FPS_2997 = rat(30000n, 1001n);

export type RoundMode = "floor" | "round" | "ceil";

/** Frame index containing / nearest to time t. */
export function secondsToFrame(t: Rational, fps: FrameRate, mode: RoundMode = "round"): bigint {
  const f = mul(t, fps);
  return mode === "floor" ? floor(f) : mode === "ceil" ? ceil(f) : round(f);
}

/** Exact start time of frame f. */
export const frameToSeconds = (frame: bigint | number, fps: FrameRate): Rational => div(rat(BigInt(frame)), fps);

/** t moved onto the frame grid. */
export const snapToFrame = (t: Rational, fps: FrameRate, mode: RoundMode = "round"): Rational => frameToSeconds(secondsToFrame(t, fps, mode), fps);

export const isFrameAligned = (t: Rational, fps: FrameRate) => mul(t, fps).d === 1n;

/** Frames covered by [start, end) after snapping both ends to the grid (never negative). */
export function frameSpan(start: Rational, end: Rational, fps: FrameRate): bigint {
  const n = secondsToFrame(end, fps) - secondsToFrame(start, fps);
  return n < 0n ? 0n : n;
}

/**
 * Snaps a list of boundary times (scene cuts) to frames with cumulative rounding: each boundary is
 * rounded independently from the exact time, so the total length always equals round(last * fps)
 * and no per-scene rounding error can accumulate. Boundaries stay strictly increasing (a scene is
 * never 0 frames) as long as the input boundaries are at least one frame apart.
 */
export function boundariesToFrames(times: Rational[], fps: FrameRate): bigint[] {
  const out: bigint[] = [];
  for (const t of times) {
    let f = secondsToFrame(t, fps);
    if (out.length && f <= out[out.length - 1]) f = out[out.length - 1] + 1n;
    out.push(f);
  }
  return out;
}

/** Integer PTS in a container timebase (e.g. 1/15360): exact, rounded half-up. */
export const toTimebase = (t: Rational, timebase: Rational): bigint => round(div(t, timebase));
