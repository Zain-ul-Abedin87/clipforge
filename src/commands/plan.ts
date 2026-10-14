import fs from "node:fs";
import path from "node:path";
import { env, hasKey } from "../lib/env.js";
import { run } from "../lib/exec.js";
import { loadGlossary } from "../lib/glossary.js";
import { paths } from "../lib/paths.js";
import { heuristicLabels, llmLabels } from "../lib/planner/label.js";
import { detectSections, splitIntoScenes } from "../lib/planner/structure.js";
import { fingerprint, isCached, markDone, projectDir, readJson, writeJson } from "../lib/project.js";
import { Scene, Section, validateScenes } from "../lib/scenes.js";
import { loadStyle } from "../lib/style.js";
import { loadProjectNiche, nicheFingerprintPath } from "../lib/niche.js";
import { applyPlanEdits } from "../lib/planEdits.js";
import type { ScriptSection } from "../lib/scriptImport.js";
import { ffprobePath } from "../lib/tools.js";
import type { Aligned } from "./align.js";

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
function sectionsFromScript(beats: ScriptSection[], aligned: Aligned, duration: number): Section[] {
  const out: Section[] = [];
  beats.forEach((b, p) => {
    const first = aligned.sentences.find((s) => s.paragraph === p);
    if (!first) return;
    const start = out.length === 0 ? 0 : first.start;
    if (out.length) out[out.length - 1].end = start;
    const kind = b.kind === "body" ? "outro" : b.kind;
    out.push({ id: out.length, kind, start, end: duration, ...(b.product_name ? { product_name: b.product_name } : {}) });
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

/** LLM output can be internally inconsistent; fix what is fixable instead of failing the plan. */
function repair(scenes: Scene[], sections: Section[], fallback: Scene[]): Scene[] {
  return scenes.map((s, i) => {
    const sec = sections[s.section];
    const fixed: Scene = { ...s, queries: [...s.queries] };
    if (fixed.type === "product" && !fixed.product_name) {
      if (sec.product_name) fixed.product_name = sec.product_name;
      else fixed.type = "stock";
    }
    if (fixed.type === "graphic" && !fixed.graphic) fixed.type = fallback[i].type === "graphic" ? "stock" : fallback[i].type;
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
  const useLlm = !opts.noLlm && hasKey("ANTHROPIC_API_KEY");
  const niche = loadProjectNiche(project, style);

  const inputs = {
    aligned: fingerprint(alignedFile),
    style: fingerprint(path.join(paths.channels, channel, "style.json")),
    glossary: fingerprint(glossaryFile),
    scriptSections: fingerprint(path.join(dir, "script_sections.json")),
    niche: `${niche.name}:${fingerprint(nicheFingerprintPath(dir, niche.name))}`,
    labels: `${useLlm ? env("LLM_MODEL", "claude-opus-5-5") : "heuristic-v5"}:cards-v2`,
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
  const sections =
    aligned.mode === "script" && fs.existsSync(scriptSecFile)
      ? sectionsFromScript(readJson<ScriptSection[]>(scriptSecFile), aligned, duration)
      : niche.structure.detectListicle
        ? detectSections(aligned.sentences, duration, loadGlossary(glossaryFile))
        : [{ id: 0, kind: "body" as const, start: 0, end: duration }];
  const spans = splitIntoScenes(sections, aligned.words, limits);
  log(`[plan] video type: ${niche.label}`);
  log(`[plan] ${sections.length} sections: ${sections.map((s) => (s.kind === "item" ? `${s.rank !== undefined ? `#${s.rank} ` : ""}${s.product_name ?? "?"}` : s.kind)).join(" | ")}`);
  log(`[plan] ${spans.length} scenes (avg ${(duration / spans.length).toFixed(1)}s)`);

  const fallback = heuristicLabels(spans, sections, niche);
  let scenes = fallback;
  let cost = 0;
  if (useLlm) {
    const res = await llmLabels(spans, sections, log, niche);
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
      cost = (res.inputTokens * pin + res.outputTokens * pout) / 1e6;
      log(`[plan] LLM tokens in=${res.inputTokens} out=${res.outputTokens} est. cost $${cost.toFixed(3)}`);
    }
  } else {
    log(`[plan] no ANTHROPIC_API_KEY (or --no-llm): using heuristic labels`);
  }

  scenes = capGraphics(scenes, niche.structure.targetGraphicShare, duration, niche.stock.fallbackQuery, log);
  scenes = splitAdjacentCards(scenes, niche.stock.fallbackQuery, log);
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
  markDone(dir, "plan", inputs);
  log(`[plan] schema valid, no gaps, all scenes ${limits.minLengthSec}-${limits.maxLengthSec}s`);
  log(`[plan] wrote ${path.join(dir, "scenes.json")}`);
  return 0;
}
