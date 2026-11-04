import fs from "node:fs";
import path from "node:path";
import { paths } from "../../lib/paths.js";
import { readJson } from "../../lib/project.js";
import { PIPELINE_STAGES, readConfig, readState, saveConfig, STAGE_LABELS, VideoType } from "../../lib/orchestrator/pipeline.js";
import { projectSlug } from "../../lib/orchestrator/wizard.js";
import { explainerDir, parseScriptMd, readExplainerInput, saveExplainerInput, THEMES } from "../../lib/formats/explainer.js";
import { readTutorialInput, readTutorialScenes, recordingPath, saveTutorialInput, saveTutorialScenes, tooLong } from "../../lib/formats/tutorial.js";

/**
 * Explainer and tutorial videos (web/make.html). Steps run through /api/pipeline/:project/run
 * (writing = write, render = make the video + QA).
 *   POST /api/make                    {type, topic, title?, points?, sources?, seconds?, theme?, notes?, channel?} -> {project}
 *   GET  /api/make/:project           everything the page shows
 *   PUT  /api/make/:project/script    {text}   explainer: the creator's edited script.md (kept on the next write)
 *   POST /api/make/:project/fresh     explainer: the next write makes a new script
 *   PUT  /api/make/:project/scenes    {texts: {id: text}}   tutorial: the edited voice-over
 * The screen recording is uploaded with POST /api/make/:project/recording (server.ts, streamed).
 */
export type RouteResult = { status: number; body: unknown } | null;
const NAME = /^[a-z0-9][a-z0-9-]{1,60}$/;
const exists = (n: string) => fs.existsSync(path.join(paths.workspace, n));

export function createMade(b: Record<string, unknown>): { project: string } {
  const type = b.type === "explainer" || b.type === "tutorial" ? (b.type as VideoType) : null;
  if (!type) throw new Error("type must be explainer or tutorial");
  const topic = String(b.topic ?? "").trim();
  if (!topic) throw new Error(type === "explainer" ? "Please enter what the video explains." : "Please enter what the tutorial is about.");
  const lines = (v: unknown) => (Array.isArray(v) ? v.map(String) : String(v ?? "").split(/\n/)).map((x) => x.trim()).filter(Boolean);
  // Validate the inputs before anything is written (a refused request leaves no project folder).
  if (type === "explainer" && !lines(b.points).length) throw new Error("Add at least one point the video must explain (one per line).");
  if (type === "tutorial" && String(b.notes ?? "").trim().split(/\s+/).length < 5) throw new Error("Write a few sentences about what the recording shows (the voice-over is written from them).");
  const project = typeof b.project === "string" && NAME.test(b.project) && exists(b.project) ? b.project : projectSlug(topic, exists);
  saveConfig(project, { type, topic, products: [], channel: typeof b.channel === "string" ? b.channel : "default" });
  if (type === "explainer") saveExplainerInput(project, { topic, title: typeof b.title === "string" ? b.title : undefined, points: lines(b.points), sources: lines(b.sources), seconds: Number(b.seconds) || 90, theme: typeof b.theme === "string" ? b.theme : undefined });
  else saveTutorialInput(project, { topic, notes: String(b.notes ?? "") });
  return { project };
}

export function madeView(project: string) {
  const cfg = readConfig(project);
  const st = readState(project);
  const dir = path.join(paths.workspace, project);
  const qaFile = path.join(dir, "qa_report.json");
  const base = {
    project,
    type: cfg?.type ?? "ranked",
    topic: cfg?.topic ?? "",
    stages: PIPELINE_STAGES.filter((s) => s === "writing" || s === "render").map((s) => ({ id: s, label: STAGE_LABELS[s], status: st.stages[s].status, hint: st.stages[s].hint ?? null, last: (st.stages[s].log ?? []).slice(-1)[0] ?? "" })),
    hasVideo: fs.existsSync(path.join(paths.output, `${project}.mp4`)),
    hasSubtitles: fs.existsSync(path.join(paths.output, `${project}.srt`)),
    qa: fs.existsSync(qaFile) ? readJson<{ summary: unknown; checks: unknown[] }>(qaFile) : null,
  };
  if (cfg?.type === "explainer") {
    const sf = path.join(explainerDir(project), "script.md");
    const cf = path.join(explainerDir(project), "clipforge_check.json");
    const text = fs.existsSync(sf) ? fs.readFileSync(sf, "utf8") : "";
    return { ...base, input: readExplainerInput(project), themes: THEMES, script: text, scenes: text ? parseScriptMd(text).scenes.length : 0, check: fs.existsSync(cf) ? readJson(cf) : null };
  }
  const scenes = readTutorialScenes(project);
  return { ...base, input: readTutorialInput(project), recording: recordingPath(project) ? path.basename(recordingPath(project)!) : null, scenes: scenes.map((s) => ({ ...s, tooLong: tooLong(s) })) };
}

export async function makeRoute(parts: string[], method: string, body: () => Promise<string>): Promise<RouteResult> {
  if (parts[1] !== "make") return null;
  const json = async () => JSON.parse((await body()) || "{}") as Record<string, unknown>;
  try {
    if (!parts[2]) {
      if (method !== "POST") return { status: 405, body: { error: "POST" } };
      return { status: 200, body: createMade(await json()) };
    }
    const project = parts[2];
    if (!NAME.test(project) || !exists(project) || !readConfig(project)) return { status: 404, body: { error: "no such video" } };
    const type = readConfig(project)?.type;
    if (!parts[3] && method === "GET") return { status: 200, body: madeView(project) };
    if (parts[3] === "script" && method === "PUT" && type === "explainer") {
      const text = String((await json()).text ?? "").replace(/\r\n/g, "\n");
      const parsed = parseScriptMd(text);
      if (!parsed.scenes.length) return { status: 400, body: { error: 'The script needs at least one scene: a line "## scene-name" followed by its narration.' } };
      fs.writeFileSync(path.join(explainerDir(project), "script.md"), text.trim() + "\n", "utf8");
      fs.writeFileSync(path.join(explainerDir(project), ".script-edited"), new Date().toISOString());
      return { status: 200, body: madeView(project) };
    }
    if (parts[3] === "fresh" && method === "POST" && type === "explainer") {
      // "Write it again": the AI writes a new script on the next run.
      fs.rmSync(path.join(explainerDir(project), ".script-edited"), { force: true });
      return { status: 200, body: madeView(project) };
    }
    if (parts[3] === "scenes" && method === "PUT" && type === "tutorial") {
      const texts = (await json()).texts;
      if (!texts || typeof texts !== "object") return { status: 400, body: { error: "texts must be {sceneId: text}" } };
      saveTutorialScenes(project, Object.fromEntries(Object.entries(texts as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")])));
      return { status: 200, body: madeView(project) };
    }
    return { status: 404, body: { error: "unknown make route" } };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
}
