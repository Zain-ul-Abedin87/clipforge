import { env, hasKey } from "../env.js";

/**
 * Where a scene's new clip can be generated from a reference image (image-to-video):
 *  - flow: Google Flow in the browser (free with a Google AI plan, manual round trip, no key).
 *  - veo:  Google's Gemini API (GEMINI_API_KEY), official @google/genai SDK.
 *  - runway: Runway's API (RUNWAYML_API_SECRET), official @runwayml/sdk. Runway also hosts Google's
 *    Veo 3.1 and ByteDance's Seedance 2, so one Runway key reaches Runway, Veo and Seedance.
 * Model ids and limits below are copied from the SDKs' own type definitions
 * (@google/genai 2.30.0 cookbook ids, @runwayml/sdk 4.22.0 ImageToVideoCreateParams).
 * Kling is not here: its API docs could not be checked, and nothing is added unverified.
 */
export type VideoProvider = "flow" | "veo" | "runway";

export interface ModelSpec {
  id: string;
  label: string;
  /** Durations the model accepts (seconds); the clip's length is rounded to the nearest. */
  durations: number[];
  /** Value of the API's 16:9 ratio / aspect field. */
  landscape: string;
}

export const VEO_MODELS: ModelSpec[] = [
  { id: "veo-3.1-fast-generate-preview", label: "Veo 3.1 Fast", durations: [4, 6, 8], landscape: "16:9" },
  { id: "veo-3.1-generate-preview", label: "Veo 3.1", durations: [4, 6, 8], landscape: "16:9" },
  { id: "veo-3.1-lite-generate-preview", label: "Veo 3.1 Lite", durations: [4, 6, 8], landscape: "16:9" },
];

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
export const RUNWAY_MODELS: ModelSpec[] = [
  { id: "gen4.5", label: "Runway Gen-4.5", durations: range(2, 10), landscape: "1280:720" },
  { id: "gen4_turbo", label: "Runway Gen-4 Turbo", durations: range(2, 10), landscape: "1280:720" },
  { id: "veo3.1_fast", label: "Veo 3.1 Fast (via Runway)", durations: [4, 6, 8], landscape: "1280:720" },
  { id: "veo3.1", label: "Veo 3.1 (via Runway)", durations: [4, 6, 8], landscape: "1280:720" },
  { id: "seedance2_fast", label: "Seedance 2 Fast (via Runway)", durations: range(4, 10), landscape: "1280:720" },
  { id: "seedance2", label: "Seedance 2 (via Runway)", durations: range(4, 10), landscape: "1280:720" },
];

export const modelsOf = (p: VideoProvider): ModelSpec[] => (p === "veo" ? VEO_MODELS : p === "runway" ? RUNWAY_MODELS : []);

/** The accepted duration closest to (and preferably not shorter than) the clip. */
export function pickDuration(spec: ModelSpec, seconds: number): number {
  const longer = spec.durations.filter((d) => d >= seconds);
  return longer.length ? Math.min(...longer) : Math.max(...spec.durations);
}

export const geminiKey = () => env("GEMINI_API_KEY") || env("GOOGLE_API_KEY");

export interface ProviderInfo {
  id: VideoProvider;
  label: string;
  paid: boolean;
  ready: boolean;
  /** Why it is not ready, in plain words. */
  why: string | null;
  models: ModelSpec[];
}

export function videoProviders(): ProviderInfo[] {
  return [
    { id: "flow", label: "Google Flow (in your browser)", paid: false, ready: true, why: null, models: [] },
    { id: "veo", label: "Google Veo API", paid: true, ready: !!geminiKey(), why: geminiKey() ? null : "Add GEMINI_API_KEY to .env (Google AI Studio key).", models: VEO_MODELS },
    { id: "runway", label: "Runway API (Runway, Veo, Seedance)", paid: true, ready: hasKey("RUNWAYML_API_SECRET"), why: hasKey("RUNWAYML_API_SECRET") ? null : "Add RUNWAYML_API_SECRET to .env (Runway developer key).", models: RUNWAY_MODELS },
  ];
}
