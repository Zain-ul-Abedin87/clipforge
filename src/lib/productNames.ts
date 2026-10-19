/**
 * Product-name hygiene between the planner LLM and footage search. A weak model can return the
 * string "null", a bare fragment of a name it already gave in full ("Explorer" next to "Bounce
 * Imaging Explorer throwable 360 camera"), or a model padded with description words ("R40 Personal
 * Utility Ruck Case"). Each of these broke the harvest in video-1019-1843.
 */

const NULLISH = /^(null|none|nil|n\/?a|unknown|undefined|no product|-+)$/i;

/** The name, or null for an LLM "null" / "none" / empty / no letters or digits. */
export function cleanProductName(name: string | null | undefined): string | null {
  const t = (name ?? "").trim().replace(/\s+/g, " ");
  if (!t || NULLISH.test(t) || !/[a-z0-9]/i.test(t)) return null;
  return t;
}

/** A model string search can match on: at least one letter or digit. */
export const hasModelToken = (model: string | null | undefined) => /[a-z0-9]/i.test(model ?? "");

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * name -> the one longer product name it is a whole-word part of ("Explorer" -> "Bounce Imaging
 * Explorer throwable 360 camera"). A fragment that fits two longer names is ambiguous and kept.
 */
export function mergeProductNames(names: string[]): Map<string, string> {
  const uniq = [...new Set(names)];
  const out = new Map<string, string>();
  for (const n of uniq) {
    const w = words(n);
    if (!w.length) continue;
    const homes = uniq.filter((o) => {
      if (o === n) return false;
      const ow = words(o);
      if (ow.length <= w.length) return false;
      for (let i = 0; i + w.length <= ow.length; i++) if (w.every((x, j) => ow[i + j] === x)) return true;
      return false;
    });
    if (homes.length === 1) out.set(n, homes[0]);
  }
  return out;
}

/**
 * The part of a model that video titles actually contain: a code with letters and digits ("R40",
 * "Z930M") wins; otherwise a model of more than 3 words is cut to its first 2. Shorter models are
 * returned as they are.
 */
export function coreModel(model: string): string {
  const parts = model.trim().split(/\s+/).filter(Boolean);
  const code = parts.find((p) => /[a-z]/i.test(p) && /\d/.test(p));
  if (code) return code;
  return parts.length > 3 ? parts.slice(0, 2).join(" ") : parts.join(" ");
}
