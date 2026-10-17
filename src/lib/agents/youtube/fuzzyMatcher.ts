import { norm } from "../../text.js";

/**
 * Typo-forgiving matching for gadget names and spoken spec words.
 *
 * Letters may be misspelled ("Turf Tigre II" = "Turf Tiger II", ASR "brushles" = "brushless");
 * digits may NOT: a changed digit is a different product ("LM2135" vs "LM2153", "Gen 3" vs
 * "Gen 5"), so digit sequences must be identical. To keep false matches out, short words get no
 * edits at all ("deck" != "desk"), longer words one or two, and the first letter must agree
 * ("motor" != "rotor").
 */

/** Damerau-Levenshtein (optimal string alignment): insert, delete, substitute, swap neighbours. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m || !n) return m || n;
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** Edits allowed for a word of this many letters: <= 4 -> 0, 5-7 -> 1, 8+ -> 2. */
export const allowedEdits = (letters: number) => (letters <= 4 ? 0 : letters <= 7 ? 1 : 2);

const digitsOf = (s: string) => s.replace(/[^0-9]/g, "");
const lettersOf = (s: string) => s.replace(/[0-9]/g, "");

/**
 * Two normalised tokens (see text.norm) name the same thing despite a typo: identical digits,
 * same first character, and the letters within the edit budget of the longer word.
 */
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
/**
 * Numeric value of a generation-style token: "2", "ii", or "ll" (lower-case L typed for I) -> 2.
 * Null for anything else.
 */
export function numberValue(t: string): number | null {
  if (/^\d+$/.test(t)) return Number(t);
  const r = /^[il]+$/.test(t) ? t.replace(/l/g, "i") : t;
  return ROMAN[r] ?? null;
}

export function fuzzyEqual(a: string, b: string): boolean {
  if (a === b) return true;
  // "II" = "2" = "ll"; a different number is never a typo.
  const [na, nb] = [numberValue(a), numberValue(b)];
  if (na !== null || nb !== null) return na !== null && na === nb;
  if (!a || !b || a[0] !== b[0]) return false;
  if (digitsOf(a) !== digitsOf(b)) return false;
  const la = lettersOf(a);
  const lb = lettersOf(b);
  const budget = allowedEdits(Math.max(la.length, lb.length));
  return budget > 0 && Math.abs(la.length - lb.length) <= budget && editDistance(a, b) <= budget;
}

/** TokenMatcher for caption keywords: exact, plurals, or a typo (ASR spellings). */
export function fuzzyTokenMatch(spoken: string, wanted: string): boolean {
  if (spoken === wanted) return true;
  const [short, long] = spoken.length < wanted.length ? [spoken, wanted] : [wanted, spoken];
  if (short.length >= 3 && !short.endsWith("s") && (long === `${short}s` || long === `${short}es`)) return true;
  return fuzzyEqual(spoken, wanted);
}

const tokensOf = (s: string) => s.split(/[^A-Za-z0-9&+]+/).map(norm).filter(Boolean);

/**
 * The model (possibly misspelled, or spaced differently) appears in a title: every model token
 * matches the next title token, or two title tokens joined ("Tiger II" vs "TigerII"), with
 * fuzzyEqual. Digits are never forgiven.
 */
/** Roman numerals and variant words name a different model when they differ: never fuzzy. */
const STRICT_WORDS = new Set(["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "pro", "max", "plus", "mini", "ultra", "lite", "air", "se", "xl", "fe", "neo"]);
const isStrict = (t: string) => /\d/.test(t) || STRICT_WORDS.has(t);

export function fuzzyTitleHasModel(title: string, model: string): boolean {
  const want = tokensOf(model);
  const have = tokensOf(title);
  if (!want.length) return false;
  // Numbers, Roman numerals and variant words must be in the title exactly (as one token or two
  // joined: "lm 2135sp"), or "Turf Tiger III" would pass for "Turf Tiger II".
  const joined = [...have, ...have.slice(1).map((t, i) => have[i] + t)];
  if (!want.filter(isStrict).every((t) => joined.some((h) => h === t || (numberValue(t) !== null && numberValue(t) === numberValue(h))))) return false;
  for (let i = 0; i < have.length; i++) {
    let j = i;
    const ok = want.every((w) => {
      if (j < have.length && fuzzyEqual(have[j], w)) return (j += 1), true;
      // The title splits what the model writes as one token ("lm 2135sp" vs "lm2135sp").
      if (j + 1 < have.length && fuzzyEqual(have[j] + have[j + 1], w)) return (j += 2), true;
      return false;
    });
    if (ok) return true;
  }
  // Model written with spaces the title does not have ("Turf Tiger" vs "TurfTiger").
  const compact = want.join("");
  return have.some((t, i) => fuzzyEqual(t, compact) || (i + 1 < have.length && fuzzyEqual(t + have[i + 1], compact)));
}

/**
 * The spelling the titles agree on, when the given name has a typo: each name token is replaced by
 * the most common different title token that fuzzy-matches it (at least `minVotes` titles). Digits
 * are never changed. Returns null when nothing would change.
 */
export function suggestSpelling(name: string, titles: string[], minVotes = 2): string | null {
  const words = name.trim().split(/\s+/);
  let changed = false;
  const out = words.map((w) => {
    const n = norm(w);
    if (!n) return w;
    const votes = new Map<string, { count: number; display: string }>();
    for (const title of titles) {
      const seen = new Set<string>();
      for (const raw of title.split(/[^A-Za-z0-9&+-]+/).filter(Boolean)) {
        const t = norm(raw);
        if (!t || t === n || seen.has(t) || !fuzzyEqual(t, n)) continue;
        seen.add(t);
        const v = votes.get(t) ?? { count: 0, display: raw };
        v.count++;
        votes.set(t, v);
      }
    }
    // The name's own spelling also gets votes: only replace it when titles clearly prefer another.
    const own = titles.filter((t) => tokensOf(t).includes(n)).length;
    const best = [...votes.values()].sort((a, b) => b.count - a.count)[0];
    if (best && best.count >= minVotes && best.count > own) {
      changed = true;
      // Keep the user's casing style for all-caps model codes.
      return w === w.toUpperCase() ? best.display.toUpperCase() : best.display;
    }
    return w;
  });
  return changed ? out.join(" ") : null;
}
