/**
 * Script formats. Each one = outline rules + word budgets + the beat template (how its open loop
 * is planted and paid off). The countdown is the original pipeline; the others reuse the same
 * outline -> beats -> sections -> checks path with their own section plan.
 *   countdown:          N items, last = #1 ("which one is number one?" is the loop)
 *   versus:             exactly 2 items -> A, B, head to head, verdict
 *   myth-vs-reality:    N myths -> each myth stated, then the reality (sourced facts only)
 *   history-of:         N chapters in time order -> what happened, why it mattered next
 *   every-x-explained:  N types -> what it is, who it is for, the trade-off
 */

export const FORMAT_IDS = ["countdown", "versus", "myth-vs-reality", "history-of", "every-x-explained"] as const;
export type FormatId = (typeof FORMAT_IDS)[number];

export interface PlannedSection {
  kind: "intro" | "product" | "compare" | "outro";
  /** The item (product / myth / chapter / type) of a body section. */
  product?: string;
  rank?: number;
  weight: number;
  /** What the writer is asked to write in this section. */
  what: string;
  /** The rule-mode opening line (no model). */
  lead: string;
  /** Items whose facts this section may state. */
  factItems: string[];
}

export interface FormatSpec {
  id: FormatId;
  label: string;
  /** What the items are called on the page ("Products", "Myths"...). */
  items: string;
  itemHint: string;
  minItems: number;
  maxItems: number;
  /** One line for the outline / beats prompt. */
  rules: string;
  plan: (topic: string, items: string[]) => PlannedSection[];
  /** The open loop when the model plans none: question, the words said at the payoff, where. */
  loop: (sections: { kind: string; product?: string; rank?: number }[]) => { question: string; answerKey: string; plantedInSection: number; paidOffInSection: number } | null;
}

const intro = (what: string, lead: string): PlannedSection => ({ kind: "intro", weight: 0.08, what, lead, factItems: [] });
const outro = (what: string, lead: string, w = 0.05): PlannedSection => ({ kind: "outro", weight: w, what, lead, factItems: [] });

export const FORMATS: Record<FormatId, FormatSpec> = {
  countdown: {
    id: "countdown",
    label: "Countdown (ranked list)",
    items: "Products",
    itemHint: "Countdown order: the last one is your #1.",
    minItems: 2,
    maxItems: 15,
    rules: "A ranked countdown: each item gets its rank, the #1 comes last and is teased from the start.",
    plan: (topic, items) => [
      intro(`The INTRO of a countdown video about ${topic}. Tease the #1 pick without naming it.`, ""),
      ...items.map((p, i): PlannedSection => ({ kind: "product", product: p, rank: items.length - i, weight: (i === items.length - 1 ? 1.2 : 1) * (0.87 / items.length), what: `The section for #${items.length - i}: ${p}. Start by naming the product and its rank.`, lead: `Number ${items.length - i} is the ${p}.`, factItems: [p] })),
      outro(`The OUTRO of a countdown video about ${topic}.`, `That wraps up our list of ${topic}.`),
    ],
    loop: (secs) => {
      const top = secs.findIndex((s) => s.kind === "product" && s.rank === 1);
      return top > 0 ? { question: "Which one is number one?", answerKey: secs[top].product ?? "", plantedInSection: 0, paidOffInSection: top } : null;
    },
  },
  versus: {
    id: "versus",
    label: "Versus (A vs B)",
    items: "The two sides",
    itemHint: "Exactly two: A and B.",
    minItems: 2,
    maxItems: 2,
    rules: "Two contenders: A on its own, B on its own, then head to head on the same points, then one clear verdict for each kind of buyer.",
    plan: (topic, [a, b]) => [
      intro(`The INTRO of a head-to-head video: ${a} vs ${b} (${topic}). Say why this match-up matters; do not give the verdict.`, `${a} or ${b}?`),
      { kind: "product", product: a, weight: 0.3, what: `The section on ${a} on its own: what it does well and where it falls short.`, lead: `First, the ${a}.`, factItems: [a] },
      { kind: "product", product: b, weight: 0.3, what: `The section on ${b} on its own: what it does well and where it falls short.`, lead: `Now the ${b}.`, factItems: [b] },
      { kind: "compare", weight: 0.2, what: `Head to head: ${a} vs ${b} on the same points, one point at a time.`, lead: `Head to head, ${a} against ${b}.`, factItems: [a, b] },
      outro(`The VERDICT: which one to pick for which kind of viewer, and why.`, `So which one should you pick?`, 0.12),
    ],
    loop: (secs) => ({ question: "One detail decides this match-up: which one?", answerKey: "deciding factor", plantedInSection: 0, paidOffInSection: secs.length - 1 }),
  },
  "myth-vs-reality": {
    id: "myth-vs-reality",
    label: "Myth vs reality",
    items: "Myths",
    itemHint: "One myth per line; the biggest myth last.",
    minItems: 2,
    maxItems: 12,
    rules: "Each section states one common myth plainly, then the reality, using only the sourced facts. The most costly myth comes last.",
    plan: (topic, items) => [
      intro(`The INTRO of a myth-busting video about ${topic}. Tease that the last myth is the one that costs people most, without saying it.`, `Most of what people repeat about ${topic} is wrong.`),
      ...items.map((m, i): PlannedSection => ({ kind: "product", product: m, rank: items.length - i, weight: (i === items.length - 1 ? 1.2 : 1) * (0.87 / items.length), what: `Myth: "${m}". State the myth in one plain sentence, then the reality.`, lead: `Myth: ${m}.`, factItems: [m] })),
      outro(`The OUTRO of a myth-busting video about ${topic}.`, `Those are the myths about ${topic}.`),
    ],
    loop: (secs) => {
      const last = secs.map((s) => s.kind).lastIndexOf("product");
      return last > 0 ? { question: "Which myth costs people the most?", answerKey: "costs the most", plantedInSection: 0, paidOffInSection: last } : null;
    },
  },
  "history-of": {
    id: "history-of",
    label: "History of",
    items: "Chapters (in time order)",
    itemHint: "One era or turning point per line, oldest first.",
    minItems: 2,
    maxItems: 10,
    rules: "Chapters in time order: what happened, then why it mattered for the next chapter. One turning point is teased early and named when it comes.",
    plan: (topic, items) => [
      intro(`The INTRO of a history video: the history of ${topic}. Tease that one moment changed everything, without naming it.`, `The story of ${topic} starts earlier than most people think.`),
      ...items.map((c, i): PlannedSection => ({ kind: "product", product: c, rank: i + 1, weight: 0.87 / items.length, what: `Chapter ${i + 1}: ${c}. What happened, then why it mattered for what came next.`, lead: `Chapter ${i + 1}: ${c}.`, factItems: [c] })),
      outro(`The OUTRO of the history of ${topic}: where it stands now.`, `And that is where ${topic} stands today.`),
    ],
    loop: (secs) => ({ question: "One moment changed everything: which one?", answerKey: "turning point", plantedInSection: 0, paidOffInSection: Math.max(1, secs.length - 2) }),
  },
  "every-x-explained": {
    id: "every-x-explained",
    label: "Every X explained",
    items: "Types",
    itemHint: "One type per line.",
    minItems: 2,
    maxItems: 15,
    rules: "Each section explains one type: what it is, who it is for, and its trade-off. The ending says which type fits most people.",
    plan: (topic, items) => [
      intro(`The INTRO of a video explaining every type of ${topic}. Promise a clear answer to which type fits most people, without giving it yet.`, `There are more kinds of ${topic} than most people know.`),
      ...items.map((t, i): PlannedSection => ({ kind: "product", product: t, rank: i + 1, weight: 0.87 / items.length, what: `Type: ${t}. What it is, who it is for, and its trade-off.`, lead: `Next, ${t}.`, factItems: [t] })),
      outro(`The OUTRO: which type fits most people, and when to pick another.`, `So which type is right for you?`, 0.06),
    ],
    loop: (secs) => ({ question: "Which type fits most people?", answerKey: "most people", plantedInSection: 0, paidOffInSection: secs.length - 1 }),
  },
};

export const isFormat = (x: unknown): x is FormatId => typeof x === "string" && (FORMAT_IDS as readonly string[]).includes(x);
export const formatOf = (x: unknown): FormatSpec => FORMATS[isFormat(x) ? x : "countdown"];

/** The format a title (and SOP) points to; countdown when nothing else fits. */
export function suggestFormat(title: string, sop?: { stats?: { sectionsPerVideo?: number } } | null): FormatId {
  const t = title.toLowerCase();
  if (/\bvs\.?\b|\bversus\b|\bor\b[^?]*\?\s*$|\bwhich is better\b/.test(t)) return "versus";
  if (/\bmyths?\b|\btruth about\b|\blies\b|\bwrong about\b|\bmisconceptions?\b|\bactually\b/.test(t)) return "myth-vs-reality";
  if (/\bhistory of\b|\bevolution of\b|\borigins? of\b|\bstory of\b|\bhow .* became\b/.test(t)) return "history-of";
  if (/\bevery (type|kind)\b|\btypes of\b|\bexplained\b|\bevery .* explained\b/.test(t)) return "every-x-explained";
  if (sop?.stats?.sectionsPerVideo === 2) return "versus";
  return "countdown";
}

/** Item list problems for a format (null when fine). */
export function itemsProblem(format: FormatId, items: string[]): string | null {
  const f = FORMATS[format];
  if (items.length < f.minItems) return `${f.label} needs at least ${f.minItems} ${f.items.toLowerCase()}.`;
  if (items.length > f.maxItems) return `${f.label} takes at most ${f.maxItems} ${f.items.toLowerCase()}.`;
  return null;
}
