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
 * Everyday words that name a kind of thing or a quality, never a brand or a model on their own
 * ("waterproof case", "armored gloves", "Pro version earbuds"). Product-agnostic.
 */
const GENERIC_WORDS = new Set(
  (
    "a an the and or of for with in on to by new best top cheap budget premium pro plus max mini ultra lite " +
    "version edition model series generation gen type style kind set kit pack bundle combo " +
    "case cases bag bags pen pens glove gloves tool tools camera cameras headset headsets earbud earbuds earmuff earmuffs " +
    "earplug earplugs mount mounts backpack backpacks light lights flashlight lamp knife knives phone phones watch speaker " +
    "charger cable battery batteries holder cover strap belt box bottle chair table shoe shoes jacket shirt hat helmet vest " +
    "device devices gadget gadgets gear equipment accessory accessories product products item items thing system " +
    "tactical special waterproof armored armoured laser resistant heavy duty portable wireless smart electric cordless digital " +
    "rugged compact small large big mini personal professional outdoor indoor military police"
  ).split(" "),
);

export const isGenericWord = (w: string) => GENERIC_WORDS.has(w.toLowerCase());

/** Model tokens that identify a product: anything with a digit, or a non-generic word of 3+ letters. */
export function distinctiveTokens(model: string | null | undefined): string[] {
  return words(model ?? "").filter((t) => /\d/.test(t) || (t.length >= 3 && !GENERIC_WORDS.has(t)));
}

/**
 * A name a footage search can treat as one exact product: the brand is a real name (not empty,
 * not lower-case, not only generic words) and the full name has at least one distinctive token.
 * "waterproof case", "Laser-Resistant Gloves", "Tactical Pen" -> false; "Olight O'Pen Pro" -> true.
 */
export function looksBranded(brand: string | null | undefined, model: string | null | undefined): boolean {
  const b = (brand ?? "").trim();
  if (!b || !/^[A-Z0-9]/.test(b)) return false;
  const bw = words(b);
  if (!bw.length || bw.every((w) => GENERIC_WORDS.has(w))) return false;
  if (!hasModelToken(model)) return false;
  return distinctiveTokens(`${b} ${model ?? ""}`).length > 0;
}

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
