import { z } from "zod";
import { briefPrompt, ChannelBrief } from "../../channelBrief.js";
import { askJson } from "../llm/json.js";
import type { Sop } from "../sop/extract.js";
import { splitSentences } from "./facts.js";
import type { Outline, OutlineSection } from "./outline.js";

/**
 * Retention plan (beat sheet) on top of the outline, and the check that the written script
 * follows it:
 *  - hook: question-first or stakes-first (from the SOP when there is one), the answer withheld;
 *  - promise line within the first 30 s (wpm / 2 words);
 *  - a re-hook about every 3 minutes (wpm x 3 words), each with a technique;
 *  - open loops: planted in one section, paid off in a later one (every loop must be paid off);
 *  - per section: angle, a but / therefore turn, its facts and its word budget.
 * The model proposes hook, promise, angles, turns and loops (JSON, validated); positions, word
 * budgets and the re-hook schedule are computed. Without a model, rules fill in.
 */

export const REHOOK_TECHNIQUES = ["curiosity_gap", "problem", "preview"] as const;
export type RehookTechnique = (typeof REHOOK_TECHNIQUES)[number];

export interface Loop {
  question: string;
  /** Words that must appear where the loop is paid off (e.g. the #1 product's name). */
  answerKey: string;
  plantedInSection: number;
  paidOffInSection: number;
}
export interface BeatSheet {
  format: string;
  wpm: number;
  hook: { type: "question" | "stakes"; idea: string; withheld: string };
  promise: string;
  promiseByWord: number;
  rehookEveryWords: number;
  rehooks: { section: number; atWord: number; technique: RehookTechnique }[];
  loops: Loop[];
  sections: { index: number; startWord: number; words: number; turn: string }[];
  rulesFromSop: string[];
  source: "model" | "fallback";
}

const Plan = z.object({
  hook: z.object({ idea: z.string().min(5).max(300), withheld: z.string().min(2).max(120) }),
  promise: z.string().min(5).max(200),
  sections: z.array(z.object({ index: z.number().int(), angle: z.string().min(5).max(240), turn: z.string().min(5).max(240) })),
  loops: z.array(z.object({ question: z.string().min(5).max(200), answerKey: z.string().min(2).max(80), plantedInSection: z.number().int(), paidOffInSection: z.number().int() })).max(4),
  rehookTechniques: z.array(z.enum(REHOOK_TECHNIQUES)).max(20),
});

const countW = (t: string) => t.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
const label = (s: OutlineSection) => (s.kind === "product" ? `#${s.rank} ${s.product}` : s.kind);

/** Re-hook schedule: every `every` words, at the nearest section start when it is close, else inside the section. */
export function scheduleRehooks(sections: { startWord: number; words: number }[], every: number, total: number): { section: number; atWord: number }[] {
  const out: { section: number; atWord: number }[] = [];
  for (let w = every; w < total - every * 0.4; w += every) {
    let best = 1;
    sections.forEach((s, i) => {
      if (i > 0 && Math.abs(s.startWord - w) < Math.abs(sections[best].startWord - w)) best = i;
    });
    const near = sections[best] && Math.abs(sections[best].startWord - w) <= every * 0.2;
    const idx = near ? best : Math.max(0, sections.findIndex((s) => w >= s.startWord && w < s.startWord + s.words));
    const at = near ? sections[best].startWord : w;
    if (idx > 0 && !out.some((o) => o.section === idx)) out.push({ section: idx, atWord: at });
  }
  return out;
}

export async function planBeats(outline: Outline, o: { brief?: ChannelBrief | null; sop?: Sop | null; format?: string; log?: (m: string) => void } = {}): Promise<BeatSheet> {
  const log = o.log ?? (() => {});
  const wpm = o.brief?.wpm ?? 150;
  const secs = outline.sections;
  let at = 0;
  const pos = secs.map((s) => {
    const p = { startWord: at, words: s.words };
    at += s.words;
    return p;
  });
  const total = at;
  const every = wpm * 3;
  const sched = scheduleRehooks(pos, every, total);
  const hookType: "question" | "stakes" = o.sop?.hookFormula.type === "stakes" ? "stakes" : "question";
  const products = secs.filter((s) => s.kind === "product");
  const top = products.find((s) => s.rank === 1) ?? products.at(-1);
  const topIdx = top ? secs.indexOf(top) : secs.length - 1;
  const rules = o.sop ? [...o.sop.rules.slice(0, 4), ...o.sop.do.slice(0, 2).map((d) => `Do: ${d}`), ...o.sop.dont.slice(0, 2).map((d) => `Don't: ${d}`)] : [];

  const fallback = (): z.infer<typeof Plan> => ({
    hook: { idea: hookType === "question" ? `Which of these ${products.length || "picks"} ${outline.topic} is actually worth your money?` : `Pick the wrong one of these ${outline.topic} and you pay for it twice.`, withheld: top ? `which one is number one (${top.product})` : "the final answer" },
    promise: `By the end you'll know which one fits you, and why number one won.`,
    sections: secs.map((s, index) => ({ index, angle: s.angle, turn: s.kind === "product" ? `But: its main trade-off. Therefore: who should buy it anyway.` : s.kind === "intro" ? "But: the obvious choice is not always the right one. Therefore: stay for the ranking." : "But: no pick is perfect. Therefore: match it to how you will use it." })),
    loops: top ? [{ question: "Which one is number one?", answerKey: top.product ?? "", plantedInSection: 0, paidOffInSection: topIdx }] : [],
    rehookTechniques: sched.map((_, i) => REHOOK_TECHNIQUES[i % 3]),
  });

  const facts = secs.map((s, index) => `${index}. ${label(s)} (${s.words} words)${s.kind === "product" ? `: ${s.angle.slice(0, 160)}` : ""}`).join("\n");
  const r = await askJson({
    stage: "script",
    schema: Plan,
    label: "beats",
    log,
    maxTokens: 1800,
    system: `You plan the retention beats of a ${o.format ?? "countdown"} YouTube script. Return JSON:
- hook: a ${hookType}-first opening idea (under 40 words) that holds back the answer; "withheld" names what is not revealed until later.
- promise: one line said in the first 30 seconds: what the viewer gets by the end.
- sections: for each section index, a one-sentence angle and a "but / therefore" turn (a complication, then what follows from it).
- loops: 1-4 open questions, each planted in an earlier section and paid off in a later one; answerKey = the words that must be said when it is paid off (e.g. the product name).
- rehookTechniques: one per re-hook: curiosity_gap, problem ("but there's a problem") or preview (what's next).
Use only what the sections say; invent no facts or numbers.${o.brief ? `\n${briefPrompt(o.brief)}` : ""}${rules.length ? `\nThe channel's SOP rules:\n${rules.map((x) => `- ${x}`).join("\n")}` : ""}`,
    user: `Topic: ${outline.topic}\nSections (index. name (budget)):\n${facts}\nRe-hooks needed: ${sched.length} (at sections ${sched.map((x) => x.section).join(", ") || "none"}).`,
    validate: (v) => {
      if (v.sections.length !== secs.length || v.sections.some((s, i) => s.index !== i)) return `give exactly ${secs.length} sections, index 0 to ${secs.length - 1} in order`;
      if (countW(v.hook.idea) > 40) return `the hook idea has ${countW(v.hook.idea)} words; keep it under 40`;
      const bad = v.loops.find((l) => l.plantedInSection < 0 || l.paidOffInSection >= secs.length || l.plantedInSection >= l.paidOffInSection);
      if (bad) return `loop "${bad.question.slice(0, 60)}" must be planted in an earlier section than it is paid off (sections 0-${secs.length - 1})`;
      if (!v.loops.length) return "plant at least one open loop (e.g. which one is number one)";
      return null;
    },
    fallback,
  });
  const plan = r.value;
  for (const s of plan.sections) if (secs[s.index] && r.source === "model") secs[s.index].angle = s.angle;
  const sheet: BeatSheet = {
    format: o.format ?? "countdown",
    wpm,
    hook: { type: hookType, idea: plan.hook.idea, withheld: plan.hook.withheld },
    promise: plan.promise,
    promiseByWord: Math.round(wpm / 2),
    rehookEveryWords: every,
    rehooks: sched.map((x, i) => ({ ...x, technique: plan.rehookTechniques[i] ?? REHOOK_TECHNIQUES[i % 3] })),
    loops: plan.loops,
    sections: pos.map((p, index) => ({ index, ...p, turn: plan.sections[index]?.turn ?? "" })),
    rulesFromSop: rules,
    source: r.source,
  };
  log(`[script] beats (${r.source}): ${sheet.hook.type}-first hook, promise by word ${sheet.promiseByWord}, ${sheet.rehooks.length} re-hook(s) every ~${every} words, ${sheet.loops.length} open loop(s)`);
  return sheet;
}

const TECH_TEXT: Record<RehookTechnique, string> = {
  curiosity_gap: "open a curiosity gap: a question the next minute answers",
  problem: 'raise a problem ("but there is a catch") that the section then resolves',
  preview: "preview what is coming next and why it matters",
};

/** The beat instructions one section's writer gets. */
export function beatInstructions(sheet: BeatSheet, index: number): string[] {
  const out: string[] = [];
  if (index === 0) {
    out.push(`Start with the hook (${sheet.hook.type}-first, at most 40 words): ${sheet.hook.idea} End the hook on an open question or an unresolved tease. Do NOT reveal ${sheet.hook.withheld}.`);
    out.push(`Within the first ${sheet.promiseByWord} words, say the promise in your own words: ${sheet.promise}`);
  }
  const rh = sheet.rehooks.find((r) => r.section === index);
  if (rh) {
    const offset = rh.atWord - sheet.sections[index].startWord;
    out.push(`${offset <= 10 ? "Open this section" : `About ${offset} words into this section, place`} a re-hook: one sentence to ${TECH_TEXT[rh.technique]}.`);
  }
  for (const l of sheet.loops.filter((x) => x.plantedInSection === index)) out.push(`Plant this open question and do NOT answer it here: ${l.question}`);
  for (const l of sheet.loops.filter((x) => x.paidOffInSection === index)) out.push(`Pay off the open question "${l.question}" clearly, and say ${l.answerKey}.`);
  const turn = sheet.sections[index]?.turn;
  if (turn) out.push(`Include this but/therefore turn: ${turn}`);
  return out;
}

// --------------------------------------------------------------------------------------- checking

const CURIOSITY = /\?\s*$|\b(but|until|stick around|find out|the answer|surpris\w*|catch|which one|why|what if|wait)\b/i;
const REHOOK_CUE = /\?|\b(but|however|here'?s|coming up|next|wait|still|catch|problem|the question|what if|stick around|surpris\w*)\b/i;
const PROMISE = /\b(by the end|you'?ll (know|see|find out|learn|get)|you will (know|see|find out|learn|get)|i'?ll show|we'?ll (cover|show|find|rank|look|see)|here'?s what|in this video)\b/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** The hook's LAST sentence must leave something open (a question, or a tease that is not resolved). */
const endsOnGap = (hook: string) => CURIOSITY.test(splitSentences(hook).at(-1) ?? "");
const mentions = (text: string, key: string) => !!key.trim() && new RegExp(`(^|[^\\p{L}\\p{N}])${esc(key.trim())}($|[^\\p{L}\\p{N}])`, "iu").test(text);

/** The hook = the opening sentences up to the first question (within 3 sentences), else the first 2. */
export function hookOf(intro: string): string {
  const s = splitSentences(intro);
  const q = s.slice(0, 3).findIndex((x) => /\?\s*$/.test(x));
  return s.slice(0, q >= 0 ? q + 1 : Math.min(2, s.length)).join(" ");
}

/** Problems with one section against its beats (the writer asks again when there are any). */
export function sectionBeatProblems(sheet: BeatSheet, index: number, text: string): string[] {
  const p: string[] = [];
  if (index === 0) {
    const hook = hookOf(text);
    if (countW(hook) > 40) p.push(`the hook (the opening up to the first question) has ${countW(hook)} words; make it 40 or fewer`);
    if (!endsOnGap(hook)) p.push("the hook must end on an open question or an unresolved tease");
    const firstWords = text.split(/\s+/).slice(0, Math.round(sheet.promiseByWord * 1.2)).join(" ");
    if (!PROMISE.test(firstWords)) p.push(`say the promise (what the viewer gets by the end) within the first ${sheet.promiseByWord} words`);
  }
  for (const l of sheet.loops.filter((x) => x.plantedInSection === index)) if (mentions(text, l.answerKey)) p.push(`do not reveal "${l.answerKey}" yet; it is the answer to an open question paid off later`);
  for (const l of sheet.loops.filter((x) => x.paidOffInSection === index)) if (!mentions(text, l.answerKey)) p.push(`pay off the open question by saying "${l.answerKey}"`);
  const rh = sheet.rehooks.find((r) => r.section === index);
  if (rh && !rehookAt(text, rh.atWord - sheet.sections[index].startWord)) p.push("add the re-hook sentence (a question, a catch, or what is coming next)");
  return p;
}

/** Word offset of the re-hook sentence nearest the planned offset, or null when there is none. */
export function rehookAt(text: string, plannedOffset: number): number | null {
  let at = 0;
  let best: number | null = null;
  for (const s of splitSentences(text)) {
    if (REHOOK_CUE.test(s) && (best === null || Math.abs(at - plannedOffset) < Math.abs(best - plannedOffset))) best = at;
    at += countW(s);
  }
  return best;
}

export interface RetentionReport {
  status: "pass" | "warn" | "fail";
  hook: { words: number; curiosityGap: boolean; ok: boolean };
  promise: { found: boolean; byWord: number };
  rehooks: { planned: number; found: number; targetWords: number; gaps: number[]; ok: boolean };
  loops: { question: string; paidOff: boolean; revealedEarly: boolean }[];
  overBudget: { section: string; words: number; budget: number }[];
  problems: string[];
}

/** The retention_beats check over the final sections. */
export function retentionReport(sheet: BeatSheet, sections: { label: string; text: string; budget: number }[]): RetentionReport {
  const problems: string[] = [];
  const intro = sections[0]?.text ?? "";
  const hook = hookOf(intro);
  const hw = countW(hook);
  const gap = endsOnGap(hook) && !sheet.loops.some((l) => l.plantedInSection === 0 && mentions(hook, l.answerKey));
  if (hw > 40) problems.push(`hook is ${hw} words (max 40)`);
  if (!gap) problems.push("hook does not end on a curiosity gap");
  const firstWords = intro.split(/\s+/).slice(0, Math.round(sheet.promiseByWord * 1.2)).join(" ");
  const promise = PROMISE.test(firstWords);
  if (!promise) problems.push(`no promise line in the first ${sheet.promiseByWord} words`);
  // Actual re-hook positions in the whole script.
  const starts: number[] = [];
  let acc = 0;
  for (const s of sections) {
    starts.push(acc);
    acc += countW(s.text);
  }
  const found: number[] = [];
  for (const r of sheet.rehooks) {
    const s = sections[r.section];
    if (!s) continue;
    const off = rehookAt(s.text, r.atWord - sheet.sections[r.section].startWord);
    if (off !== null) found.push(starts[r.section] + off);
  }
  const marks = [0, ...found.sort((a, b) => a - b)];
  const gaps = marks.slice(1).map((m, i) => m - marks[i]);
  const target = sheet.rehookEveryWords;
  const spacedOk = found.length === sheet.rehooks.length && gaps.every((g) => Math.abs(g - target) <= target * 0.25);
  if (found.length < sheet.rehooks.length) problems.push(`${sheet.rehooks.length - found.length} of ${sheet.rehooks.length} re-hook(s) missing`);
  else if (!spacedOk) problems.push(`re-hook spacing ${gaps.join("/")} words, target ${target} +-25%`);
  const loops = sheet.loops.map((l) => ({
    question: l.question,
    paidOff: mentions(sections[l.paidOffInSection]?.text ?? "", l.answerKey),
    revealedEarly: sections.slice(l.plantedInSection, l.paidOffInSection).some((s) => mentions(s.text, l.answerKey)),
  }));
  for (const l of loops) {
    if (!l.paidOff) problems.push(`loop not paid off: ${l.question}`);
    if (l.revealedEarly) problems.push(`loop answered too early: ${l.question}`);
  }
  const overBudget = sections.filter((s) => countW(s.text) > 2 * s.budget).map((s) => ({ section: s.label, words: countW(s.text), budget: s.budget }));
  for (const o of overBudget) problems.push(`${o.section} is ${o.words} words, over 2x its ${o.budget}`);
  const hard = hw > 40 || loops.some((l) => !l.paidOff) || overBudget.length > 0;
  return {
    status: hard ? "fail" : problems.length ? "warn" : "pass",
    hook: { words: hw, curiosityGap: gap, ok: hw <= 40 && gap },
    promise: { found: promise, byWord: sheet.promiseByWord },
    rehooks: { planned: sheet.rehooks.length, found: found.length, targetWords: target, gaps, ok: spacedOk },
    loops,
    overBudget,
    problems,
  };
}
