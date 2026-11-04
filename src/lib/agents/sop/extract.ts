import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { paths } from "../../paths.js";
import { originalityReport } from "../script/originality.js";
import { askJson, approxTokens, chunkByTokens, promptBudget } from "../llm/json.js";
import { corpusOf, cuesIn, HOOK_TYPES, hookTypeOf, pctOf, Prepared, prepareTranscript, quotes, stripQuoted, TranscriptMeta } from "./transcript.js";

/**
 * Competitor SOP extractor: 5-10 transcripts of one competitor -> a reusable "how they build a
 * video" (hook formula, beat sheet with target positions, rules, do / don't). Copy the structure,
 * never the wording: the model is told to describe techniques, any answer that quotes 6 words in a
 * row is refused, and at the end every 5-word run that matches a transcript is stripped from the
 * SOP (then checked again with the originality checker).
 *   map:    each transcript in chunks that fit the 8K context -> notes per chunk (unit numbers, not
 *           positions; the code turns units into % of the video), merged per transcript in code;
 *   reduce: the per-video analyses (compact, no quotes) -> one SOP, in groups when they do not fit;
 *   stats:  word counts, wpm, re-hook spacing, CTA positions... are computed, not asked for.
 */

const Tech = z.string().min(3).max(160);
const ChunkNotes = z.object({
  hook: z.object({ type: z.enum(HOOK_TYPES), technique: Tech, promise: Tech }).nullable(),
  rehooks: z.array(z.object({ unit: z.number().int(), technique: Tech })).max(12),
  loops: z.array(z.object({ plantedUnit: z.number().int(), paidOffUnit: z.number().int().nullable(), technique: Tech })).max(8),
  sections: z.array(z.object({ unit: z.number().int(), opens: Tech, closes: Tech })).max(15),
  factIntro: z.array(Tech).max(5),
  transitions: z.array(Tech).max(6),
  turns: z.array(z.object({ unit: z.number().int(), kind: z.enum(["but", "therefore"]), technique: Tech })).max(10),
  cta: z.array(z.object({ unit: z.number().int(), technique: Tech })).max(4),
  ending: Tech.nullable(),
});
type ChunkNotes = z.infer<typeof ChunkNotes>;

export const SopSchema = z.object({
  hookFormula: z.object({ type: z.enum(HOOK_TYPES), steps: z.array(Tech).min(2).max(6), withinSeconds: z.number().min(5).max(90) }),
  beats: z.array(z.object({ name: z.string().min(2).max(60), targetPct: z.number().min(0).max(100), technique: Tech })).min(4).max(20),
  rules: z.array(Tech).min(3).max(15),
  do: z.array(Tech).min(2).max(12),
  dont: z.array(Tech).min(2).max(12),
});
export type SopCore = z.infer<typeof SopSchema>;

export interface Analysis {
  id: string;
  words: number;
  durationSec: number | null;
  estimatedDuration: boolean;
  wpm: number | null;
  avgSentenceWords: number | null;
  hook: { type: (typeof HOOK_TYPES)[number]; technique: string; promise: string };
  rehooks: { pct: number; technique: string }[];
  loops: { plantedPct: number; paidOffPct: number | null; technique: string }[];
  sections: { pct: number; sharePct: number; opens: string; closes: string }[];
  factIntro: string[];
  transitions: string[];
  turns: { pct: number; kind: "but" | "therefore"; technique: string }[];
  cta: { pct: number; technique: string }[];
  ending: string;
  chunks: { model: number; fallback: number };
}

export interface Sop extends SopCore {
  version: 1;
  channel: string;
  competitor: string;
  builtAt: string;
  transcripts: { id: string; words: number; durationSec: number | null; estimatedDuration: boolean }[];
  stats: {
    videos: number;
    avgWords: number;
    wpm: number | null;
    avgSentenceWords: number | null;
    hookTypes: Record<string, number>;
    rehookEveryPct: number | null;
    rehookEverySec: number | null;
    ctaPct: number[];
    sectionsPerVideo: number;
    sectionSharePct: number | null;
    loopsPerVideo: number;
    loopsPaidOffShare: number | null;
  };
  meta: { mapChunks: { model: number; fallback: number }; reduce: "model" | "fallback"; leaksRemoved: number; originality: { maxNgram: number; clean: boolean } };
}

const SYSTEM_MAP = `You study how a YouTube script is BUILT, not what it says. You get numbered lines [n] of a transcript part.
Return JSON describing techniques in your own words (max 20 words each). NEVER quote or paraphrase closely: describe the move ("asks a question the video answers at the end"), not the content.
- hook: only if this part contains line [0]: the type of opening (question / bold_claim / story / stakes / other), the technique, and the promise made to the viewer. Else null.
- rehooks: lines where attention is restarted (a tease, a new question, "but there's a problem"), with the technique.
- loops: a question or promise planted (line) and where it is paid off (line, or null if not in this part).
- sections: lines where a new item or section starts; how it opens and how it closes.
- factIntro: how specs / facts / numbers are introduced. transitions: how one section hands to the next.
- turns: "but" (complication) or "therefore" (consequence) turns, with the line.
- cta: lines that ask for an action (subscribe, comment, link). ending: how the video ends, if this part has the end; else null.
Use only line numbers that appear in the input.`;

const SYSTEM_REDUCE = `You turn analyses of several videos from one YouTube channel into a reusable writing SOP (standard operating procedure) that another channel can follow with completely different words.
Return JSON:
- hookFormula: the most common opening type, 2-6 steps describing how the hook is built, and within how many seconds the promise is made.
- beats: the ordered beat sheet (4-20 beats), each with a name, its target position in % of the runtime (0 = start, 100 = end) and the technique.
- rules: 3-15 rules the channel follows. do / dont: 2-12 items each.
Describe techniques only. Never include sentences, phrases, product names or claims from the videos.`;

/** The model's notes, or the rule-based ones, for one chunk of units. */
async function mapChunk(p: Prepared, units: Prepared["units"], corpus: Set<string>, log: (m: string) => void): Promise<{ notes: ChunkNotes; source: "model" | "fallback" }> {
  const lo = units[0].i;
  const hi = units[units.length - 1].i;
  const user = `Transcript part (lines ${lo}-${hi} of ${p.units.length}${hi === p.units.length - 1 ? ", the END of the video" : ""}):\n${units.map((u) => `[${u.i}] ${u.text}`).join("\n")}`;
  const r = await askJson({
    stage: "script",
    schema: ChunkNotes,
    system: SYSTEM_MAP,
    user,
    label: `sop ${p.id} ${lo}-${hi}`,
    maxTokens: 1500,
    log,
    validate: (v) => {
      const inPart = (n: number) => n >= lo && n <= hi;
      const bad = [...v.rehooks.map((x) => x.unit), ...v.sections.map((x) => x.unit), ...v.turns.map((x) => x.unit), ...v.cta.map((x) => x.unit), ...v.loops.map((x) => x.plantedUnit)].filter((n) => !inPart(n));
      if (bad.length) return `line numbers ${bad.slice(0, 5).join(", ")} are not in lines ${lo}-${hi}`;
      if (v.loops.some((l) => l.paidOffUnit !== null && (l.paidOffUnit < l.plantedUnit || l.paidOffUnit >= p.units.length))) return "a loop is paid off before it is planted or after the end";
      if (lo === 0 && !v.hook) return "this part has line [0]: describe the hook";
      const texts = [v.hook?.technique, v.hook?.promise, ...v.rehooks.map((x) => x.technique), ...v.loops.map((x) => x.technique), ...v.sections.flatMap((x) => [x.opens, x.closes]), ...v.factIntro, ...v.transitions, ...v.turns.map((x) => x.technique), ...v.cta.map((x) => x.technique), v.ending].filter((x): x is string => !!x);
      const quoted = texts.find((t) => quotes(t, corpus, 6));
      return quoted ? `"${quoted.slice(0, 80)}" copies the transcript's words; describe the technique in your own words` : null;
    },
    fallback: () => ruleNotes(p, units),
  });
  return { notes: r.value, source: r.source };
}

/** Rule-based notes from cue phrases (no model). Descriptions are fixed texts, never the transcript. */
export function ruleNotes(p: Prepared, units: Prepared["units"]): ChunkNotes {
  const n: ChunkNotes = { hook: null, rehooks: [], loops: [], sections: [], factIntro: [], transitions: [], turns: [], cta: [], ending: null };
  if (units[0].i === 0) {
    const opening = p.units.slice(0, 6).map((u) => u.text).join(" ");
    const type = hookTypeOf(opening);
    n.hook = { type, technique: { question: "opens on a question the video promises to answer", stakes: "opens on what the viewer could lose or get wrong", story: "opens inside a short story or moment in time", bold_claim: "opens on a strong claim or surprising number", other: "opens straight on the topic" }[type], promise: "says early what the viewer will know by the end" };
  }
  for (const u of units) {
    for (const c of cuesIn(u.text)) {
      if (c.kind === "rehook" && n.rehooks.length < 12) n.rehooks.push({ unit: u.i, technique: c.technique });
      if (c.kind === "cta" && n.cta.length < 4) n.cta.push({ unit: u.i, technique: c.technique });
      if (c.kind === "section" && n.sections.length < 15) n.sections.push({ unit: u.i, opens: c.technique, closes: "ends on a short verdict before moving on" });
      if ((c.kind === "but" || c.kind === "therefore") && n.turns.length < 10) n.turns.push({ unit: u.i, kind: c.kind, technique: c.technique });
      if (c.kind === "plant" && n.loops.length < 8) n.loops.push({ plantedUnit: u.i, paidOffUnit: null, technique: c.technique });
    }
    if (/\d/.test(u.text) && n.factIntro.length < 1) n.factIntro.push("states a number, then says what it means for the viewer");
  }
  if (units[units.length - 1].i === p.units.length - 1) n.ending = n.cta.length ? "wraps up, then asks for an action" : "wraps up with a final verdict";
  return n;
}

/** One transcript -> its analysis (map over chunks that fit the context, merged in code). */
export async function analyseTranscript(p: Prepared, corpus: Set<string>, log: (m: string) => void = () => {}): Promise<Analysis> {
  const room = Math.min(2600, promptBudget("script", 1500) - approxTokens(SYSTEM_MAP) - 200);
  const chunks = chunkByTokens(p.units, (u) => `[${u.i}] ${u.text}`, room);
  const all: ChunkNotes[] = [];
  const src = { model: 0, fallback: 0 };
  for (const c of chunks) {
    const r = await mapChunk(p, c, corpus, log);
    all.push(r.notes);
    src[r.source]++;
  }
  const pct = (u: number) => pctOf(p, u);
  const sectionsRaw = all.flatMap((x) => x.sections).sort((a, b) => a.unit - b.unit).filter((s, i, a) => i === 0 || s.unit !== a[i - 1].unit);
  const sections = sectionsRaw.map((s, i) => ({ pct: pct(s.unit), sharePct: Math.round(((i + 1 < sectionsRaw.length ? pct(sectionsRaw[i + 1].unit) : 100) - pct(s.unit)) * 10) / 10, opens: s.opens, closes: s.closes }));
  const first = all[0]?.hook ?? ruleNotes(p, p.units.slice(0, 1)).hook!;
  log(`[sop] ${p.id}: ${p.totalWords} words, ${chunks.length} part(s) (${src.model} by the model, ${src.fallback} by rules), ${sections.length} section(s)`);
  return {
    id: p.id,
    words: p.totalWords,
    durationSec: p.durationSec,
    estimatedDuration: p.estimatedDuration,
    wpm: p.wpm,
    avgSentenceWords: p.avgSentenceWords,
    hook: first,
    rehooks: all.flatMap((x) => x.rehooks).map((r) => ({ pct: pct(r.unit), technique: r.technique })),
    loops: all.flatMap((x) => x.loops).map((l) => ({ plantedPct: pct(l.plantedUnit), paidOffPct: l.paidOffUnit === null ? null : pct(l.paidOffUnit), technique: l.technique })),
    sections,
    factIntro: [...new Set(all.flatMap((x) => x.factIntro))].slice(0, 6),
    transitions: [...new Set(all.flatMap((x) => x.transitions))].slice(0, 6),
    turns: all.flatMap((x) => x.turns).map((t) => ({ pct: pct(t.unit), kind: t.kind, technique: t.technique })),
    cta: all.flatMap((x) => x.cta).map((c) => ({ pct: pct(c.unit), technique: c.technique })),
    ending: all.map((x) => x.ending).filter(Boolean).at(-1) ?? "ends without a clear closing move",
    chunks: src,
  };
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);

export function sopStats(as: Analysis[]): Sop["stats"] {
  const gaps = as.flatMap((a) => {
    const ps = [0, ...a.rehooks.map((r) => r.pct).sort((x, y) => x - y)];
    return ps.slice(1).map((p, i) => p - ps[i]).filter((g) => g > 1);
  });
  const every = median(gaps);
  const dur = median(as.map((a) => a.durationSec ?? 0).filter(Boolean));
  const loops = as.flatMap((a) => a.loops);
  const hookTypes: Record<string, number> = {};
  for (const a of as) hookTypes[a.hook.type] = (hookTypes[a.hook.type] ?? 0) + 1;
  return {
    videos: as.length,
    avgWords: Math.round(as.reduce((s, a) => s + a.words, 0) / Math.max(1, as.length)),
    wpm: median(as.map((a) => a.wpm).filter((x): x is number => x !== null)),
    avgSentenceWords: r1(median(as.map((a) => a.avgSentenceWords).filter((x): x is number => x !== null))),
    hookTypes,
    rehookEveryPct: r1(every),
    rehookEverySec: every !== null && dur ? Math.round((every / 100) * dur) : null,
    ctaPct: as.flatMap((a) => a.cta.map((c) => c.pct)).sort((x, y) => x - y),
    sectionsPerVideo: median(as.map((a) => a.sections.length)) ?? 0,
    sectionSharePct: r1(median(as.flatMap((a) => a.sections.map((s) => s.sharePct)))),
    loopsPerVideo: r1(loops.length / Math.max(1, as.length)) ?? 0,
    loopsPaidOffShare: loops.length ? r1(loops.filter((l) => l.paidOffPct !== null).length / loops.length) : null,
  };
}

/** The beat sheet from the numbers alone (no model). */
export function ruleSop(as: Analysis[], st: Sop["stats"]): SopCore {
  const type = (Object.entries(st.hookTypes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "question") as SopCore["hookFormula"]["type"];
  const beats: SopCore["beats"] = [
    { name: "Hook", targetPct: 0, technique: as[0]?.hook.technique ?? "opens on the strongest question of the video" },
    { name: "Promise", targetPct: 3, technique: "says what the viewer will know by the end" },
  ];
  // At most 8 sections and 6 re-hooks, so hook, promise and payoff always fit in the 20 beats.
  const n = Math.max(1, Math.min(8, Math.round(st.sectionsPerVideo)));
  const opens = as.flatMap((a) => a.sections.map((x) => x.opens));
  const common = opens.sort((x, y) => opens.filter((o) => o === y).length - opens.filter((o) => o === x).length)[0];
  for (let i = 0; i < n; i++) beats.push({ name: `Section ${i + 1}`, targetPct: Math.round(8 + (i * 82) / n), technique: common ?? "opens on the item and why it matters, closes on a short verdict" });
  const every = st.rehookEveryPct ? Math.max(st.rehookEveryPct, 80 / 6) : null;
  if (every) for (let p = every; p < 90; p += every) beats.push({ name: "Re-hook", targetPct: Math.round(p), technique: "restarts curiosity with a tease or a new problem" });
  const cta = median(st.ctaPct);
  if (cta !== null) beats.push({ name: "Call to action", targetPct: Math.round(cta), technique: "asks for one action" });
  beats.push({ name: "Payoff and close", targetPct: 95, technique: as[0]?.ending ?? "pays off the opening question, then ends" });
  beats.sort((a, b) => a.targetPct - b.targetPct);
  return {
    hookFormula: { type, steps: ["open on the strongest question or stake of the video", "hold back the answer", "promise what the viewer will get by the end"], withinSeconds: 30 },
    beats,
    rules: ["every section opens on why the item matters", "facts come with what they mean for the viewer", `restart curiosity about every ${st.rehookEverySec ? `${Math.round(st.rehookEverySec / 60) || 1} min` : "few minutes"}`],
    do: ["pay off every question you plant", "keep sentences short and spoken"],
    dont: ["do not give the answer to the opening question early", "do not ask for likes before giving value"],
  };
}

/** Compact text of one analysis for the reduce prompt (techniques and positions only). */
export function renderAnalysis(a: Analysis): string {
  const f = (xs: { pct: number; technique: string }[], k = 6) => xs.slice(0, k).map((x) => `${x.pct}%: ${x.technique}`).join(" | ");
  return [
    `VIDEO ${a.id}: ${a.words} words${a.wpm ? `, ${a.wpm} wpm` : ""}`,
    `hook (${a.hook.type}): ${a.hook.technique}; promise: ${a.hook.promise}`,
    `sections (${a.sections.length}): ${a.sections.slice(0, 5).map((s) => `${s.pct}% opens: ${s.opens}; closes: ${s.closes}`).join(" | ")}`,
    `rehooks: ${f(a.rehooks)}`,
    `loops: ${a.loops.slice(0, 5).map((l) => `${l.plantedPct}%->${l.paidOffPct ?? "?"}%: ${l.technique}`).join(" | ")}`,
    `turns: ${a.turns.slice(0, 6).map((t) => `${t.pct}% ${t.kind}: ${t.technique}`).join(" | ")}`,
    `facts: ${a.factIntro.join(" | ")}`,
    `transitions: ${a.transitions.join(" | ")}`,
    `cta: ${f(a.cta, 3)}`,
    `ending: ${a.ending}`,
  ].join("\n");
}

const renderSop = (s: SopCore) => `SOP DRAFT\nhook (${s.hookFormula.type}, ${s.hookFormula.withinSeconds}s): ${s.hookFormula.steps.join(" / ")}\nbeats: ${s.beats.map((b) => `${b.targetPct}% ${b.name}: ${b.technique}`).join(" | ")}\nrules: ${s.rules.join(" | ")}\ndo: ${s.do.join(" | ")}\ndont: ${s.dont.join(" | ")}`;

async function reduce(items: string[], st: Sop["stats"], as: Analysis[], corpus: Set<string>, log: (m: string) => void, level = 0): Promise<{ sop: SopCore; source: "model" | "fallback" }> {
  const room = promptBudget("script", 2000) - approxTokens(SYSTEM_REDUCE) - 300;
  const groups = chunkByTokens(items, (x) => x, room);
  if (groups.length > 1 && level < 3) {
    log(`[sop] ${items.length} analyses do not fit one request: reducing in ${groups.length} groups`);
    const parts = [];
    for (const g of groups) parts.push(await reduce(g, st, as, corpus, log, level + 1));
    if (parts.every((p) => p.source === "fallback")) return { sop: ruleSop(as, st), source: "fallback" };
    return reduce(parts.map((p) => renderSop(p.sop)), st, as, corpus, log, level + 1);
  }
  const statsLine = `Measured over ${st.videos} videos: re-hook about every ${st.rehookEveryPct ?? "?"}% of the runtime; ${st.sectionsPerVideo} sections per video; CTA at ${st.ctaPct.slice(0, 6).join(", ") || "?"}%; opening types ${JSON.stringify(st.hookTypes)}.`;
  const r = await askJson({
    stage: "script",
    schema: SopSchema,
    system: SYSTEM_REDUCE,
    user: `${statsLine}\n\n${groups[0].join("\n\n")}`,
    label: "sop reduce",
    maxTokens: 2000,
    log,
    validate: (v) => {
      const sorted = [...v.beats].sort((a, b) => a.targetPct - b.targetPct);
      if (sorted[0].targetPct > 5) return "the first beat (the hook) must be at 0-5%";
      if (sorted.at(-1)!.targetPct < 80) return "the beat sheet must reach the end of the video (a beat at 80-100%)";
      const strings = [...v.hookFormula.steps, ...v.beats.map((b) => b.technique), ...v.rules, ...v.do, ...v.dont];
      const q = strings.find((s) => quotes(s, corpus, 6));
      return q ? `"${q.slice(0, 80)}" copies the transcripts; describe the technique instead` : null;
    },
    fallback: () => ruleSop(as, st),
  });
  return { sop: { ...r.value, beats: [...r.value.beats].sort((a, b) => a.targetPct - b.targetPct) }, source: r.source };
}

/** Strips every 5-word run that matches a transcript from all SOP texts. */
export function stripLeaks(s: SopCore, corpus: Set<string>): { sop: SopCore; removed: number } {
  let removed = 0;
  const one = (t: string, fallback: string) => {
    const r = stripQuoted(t, corpus, 5);
    removed += r.removed;
    return r.text ?? fallback;
  };
  const list = (xs: string[]) =>
    xs.flatMap((t) => {
      const r = stripQuoted(t, corpus, 5);
      removed += r.removed;
      return r.text ? [r.text] : [];
    });
  return {
    sop: {
      hookFormula: { ...s.hookFormula, steps: list(s.hookFormula.steps) },
      beats: s.beats.map((b) => ({ ...b, name: one(b.name, "Beat"), technique: one(b.technique, "(technique removed: it matched a transcript)") })),
      rules: list(s.rules),
      do: list(s.do),
      dont: list(s.dont),
    },
    removed,
  };
}

export const sopDir = (channel: string) => path.join(paths.channels, channel, "sop");
export const sopFile = (channel: string, competitor: string) => path.join(sopDir(channel), `${competitor.replace(/[^\w-]/g, "_")}.json`);

export async function buildSop(o: { channel: string; competitor: string; transcripts: { id: string; text: string; meta?: TranscriptMeta }[]; log?: (m: string) => void; save?: boolean }): Promise<Sop> {
  const log = o.log ?? console.log;
  if (!o.transcripts.length) throw new Error("No transcripts: give a folder of .txt transcripts or a competitor channel id (with YOUTUBE_API_KEY).");
  if (o.transcripts.length < 5) log(`[sop] only ${o.transcripts.length} transcript(s): 5-10 give a more reliable SOP`);
  const corpus = corpusOf(o.transcripts.map((t) => t.text), 5);
  const corpus6 = corpusOf(o.transcripts.map((t) => t.text), 6);
  const as: Analysis[] = [];
  for (const t of o.transcripts) {
    const p = prepareTranscript(t.id, t.text, t.meta);
    if (p.totalWords < 50) {
      log(`[sop] ${t.id}: only ${p.totalWords} words, skipped`);
      continue;
    }
    as.push(await analyseTranscript(p, corpus6, log));
  }
  if (!as.length) throw new Error("No usable transcript (each needs at least 50 words).");
  const st = sopStats(as);
  const red = await reduce(as.map(renderAnalysis), st, as, corpus6, log);
  const { sop: core, removed } = stripLeaks(red.sop, corpus);
  // Lists can end up short after stripping: top them up from the rule SOP (fixed texts).
  const base = ruleSop(as, st);
  for (const k of ["rules", "do", "dont"] as const) if (core[k].length < 2) core[k] = [...core[k], ...base[k]].slice(0, 12);
  if (core.hookFormula.steps.length < 2) core.hookFormula.steps = base.hookFormula.steps;
  const texts = [...core.hookFormula.steps, ...core.beats.map((b) => `${b.name}: ${b.technique}`), ...core.rules, ...core.do, ...core.dont];
  const orig = await originalityReport(texts, o.transcripts.map((t) => t.text), { useEmbeddings: false });
  const sop: Sop = {
    version: 1,
    channel: o.channel,
    competitor: o.competitor,
    builtAt: new Date().toISOString(),
    transcripts: as.map((a) => ({ id: a.id, words: a.words, durationSec: a.durationSec, estimatedDuration: a.estimatedDuration })),
    stats: st,
    ...core,
    meta: { mapChunks: as.reduce((s, a) => ({ model: s.model + a.chunks.model, fallback: s.fallback + a.chunks.fallback }), { model: 0, fallback: 0 }), reduce: red.source, leaksRemoved: removed, originality: { maxNgram: orig.maxNgram, clean: orig.maxNgram === 0 } },
  };
  if (o.save !== false) {
    fs.mkdirSync(sopDir(o.channel), { recursive: true });
    fs.writeFileSync(sopFile(o.channel, o.competitor), JSON.stringify(sop, null, 2) + "\n");
  }
  log(`[sop] ${o.channel} <- ${o.competitor}: ${sop.beats.length} beats, ${sop.rules.length} rules, re-hook every ${st.rehookEverySec ?? "?"} s; ${removed} copied word(s) stripped; 5-gram overlap with the transcripts ${orig.maxNgram}`);
  return sop;
}

export function loadSop(channel: string, competitor?: string): Sop | null {
  const dir = sopDir(channel);
  if (!fs.existsSync(dir)) return null;
  const file = competitor ? sopFile(channel, competitor) : fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => path.join(dir, f)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  return file && fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as Sop) : null;
}

export const listSops = (channel: string) => (fs.existsSync(sopDir(channel)) ? fs.readdirSync(sopDir(channel)).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")) : []);

export function sopText(s: Sop): string {
  return [
    `SOP: ${s.channel} <- ${s.competitor} (${s.stats.videos} videos, built ${s.builtAt.slice(0, 10)}; map ${s.meta.mapChunks.model} by model / ${s.meta.mapChunks.fallback} by rules, reduce by ${s.meta.reduce})`,
    `Hook (${s.hookFormula.type}, promise within ${s.hookFormula.withinSeconds} s):`,
    ...s.hookFormula.steps.map((x, i) => `  ${i + 1}. ${x}`),
    `Beats:`,
    ...s.beats.map((b) => `  ${String(b.targetPct).padStart(3)}%  ${b.name}: ${b.technique}`),
    `Rules:`,
    ...s.rules.map((x) => `  - ${x}`),
    `Do:`,
    ...s.do.map((x) => `  + ${x}`),
    `Don't:`,
    ...s.dont.map((x) => `  - ${x}`),
    `Measured: ${s.stats.avgWords} words${s.stats.wpm ? ` at ${s.stats.wpm} wpm` : ""}; re-hook every ${s.stats.rehookEverySec ?? "?"} s (${s.stats.rehookEveryPct ?? "?"}%); ${s.stats.sectionsPerVideo} sections; loops ${s.stats.loopsPerVideo}/video; copied words stripped: ${s.meta.leaksRemoved}`,
  ].join("\n");
}
