const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function wordToNumber(w: string): string | null {
  if (w in UNITS) return String(UNITS[w]);
  if (w in TENS) return String(TENS[w]);
  for (const [t, tv] of Object.entries(TENS)) {
    if (w.startsWith(t)) {
      const rest = w.slice(t.length);
      if (rest in UNITS && UNITS[rest] < 10) return String(tv + UNITS[rest]);
    }
  }
  return null;
}

/**
 * Comparison key for a token: lowercase alphanumerics only, number words as digits.
 * "Number" / "number", "five" / "5", "M&P" / "m and p" all compare equal-ish.
 */
export function norm(token: string): string {
  const base = token.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]/g, "");
  return wordToNumber(base) ?? base;
}

/** Splits script text into display tokens (keeps punctuation attached for captions). */
export function tokenize(text: string): string[] {
  return text
    .replace(/[—–]/g, " ")
    .split(/\s+/)
    .filter((t) => t !== "" && norm(t) !== "");
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 1.0 = identical, 0.0 = nothing in common. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 1 : 1 - levenshtein(a, b) / max;
}

export const endsSentence = (token: string) => /[.!?]["')\]]*$/.test(token);
