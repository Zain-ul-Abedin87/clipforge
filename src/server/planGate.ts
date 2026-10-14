import fs from "node:fs";
import path from "node:path";
import { hasKey } from "../lib/env.js";
import { agentEnabled, agentModel } from "../lib/agent/footage.js";
import { FOOTAGE_MODE_LABELS, footageMode, loadProjectNiche } from "../lib/niche.js";
import { nicheProviders } from "../lib/assets/sources.js";
import { paths } from "../lib/paths.js";
import { fingerprint } from "../lib/project.js";
import type { Scene } from "../lib/scenes.js";
import { loadStyle } from "../lib/style.js";

/**
 * Plan approval (VidRush-style "you decide before it gets made"): after step 3 the pipeline stops
 * until the user approves the scene plan. The approval is tied to the exact scenes.json, so any
 * change to the plan (edit, re-plan) needs a new approval before footage is fetched.
 */
export interface ProjectLike {
  channel?: string;
  niche?: string;
  footage?: string;
  /** Set on projects created from the website: stop after the plan and wait for approval. */
  planGate?: boolean;
  planApproval?: { at: string; scenes: string };
}

const scenesFile = (dir: string) => path.join(dir, "scenes.json");

export type GateState = "off" | "waiting" | "approved" | "no-plan";

export function gateState(dir: string, p: ProjectLike): GateState {
  if (!p.planGate) return "off";
  if (!fs.existsSync(scenesFile(dir))) return "no-plan";
  return p.planApproval?.scenes === fingerprint(scenesFile(dir)) ? "approved" : "waiting";
}

export function approval(dir: string): { at: string; scenes: string } {
  return { at: new Date().toISOString(), scenes: fingerprint(scenesFile(dir)) };
}

/** Seconds of render time per second of video, from earlier full renders on this machine. */
function renderSpeed(): number {
  const ratios: number[] = [];
  if (fs.existsSync(paths.workspace)) {
    for (const n of fs.readdirSync(paths.workspace)) {
      const f = path.join(paths.workspace, n, "render_report.json");
      if (!fs.existsSync(f)) continue;
      try {
        const r = JSON.parse(fs.readFileSync(f, "utf8"));
        // Only renders that built every segment (cached re-renders would look too fast).
        if (r.segments && r.segmentsRendered === r.segments && r.durationVideo > 60) ratios.push(r.renderSeconds / r.durationVideo);
      } catch {
        /* ignore broken reports */
      }
    }
  }
  if (!ratios.length) return 0.35;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor(ratios.length / 2)];
}

const SOURCE_LABELS: Record<string, string> = {
  local: "My clips",
  presskit: "Press kit",
  official: "Manufacturer photos",
  wikimedia: "Wikimedia Commons photos",
  wikimedia_video: "Wikimedia Commons video",
  archive: "Archive.org films",
  youtube_cc: "YouTube Creative Commons",
  web_cc: "Web Creative Commons (last resort)",
  storyblocks: "Storyblocks (licensed)",
  pexels: "Pexels",
  pixabay: "Pixabay",
  unsplash: "Unsplash photos",
};

/** What the plan will produce and roughly what it costs, shown before the user approves it. */
export function planEstimate(dir: string, p: ProjectLike) {
  const scenes: Scene[] = JSON.parse(fs.readFileSync(scenesFile(dir), "utf8"));
  const reportFile = path.join(dir, "plan_report.json");
  const report = fs.existsSync(reportFile) ? JSON.parse(fs.readFileSync(reportFile, "utf8")) : {};
  const niche = loadProjectNiche(p, loadStyle(p.channel ?? "default"));
  const duration: number = report.duration ?? scenes[scenes.length - 1]?.end ?? 0;
  const footageScenes = scenes.filter((s) => s.type !== "graphic").length;
  const keyed: Record<string, string> = { storyblocks: "STORYBLOCKS_PUBLIC_KEY", pexels: "PEXELS_API_KEY", pixabay: "PIXABAY_API_KEY", unsplash: "UNSPLASH_ACCESS_KEY" };
  const stock = nicheProviders(niche).map((s) => ({ name: s, label: SOURCE_LABELS[s] ?? s, ready: !keyed[s] || hasKey(keyed[s]) }));
  const speed = renderSpeed();
  // Assets: search + thumbnails + one download per footage scene; slow links make this the long step.
  const assetsMin = Math.max(1, Math.round((footageScenes * 7) / 60));
  const renderMin = Math.max(1, Math.round((duration * speed) / 60));
  return {
    videoType: niche.label,
    footageMode: FOOTAGE_MODE_LABELS[footageMode(p)],
    durationSec: Math.round(duration),
    scenes: scenes.length,
    avgSceneSec: scenes.length ? Math.round((duration / scenes.length) * 10) / 10 : 0,
    pacing: niche.scenes ?? loadStyle(p.channel ?? "default").scenes,
    types: report.types ?? {},
    footageScenes,
    editedScenes: scenes.filter((s) => s.edited).length,
    productSources: niche.product.sources.map((s) => SOURCE_LABELS[s] ?? s),
    stockSources: stock,
    labeledBy: report.labeledBy ?? "heuristic",
    planCostUsd: report.llmCostUsd ?? 0,
    footageAgent: agentEnabled() ? agentModel() : null,
    estMinutes: { assets: assetsMin, render: renderMin, total: assetsMin + renderMin + 1 },
  };
}
