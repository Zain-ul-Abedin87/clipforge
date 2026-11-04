import fs from "node:fs";
import path from "node:path";
import { paths } from "../../lib/paths.js";
import { readJson } from "../../lib/project.js";
import { PIPELINE_STAGES, readConfig, readState, STAGE_LABELS } from "../../lib/orchestrator/pipeline.js";
import { createVideo, readApprovals, saveScript, scriptView, setApproval, shortsOf, wizardStep } from "../../lib/orchestrator/wizard.js";

/**
 * "New video" wizard API (web/new.html). Steps run through /api/pipeline/:project/run.
 *   POST /api/wizard                        {topic, title?, products[], words?, channel?, sources?, project?} -> {project}
 *   GET  /api/wizard/:project               everything the wizard shows (step, stages + hints, outputs)
 *   GET  /api/wizard/:project/script        script + checks (words vs target, numbers without a source)
 *   PUT  /api/wizard/:project/script        {text, approve?}
 *   POST /api/wizard/:project/approve       {what: "script" | "voice", on: boolean}
 *   GET  /api/wizard/:project/short/:file   a finished Short (video)
 */

export type RouteResult = { status: number; body: unknown; file?: string } | null;

export async function wizardRoute(parts: string[], method: string, body: () => Promise<string>): Promise<RouteResult> {
  if (parts[1] !== "wizard") return null;
  const json = async () => JSON.parse((await body()) || "{}") as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String) : String(v ?? "").split(/[\n,]/)).map((x) => x.trim()).filter(Boolean);

  if (!parts[2]) {
    if (method !== "POST") return { status: 405, body: { error: "POST" } };
    const b = await json();
    const sources: Record<string, string[]> = {};
    for (const [k, v] of Object.entries((b.sources ?? {}) as Record<string, unknown>)) sources[k] = list(v);
    try {
      return { status: 200, body: createVideo({ topic: String(b.topic ?? ""), title: b.title ? String(b.title) : undefined, products: list(b.products), words: b.words ? Number(b.words) : undefined, channel: b.channel ? String(b.channel) : undefined, sources, project: b.project ? String(b.project) : undefined }) };
    } catch (err) {
      return { status: 400, body: { error: (err as Error).message } };
    }
  }

  const project = parts[2];
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(project)) return { status: 400, body: { error: "invalid project name" } };
  // Not projectDir(): that would create a folder for any name asked about.
  const dir = path.join(paths.workspace, project);
  if (!fs.existsSync(path.join(dir, "pipeline.json"))) return { status: 404, body: { error: "no such video" } };

  if (!parts[3] && method === "GET") {
    const st = readState(project);
    const p = readJson<{ title?: string; channel?: string }>(path.join(dir, "project.json"));
    const qaFile = path.join(dir, "qa_report.json");
    const sourcesFile = path.join(dir, "sources.json");
    return {
      status: 200,
      body: {
        project,
        title: p.title ?? project,
        config: readConfig(project),
        sources: fs.existsSync(sourcesFile) ? readJson(sourcesFile) : {},
        step: wizardStep(project),
        approvals: readApprovals(project),
        stages: PIPELINE_STAGES.map((s) => ({ id: s, label: STAGE_LABELS[s], status: st.stages[s].status, ms: st.stages[s].ms ?? 0, gpuMs: st.stages[s].gpuMs ?? 0, hint: st.stages[s].hint ?? null, last: (st.stages[s].log ?? []).slice(-1)[0] ?? "" })),
        hasVoice: fs.existsSync(path.join(dir, "voiceover_tts.wav")) || !!readJson<{ audio?: string }>(path.join(dir, "project.json")).audio,
        hasVideo: fs.existsSync(path.join(paths.output, `${project}.mp4`)),
        shorts: shortsOf(project),
        qa: fs.existsSync(qaFile) ? readJson<{ summary: unknown }>(qaFile).summary : null,
      },
    };
  }

  if (parts[3] === "script") {
    if (method === "GET") return { status: 200, body: scriptView(project) };
    if (method === "PUT") {
      const b = await json();
      try {
        return { status: 200, body: saveScript(project, String(b.text ?? ""), b.approve === true) };
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } };
      }
    }
  }

  if (parts[3] === "approve" && method === "POST") {
    const b = await json();
    if (b.what !== "script" && b.what !== "voice") return { status: 400, body: { error: "what must be script or voice" } };
    return { status: 200, body: setApproval(project, b.what, b.on !== false) };
  }

  if (parts[3] === "short" && parts[4] && method === "GET") {
    const name = path.basename(parts[4]);
    if (!shortsOf(project).includes(name)) return { status: 404, body: { error: "no such Short" } };
    return { status: 200, body: null, file: path.join(paths.output, name) };
  }

  return { status: 404, body: { error: "unknown wizard route" } };
}
