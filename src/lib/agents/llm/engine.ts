import { hasKey } from "../../env.js";
import { videoProviders, ProviderInfo } from "../../videogen/providers.js";
import { loadLlmSettings, LlmSettings, QWEN_PRESETS, qwenKey, saveLlmSettings } from "./settings.js";

/**
 * The one "AI engine" switch shown at the start of the wizard (and in the editor):
 *   local = the local model only (Ollama on this PC; free, private)
 *   api   = a cloud API only (Claude, else Qwen cloud when only its key is set)
 *   both  = local first, the API when the local model fails or is not running
 *   hybrid = the script (outline, beats, sections; also the SOP extractor, stage "script") on
 *            Claude Sonnet 5.5, every other stage on the local model only. If the Claude key is
 *            missing or its budget is used up, the script falls back to the local model.
 * It only writes llm_settings.json primary / fallback / qwen.mode, the same settings the Classic
 * page edits, so both pages always agree. Video generation (Veo / Runway) is separate: it runs
 * only when its key is set and the creator confirms a paid call.
 */
export type Engine = "local" | "api" | "both" | "hybrid";

/** Hybrid: the script stage on this Claude model, everything else on the local model. */
export const HYBRID_SCRIPT_MODEL = "claude-sonnet-5-5";

export function currentEngine(s: LlmSettings = loadLlmSettings()): Engine | "custom" | "off" {
  if (s.primary === "off") return "off";
  const local = (p: string) => p === "qwen" && s.qwen.mode === "local";
  if (local(s.primary) && s.fallback === "none" && s.stages.script?.provider === "claude") return "hybrid";
  if (local(s.primary) && s.fallback === "none") return "local";
  if (local(s.primary) && s.fallback === "claude") return "both";
  if (!local(s.primary) && (s.fallback === "none" || (s.fallback === "qwen" && s.qwen.mode === "cloud"))) return "api";
  return "custom";
}

export function setEngine(e: Engine, file?: string): LlmSettings {
  // Only "hybrid" gives the script stage its own provider; the other engines clear it.
  const script = e === "hybrid" ? { provider: "claude", claudeModel: HYBRID_SCRIPT_MODEL } : { provider: "", claudeModel: "" };
  saveLlmSettings({ stages: { script } }, file);
  if (e === "local" || e === "hybrid") return saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "local" } }, file);
  if (e === "both") return saveLlmSettings({ primary: "qwen", fallback: "claude", qwen: { mode: "local" } }, file);
  // API: Claude when its key is set; with only a Qwen cloud key, Qwen cloud.
  if (!hasKey("ANTHROPIC_API_KEY") && qwenKey()) return saveLlmSettings({ primary: "qwen", fallback: "none", qwen: { mode: "cloud" } }, file);
  return saveLlmSettings({ primary: "claude", fallback: "none" }, file);
}

export interface EngineStatus {
  engine: Engine | "custom" | "off";
  local: { running: boolean; url: string; model: string };
  api: { claude: boolean; qwenCloud: boolean };
  video: ProviderInfo[];
}

/** Is Ollama answering? (1.5 s timeout; never throws.) */
export async function ollamaRunning(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const r = await fetchImpl(`${baseUrl.replace(/\/v1\/?$/, "")}/api/tags`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function engineStatus(fetchImpl: typeof fetch = fetch): Promise<EngineStatus> {
  const s = loadLlmSettings();
  const url = s.qwen.mode === "local" ? s.qwen.baseUrl : QWEN_PRESETS.local.baseUrl;
  return {
    engine: currentEngine(s),
    local: { running: await ollamaRunning(url, fetchImpl), url, model: s.qwen.mode === "local" ? s.qwen.model : QWEN_PRESETS.local.model },
    api: { claude: hasKey("ANTHROPIC_API_KEY"), qwenCloud: !!qwenKey() },
    video: videoProviders(),
  };
}
