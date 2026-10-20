import fs from "node:fs";
import { cleanProductName, distinctiveTokens, mergeProductNames } from "../lib/productNames.js";
import path from "node:path";
import { env, hasKey } from "../lib/env.js";
import { run } from "../lib/exec.js";
import { loadGlossary } from "../lib/glossary.js";
import { buildMicroPlan, microConfig, microPlanFile } from "../lib/planner/activeSubject.js";
import { paths } from "../lib/paths.js";
import { heuristicLabels, llmLabels, type SectionLabels } from "../lib/planner/label.js";
import { LlmCache } from "../lib/llmCache.js";
import { routeSegments, type RouteCache } from "../lib/planner/segmentRoute.js";
import { detectSections, scriptHeadings, splitIntoScenes, type ScriptHeading } from "../lib/planner/structure.js";
import { applyBounds, findBounds, type BoundAnchors } from "../lib/planner/introOutro.js";
import { fingerprint, isCached, markDone, projectDir, readJson, writeJson } from "../lib/project.js";
import { Scene, Section, validateScenes } from "../lib/scenes.js";
import { loadStyle } from "../lib/style.js";
import { loadProjectNiche, nicheFingerprintPath } from "../lib/niche.js";
import { applyPlanEdits } from "../lib/planEdits.js";
import type { ScriptSection } from "../lib/scriptImport.js";
import { ffmpegPath, ffprobePath } from "../lib/tools.js";
import type { Aligned } from "./align.js";
import { activeProvider, llmAvailable } from "../lib/agents/llm/llm.js";

export interface PlanOpts {
  project: string;
  channel?: string;
  noLlm?: boolean;
  force?: boolean;
}

async function audioDuration(audio: string): Promise<number> {
  const fp = ffprobePath();
  if (!fp) throw new Error("ffprobe not found");
  const r = await run(fp, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", audio]);
  const d = Number(r.stdout.trim());
  if (!Number.isFinite(d)) throw new Error(`could not read duration of ${audio}`);
  return d;
}

/**
 * Keeps graphic cards at the niche's share of the running time (too many cards reads as a
 * slideshow - YouTube "reused content" risk). Least important cards go first; title cards stay.
 */
function capGraphics(scenes: Scene[], target: number, duration: number, brollQuery: string, log: (m: string) => void): Scene[] {
  const share = () => scenes.filter((s) => s.type === "graphic").reduce((t, s) => t + (s.end - s.start), 0) / duration;
  if (!target || share() <= target) return scenes;
  const before = share();
  const order = ["spec_card", "pros_cons", "price_badge", "intro_card", "end_card"];
  const victims = scenes
    .filter((s) => s.type === "graphic" && s.graphic && order.includes(s.graphic.kind))
    .sort((a, b) => order.indexOf(a.graphic!.kind) - order.indexOf(b.graphic!.kind) || b.id - a.id);
  let changed = 0;
  for (const s of victims) {
    if (share() <= target) break;
    const i = scenes.indexOf(s);
    // Product shots are usually still photos; motion B-roll keeps the video from feeling like a slideshow.
    scenes[i] = { ...s, type: "stock", queries: [brollQuery], graphic: undefined };
    delete scenes[i].graphic;
    changed++;
  }
  log(`[plan] graphic cards ${Math.round(before * 100)}% -> ${Math.round(share() * 100)}% (target ${Math.round(target * 100)}%, ${changed} card(s) turned into footage)`);
  return scenes;
}

/** Two full-screen cards in a row feel like a slideshow: the one that is not a title card becomes footage. */
function splitAdjacentCards(scenes: Scene[], brollQuery: string, log: (m: string) => void): Scene[] {
  const isCard = (s?: Scene) => s?.type === "graphic";
  const isTitle = (s: Scene) => s.graphic?.kind === "title_card";
  let changed = 0;
  for (let i = 1; i < scenes.length; i++) {
    if (!isCard(scenes[i]) || !isCard(scenes[i - 1])) continue;
    const j = !isTitle(scenes[i]) ? i : !isTitle(scenes[i - 1]) ? i - 1 : -1;
    if (j < 0) continue;
    const s = { ...scenes[j], type: "stock" as const, queries: [brollQuery] };
    delete s.graphic;
    scenes[j] = s;
    changed++;
  }
  if (changed) log(`[plan] ${changed} card(s) next to another card turned into footage`);
  return scenes;
}

/**
 * Imported scripts carry their own sections (one beat per paragraph). Each section starts at the
 * first aligned sentence of its paragraph. Unranked lists get no "#N" (rank stays undefined).
 */
export function sectionsFromScript(beats: ScriptSection[], aligned: Pick<Aligned, "sentences">, duration: number): Section[] {
  const out: Section[] = [];
  beats.forEach((b, p) => {
    const first = aligned.sentences.find((s) => s.paragraph === p);
    if (!first) return;
    const start = out.length === 0 ? 0 : first.start;
    if (out.length) out[out.length - 1].end = start;
    // A non-product beat between items ("Buying guide") stays "body"; only the last one is the outro
    // (scriptSections marks it). It used to become "outro", i.e. a "Final thoughts" chapter mid-video.
    out.push({ id: out.length, kind: b.kind, start, end: duration, ...(b.label ? { label: b.label } : {}), ...(b.product_name ? { product_name: b.product_name } : {}) });
  });
  // Merge consecutive non-product beats (e.g. a short "Subscribe" between items) into the previous section.
  const merged: Section[] = [];
  for (const s of out) {
    const prev = merged[merged.length - 1];
    if (prev && s.kind !== "item" && s.end - s.start < 15) prev.end = s.end;
    else merged.push({ ...s, id: merged.length });
  }
  return merged;
}

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const MULT: Record<string, number> = { hundred: 100, thousand: 1000, million: 1e6, k: 1000 };

/** Numbers a narration says, as digits ("$70", "1,299") or words ("a hundred and ninety-nine", "five to six hundred"). */
export function spokenNumbers(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/\d[\d,]*(?:\.\d+)?/g)) out.push(Number(m[0].replace(/,/g, "")));
  const toks = text.toLowerCase().replace(/-/g, " ").split(/[^a-z0-9.]+/).filter(Boolean);
  let total = 0, cur = 0, inNum = false;
  const flush = () => {
    if (inNum) out.push(total + cur);
    total = 0; cur = 0; inNum = false;
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t in UNITS) (cur += UNITS[t]), (inNum = true);
    else if (t in TENS) (cur += TENS[t]), (inNum = true);
    else if (t === "a" && MULT[toks[i + 1]]) (cur = 1), (inNum = true);
    else if (t in MULT && inNum) {
      if (MULT[t] === 100) cur *= 100;
      else (total += cur * MULT[t]), (cur = 0);
    } else if (t === "and" && inNum && (UNITS[toks[i + 1]] !== undefined || TENS[toks[i + 1]] !== undefined)) continue;
    else flush();
  }
  flush();
  // "five to six hundred" / "four thousand to seven thousand": the first number takes the multiplier.
  for (const m of text.toLowerCase().matchAll(/\b([a-z]+)\s+to\s+[a-z]+\s+(hundred|thousand)\b/g)) {
    const v = UNITS[m[1]] ?? TENS[m[1]];
    if (v !== undefined) out.push(v * MULT[m[2]]);
  }
  return out;
}

/** A price card only shows prices the narration says (no LLM-invented "$299.99"). */
export function priceCardSaid(g: { price?: string; lines?: string[] }, said: string): boolean {
  const shown = spokenNumbers([g.price ?? "", ...(g.lines ?? [])].join(" ")).filter((n) => n > 0);
  if (!shown.length) return false;
  // A weight / size range ("3.13 - 3.23 oz") is not a price: the narration must talk money.
  if (!/(\$|\u20ac|\u00a3|dollar|euro|pound|bucks|price|cost|usd|sells? for|runs? (?:about|around|roughly))/i.test(said)) return false;
  const heard = spokenNumbers(said);
  return shown.every((v) => heard.some((h) => Math.abs(h - v) <= Math.max(1, v * 0.02)));
}

/**
 * Canonical products = the names of the item sections (script headings / detected countdown).
 * A planner label is kept only when it is one of them (or a fragment of one); inside an item
 * section every scene belongs to that section's product. Outside items (intro / outro) a label
 * stays only when the line actually says a distinctive word of that product's name.
 */
export function canonicalLabel(s: Pick<Scene, "text" | "product_name">, sec: Section | undefined, canonical: string[]): string | undefined {
  if (!canonical.length) return s.product_name ?? undefined;
  if (sec?.kind === "item" && sec.product_name) return sec.product_name;
  if (!s.product_name) return undefined;
  const lw = new Set(distinctiveTokens(s.product_name));
  const said = new Set(distinctiveTokens(s.text));
  const best = canonical
    .map((c) => ({ c, hit: distinctiveTokens(c).filter((w) => lw.has(w)).length, saidHit: distinctiveTokens(c).filter((w) => said.has(w)).length }))
    .filter((x) => x.hit > 0 && x.saidHit > 0)
    .sort((a, b) => b.hit - a.hit || b.saidHit - a.saidHit)[0];
  return best?.c;
}

/** LLM output can be internally inconsistent; fix what is fixable instead of failing the plan. */
function repair(scenes: Scene[], sections: Section[], fallback: Scene[]): Scene[] {
  // One name per product: a bare fragment ("Explorer") joins the full name it is part of.
  const merge = mergeProductNames([...scenes, ...sections].map((x) => x.product_name).filter((n): n is string => !!n));
  const canon = (n?: string | null) => { const c = cleanProductName(n); return c ? (merge.get(c) ?? c) : undefined; };
  for (const sec of sections) if (sec.product_name) sec.product_name = canon(sec.product_name);
  const canonical = [...new Set(sections.filter((x) => x.kind === "item" && x.product_name).map((x) => x.product_name!))];
  return scenes.map((s, i) => {
    const sec = sections[s.section];
    const fixed: Scene = { ...s, queries: [...s.queries], product_name: canon(s.product_name) };
    if (canonical.length) {
      const label = canonicalLabel(fixed, sec, canonical);
      if (label) fixed.product_name = label;
      else delete fixed.product_name;
      if (fixed.graphic?.title && !canonical.includes(fixed.graphic.title) && fixed.graphic.kind !== "title_card") fixed.graphic = { ...fixed.graphic, title: fixed.product_name ?? "" };
      if (fixed.type === "stock" && fixed.product_name && sec?.kind === "item") fixed.type = "product";
    }
    // Price cards show only prices the narration says (this line or its neighbours).
    if (fixed.type === "graphic" && fixed.graphic?.kind === "price_badge") {
      const said = [scenes[i - 1]?.text, s.text, scenes[i + 1]?.text].filter(Boolean).join(" ");
      if (!priceCardSaid(fixed.graphic, said)) {
        delete fixed.graphic;
        fixed.type = fixed.product_name ? "product" : "stock";
        if (fixed.product_name) fixed.queries = [fixed.product_name];
      }
    }
    if (fixed.type === "product" && !fixed.product_name) {
      if (sec.product_name) fixed.product_name = sec.product_name;
      else fixed.type = "stock";
    }
    if (fixed.type === "graphic" && !fixed.graphic) fixed.type = fallback[i].type === "graphic" ? "stock" : fallback[i].type;
    // No full-scene intro / end card: both show footage that follows what is said.
    if (fixed.graphic?.kind === "intro_card" || fixed.graphic?.kind === "end_card") {
      delete fixed.graphic;
      fixed.type = "stock";
      fixed.queries = fallback[i].queries.length ? [...fallback[i].queries] : fixed.queries;
    }
    if (fixed.type !== "graphic") delete fixed.graphic;
    if (fixed.type === "product" && fixed.product_name && !fixed.queries.includes(fixed.product_name)) {
      fixed.queries.unshift(fixed.product_name);
    }
    if (!fixed.queries.length) fixed.queries = fallback[i].queries.length ? fallback[i].queries : ["landscape"];
    return fixed;
  });
}

export async function plan(opts: PlanOpts, log: (m: string) => void = console.log): Promise<number> {
  const dir = projectDir(opts.project);
  const alignedFile = path.join(dir, "aligned.json");
  if (!fs.existsSync(alignedFile)) {
    log(`[plan] ${alignedFile} missing. Run \`clipforge align\` first.`);
    return 1;
  }
  const project = readJson<{ name?: string; audio: string; channel?: string; niche?: string }>(path.join(dir, "project.json"));
  if (!project.name) project.name = opts.project;
  const channel = opts.channel ?? project.channel ?? "default";
  const style = loadStyle(channel);
  const glossaryFile = path.join(paths.inputs, "glossary.txt");
  const useLlm = !opts.noLlm && llmAvailable();
  const niche = loadProjectNiche(project, style);

  const inputs = {
    aligned: fingerprint(alignedFile),
    style: fingerprint(path.join(paths.channels, channel, "style.json")),
    glossary: fingerprint(glossaryFile),
    scriptSections: fingerprint(path.join(dir, "script_sections.json")) + ":" + fingerprint(path.join(dir, "script.txt")) + ":headings-v1",
    niche: `${niche.name}:${fingerprint(nicheFingerprintPath(dir, niche.name))}`,
    labels: `${useLlm ? `${activeProvider()}:${env("LLM_MODEL", "claude-opus-5-5")}` : "heuristic-v5"}:cards-v4:route-v1:bounds-v1`,
    micro: JSON.stringify(microConfig(niche)) + "micro-v1",
  };
  if (!opts.force && isCached(dir, "plan", inputs, ["scenes.json"])) {
    log(`[plan] cached -> ${path.join(dir, "scenes.json")} (use --force to redo)`);
    return 0;
  }

  const aligned = readJson<Aligned>(alignedFile);
  const duration = await audioDuration(project.audio);
  // The video type sets the pacing (documentary shots breathe, explainers cut faster).
  const limits = niche.scenes ?? style.scenes;

  const scriptSecFile = path.join(dir, "script_sections.json");
  const labelled = aligned.mode === "script" && fs.existsSync(scriptSecFile);
  // Plain-text / docx scripts: ranked "#N - Name" lines are the product sections and names.
  const scriptFile = path.join(dir, "script.txt");
  const headings: ScriptHeading[] = !labelled && fs.existsSync(scriptFile) ? scriptHeadings(fs.readFileSync(scriptFile, "utf8")) : [];
  if (headings.length) log(`[plan] script headings: ${headings.map((h) => `#${h.rank} ${h.name}`).join(" | ")}`);
  const detected =
    labelled
      ? sectionsFromScript(readJson<ScriptSection[]>(scriptSecFile), aligned, duration)
      : niche.structure.detectListicle || headings.length
        ? detectSections(aligned.sentences, duration, loadGlossary(glossaryFile), headings)
        : [{ id: 0, kind: "body" as const, start: 0, end: duration }];
  // Hook / intro / outro from the narration (LLM, regex fallback). A countdown's outro must come
  // after its last "Number N" header.
  const lastItem = [...detected].reverse().find((x) => x.kind === "item");
  const afterIdx = lastItem ? aligned.sentences.findIndex((x) => x.start >= lastItem.start - 0.05) : -1;
  const boundsCache = new LlmCache<BoundAnchors>(path.join(dir, "plan_bounds_cache.json"));
  const bounds = await findBounds(aligned.sentences, duration, { useLlm, afterIdx, log, cache: boundsCache });
  boundsCache.save();
  const sections = applyBounds(detected, bounds, aligned.sentences, duration, limits.minLengthSec, labelled);
  log(`[plan] hook ends ${bounds.hookEnd.toFixed(1)}s${bounds.outroStart !== undefined ? `, outro from ${bounds.outroStart.toFixed(1)}s` : ", no outro found"} (${bounds.source})`);
  const spans = splitIntoScenes(sections, aligned.words, limits);
  log(`[plan] video type: ${niche.label}`);
  log(`[plan] ${sections.length} sections: ${sections.map((s) => (s.kind === "item" ? `${s.rank !== undefined ? `#${s.rank} ` : ""}${s.product_name ?? "?"}` : s.kind)).join(" | ")}`);
  log(`[plan] ${spans.length} scenes (avg ${(duration / spans.length).toFixed(1)}s)`);

  const fallback = heuristicLabels(spans, sections, niche);
  let scenes = fallback;
  let cost = 0;
  // Per-section / per-line LLM answers keyed by their text: an edit re-asks only for what changed.
  const labelCache = new LlmCache<SectionLabels>(path.join(dir, "plan_labels_cache.json"));
  const routeCache: RouteCache = new LlmCache(path.join(dir, "plan_route_cache.json"));
  if (useLlm) {
    const res = await llmLabels(spans, sections, log, niche, labelCache);
    if (res) {
      scenes = repair(res.scenes, sections, fallback);
      // Pricing per 1M tokens (input, output) for the models this tool is expected to use.
      const price: Record<string, [number, number]> = {
        "claude-opus-5-5": [4, 20],
        "claude-sonnet-5-5": [2, 10],
        "claude-haiku-4-5": [1, 5],
      };
      // Match by prefix so dated ids like "claude-haiku-4-5-20251001" still price correctly.
      const modelId = env("LLM_MODEL", "claude-opus-5-5");
      const [pin, pout] = Object.entries(price).find(([k]) => modelId.startsWith(k))?.[1] ?? [4, 20];
      // Qwen calls are priced from the Settings page (0 for a local model), not as a Claude model.
      const qwen = activeProvider() === "qwen";
      cost = qwen ? 0 : (res.inputTokens * pin + res.outputTokens * pout) / 1e6;
      log(`[plan] LLM tokens in=${res.inputTokens} out=${res.outputTokens} ${qwen ? "on Qwen (spend counted in Settings -> AI model)" : `est. cost $${cost.toFixed(3)}`}`);
    }
  } else {
    log(`[plan] no ANTHROPIC_API_KEY (or --no-llm): using heuristic labels`);
  }

  scenes = capGraphics(scenes, niche.structure.targetGraphicShare, duration, niche.stock.fallbackQuery, log);
  scenes = splitAdjacentCards(scenes, niche.stock.fallbackQuery, log);
  scenes = await routeSegments(scenes, niche, project.name ?? opts.project, useLlm, log, routeCache);
  labelCache.save();
  routeCache.save();
  const kept = applyPlanEdits(dir, scenes);
  if (kept) log(`[plan] kept ${kept} footage search edit(s) from the plan review`);

  const v = validateScenes(scenes, duration, limits);
  const lengths = scenes.map((s) => s.end - s.start);
  const typeCounts = scenes.reduce<Record<string, number>>((m, s) => ((m[s.type] = (m[s.type] ?? 0) + 1), m), {});
  const report = {
    duration: Math.round(duration * 1000) / 1000,
    sections: sections.length,
    scenes: scenes.length,
    minLength: Math.min(...lengths).toFixed(2),
    maxLength: Math.max(...lengths).toFixed(2),
    avgLength: (duration / scenes.length).toFixed(2),
    types: typeCounts,
    segments: scenes.reduce<Record<string, number>>((m, s) => (s.segment ? ((m[s.segment] = (m[s.segment] ?? 0) + 1), m) : m), {}),
    labeledBy: scenes.some((s) => s.labeledBy === "llm") ? "llm" : "heuristic",
    llmCostUsd: Math.round(cost * 1000) / 1000,
    valid: v.ok,
    errors: v.errors,
  };

  writeJson(path.join(dir, "scenes.json"), scenes);
  writeJson(path.join(dir, "sections.json"), sections);
  writeJson(path.join(dir, "plan_report.json"), report);

  log(`[plan] lengths min ${report.minLength}s / avg ${report.avgLength}s / max ${report.maxLength}s`);
  log(`[plan] types ${JSON.stringify(typeCounts)}`);
  if (!v.ok) {
    log(`[plan] VALIDATION FAILED (${v.errors.length}):`);
    v.errors.slice(0, 10).forEach((e) => log(`[plan]   ${e}`));
    return 1;
  }
  // Fast-paced niches: 2.5-4 s micro-scenes cut on silences / words, each with its active subject.
  const micro = microConfig(niche);
  const ff = ffmpegPath();
  if (micro.enabled && ff) {
    try {
      await buildMicroPlan(dir, { ffmpeg: ff, audio: project.audio, words: aligned.words, scenes, ...micro }, log);
    } catch (err) {
      log(`[micro] skipped: ${String((err as Error).message ?? err).slice(0, 200)}`);
      fs.rmSync(microPlanFile(dir), { force: true });
    }
  } else fs.rmSync(microPlanFile(dir), { force: true });
  markDone(dir, "plan", inputs);
  log(`[plan] schema valid, no gaps, all scenes ${limits.minLengthSec}-${limits.maxLengthSec}s`);
  log(`[plan] wrote ${path.join(dir, "scenes.json")}`);
  return 0;
}
