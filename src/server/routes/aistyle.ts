import { listChannels } from "../../lib/style.js";
import { learnStyle, loadAiStyle, previewStyle, saveAiStyle, STYLE_PRESETS, styleFileOf } from "../../lib/assets/aiStyle.js";
import { loadFeatures, saveFeatures } from "../../lib/settings/features.js";

/**
 * AI image style of a channel (web/make.html > Documentary > Pictures).
 *   GET  /api/aistyle/:channel             {style, presets, engine}
 *   PUT  /api/aistyle/:channel             {style?, engine?} -> saved
 *   POST /api/aistyle/:channel/learn       -> {look, avoid} from the reference pictures (vision model)
 *   POST /api/aistyle/:channel/preview     {scene} -> {file, url, prompt}: one test picture
 *   GET  /api/aistyle/:channel/file?name=  a reference or preview picture
 * Reference pictures are uploaded with POST /api/aistyle/:channel/ref (server.ts, x-filename).
 */
export type RouteResult = { status: number; body: unknown; file?: string } | null;

export async function aistyleRoute(parts: string[], method: string, body: () => Promise<string>, query: URLSearchParams): Promise<RouteResult> {
  if (parts[1] !== "aistyle") return null;
  const channel = parts[2] ?? "";
  if (!listChannels().includes(channel)) return { status: 400, body: { error: "unknown channel" } };
  const json = async () => JSON.parse((await body()) || "{}") as Record<string, unknown>;
  const view = () => ({ style: loadAiStyle(channel), presets: STYLE_PRESETS, engine: loadFeatures().aistyle.engine });
  try {
    if (!parts[3] && method === "GET") return { status: 200, body: view() };
    if (!parts[3] && method === "PUT") {
      const b = await json();
      if (b.engine === "comfyui" || b.engine === "gemini") saveFeatures({ aistyle: { engine: b.engine } });
      if (b.style && typeof b.style === "object") saveAiStyle(channel, b.style as Record<string, never>);
      return { status: 200, body: view() };
    }
    if (parts[3] === "learn" && method === "POST") return { status: 200, body: await learnStyle(channel) };
    if (parts[3] === "preview" && method === "POST") {
      const scene = String((await json()).scene ?? "").trim();
      if (scene.length < 5) return { status: 400, body: { error: "Describe a scene to test, e.g. 'a harbour at dawn with sailing ships'." } };
      const r = await previewStyle(channel, scene.slice(0, 300));
      return { status: 200, body: { ...r, url: `/api/aistyle/${encodeURIComponent(channel)}/file?name=${encodeURIComponent(r.file)}` } };
    }
    if (parts[3] === "file" && method === "GET") {
      const f = styleFileOf(channel, String(query.get("name") ?? ""));
      return f ? { status: 200, body: null, file: f } : { status: 404, body: { error: "no such picture" } };
    }
    return { status: 404, body: { error: "unknown aistyle route" } };
  } catch (err) {
    return { status: 400, body: { error: (err as Error).message } };
  }
}
