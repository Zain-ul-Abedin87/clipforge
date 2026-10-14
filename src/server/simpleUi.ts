import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { hasKey } from "../lib/env.js";
import { paths } from "../lib/paths.js";
import { nichesDir } from "../lib/niche.js";

/**
 * Simple web UI ("Create" page) helpers: app-wide settings (ui_settings.json), the niche the run
 * uses (niches/ui-<guns|tech>.json, derived from guns_web / tech_web with the settings applied),
 * env overrides for the CLI steps, the default Windows TTS voice (script-only mode) and the
 * read-only API key status (never the keys themselves).
 */

export type UiNiche = "guns" | "tech";
export interface AppSettings {
  defaultNiche: UiNiche;
  targetShotSec: Record<UiNiche, number>;
  captions: boolean;
  sources: { webCrawl: boolean; presskit: boolean; stock: boolean };
  webCrawlMode: "fallback" | "always";
}

const FILE = path.join(paths.root, "ui_settings.json");
const BASE: Record<UiNiche, string> = { guns: "guns_web", tech: "tech_web" };
export const DEFAULTS: AppSettings = {
  defaultNiche: "guns",
  targetShotSec: { guns: 2.5, tech: 2.1 },
  captions: false,
  sources: { webCrawl: true, presskit: true, stock: true },
  webCrawlMode: "fallback",
};

export function loadAppSettings(): AppSettings {
  const s = fs.existsSync(FILE) ? (JSON.parse(fs.readFileSync(FILE, "utf8")) as Partial<AppSettings>) : {};
  return {
    ...DEFAULTS,
    ...s,
    targetShotSec: { ...DEFAULTS.targetShotSec, ...(s.targetShotSec ?? {}) },
    sources: { ...DEFAULTS.sources, ...(s.sources ?? {}) },
  };
}

export function saveAppSettings(patch: Partial<AppSettings>): AppSettings {
  const cur = loadAppSettings();
  const num = (v: unknown, d: number) => (typeof v === "number" && v >= 1 && v <= 8 ? Math.round(v * 10) / 10 : d);
  const next: AppSettings = {
    defaultNiche: patch.defaultNiche === "tech" || patch.defaultNiche === "guns" ? patch.defaultNiche : cur.defaultNiche,
    targetShotSec: { guns: num(patch.targetShotSec?.guns, cur.targetShotSec.guns), tech: num(patch.targetShotSec?.tech, cur.targetShotSec.tech) },
    captions: typeof patch.captions === "boolean" ? patch.captions : cur.captions,
    sources: {
      webCrawl: typeof patch.sources?.webCrawl === "boolean" ? patch.sources.webCrawl : cur.sources.webCrawl,
      presskit: typeof patch.sources?.presskit === "boolean" ? patch.sources.presskit : cur.sources.presskit,
      stock: typeof patch.sources?.stock === "boolean" ? patch.sources.stock : cur.sources.stock,
    },
    webCrawlMode: patch.webCrawlMode === "always" || patch.webCrawlMode === "fallback" ? patch.webCrawlMode : cur.webCrawlMode,
  };
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2));
  return next;
}

/** Writes niches/ui-<niche>.json (base niche + settings) and returns its name. */
export function buildUiNiche(niche: UiNiche, s: AppSettings): string {
  const base = JSON.parse(fs.readFileSync(path.join(nichesDir, `${BASE[niche]}.json`), "utf8").replace(/^\uFEFF/, ""));
  const name = `ui-${niche}`;
  base.name = name;
  base.label = `${niche === "guns" ? "Guns" : "Tech"} (simple UI)`;
  const STOCK = new Set(["storyblocks", "pixabay", "pexels", "unsplash", "wikimedia_video", "archive", "youtube_cc"]);
  let src: string[] = (base.stock?.sources ?? ["pixabay", "pexels"]).filter((x: string) => x !== "web_crawl" && (s.sources.stock || !STOCK.has(x)));
  if (s.sources.webCrawl) src.push("web_crawl");
  base.stock = { ...(base.stock ?? {}), sources: src };
  if (!s.sources.presskit && base.product?.sources) base.product.sources = base.product.sources.filter((x: string) => x !== "presskit" && x !== "official");
  base.pacing = { ...(base.pacing ?? {}), enabled: true, targetShotSec: s.targetShotSec[niche] };
  base.productPool = { ...(base.productPool ?? {}), enabled: s.sources.webCrawl };
  fs.writeFileSync(path.join(nichesDir, `${name}.json`), JSON.stringify(base, null, 2));
  return name;
}

/** Env for the CLI child processes. */
export function runEnv(s: AppSettings): Record<string, string> {
  return { WEB_CRAWL: s.sources.webCrawl ? "on" : "off", WEBCRAWL_MODE: s.webCrawlMode };
}

/** Default test voice: Windows System.Speech reads script.txt into a WAV (robotic, testing only). */
export function ttsToWav(scriptFile: string, outWav: string): Promise<{ ok: boolean; error?: string }> {
  const ps = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 1;
$t = Get-Content -Raw -Encoding UTF8 '${scriptFile.replace(/'/g, "''")}';
$t = $t -replace '\\.380','three eighty' -replace '\\bP365\\b','P three sixty-five';
$s.SetOutputToWaveFile('${outWav.replace(/'/g, "''")}'); $s.Speak($t); $s.Dispose()`;
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { windowsHide: true });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0 && fs.existsSync(outWav) ? { ok: true } : { ok: false, error: err.trim().slice(-300) || `exit ${code}` });
    });
    child.on("error", (e) => resolve({ ok: false, error: String(e) }));
  });
}

export function keyStatus(): Record<string, boolean> {
  return {
    ANTHROPIC_API_KEY: hasKey("ANTHROPIC_API_KEY"),
    PIXABAY_API_KEY: hasKey("PIXABAY_API_KEY"),
    PEXELS_API_KEY: hasKey("PEXELS_API_KEY"),
    UNSPLASH_ACCESS_KEY: hasKey("UNSPLASH_ACCESS_KEY"),
    STORYBLOCKS: hasKey("STORYBLOCKS_PUBLIC_KEY") && hasKey("STORYBLOCKS_PRIVATE_KEY"),
    ELEVENLABS_API_KEY: hasKey("ELEVENLABS_API_KEY"),
  };
}
