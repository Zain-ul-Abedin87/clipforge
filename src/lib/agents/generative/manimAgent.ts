import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { SpecVisualTag } from "../../../domain/product.types.js";
import { env, hasKey } from "../../env.js";
import { run } from "../../exec.js";
import { ffmpegPath, venvPythonPath } from "../../tools.js";
import { llm, llmAvailable } from "../llm/llm.js";

/**
 * Fallback technical diagrams for specs nobody films (battery chemistry, voltage, cooling, ANC).
 *
 * Agentic loop after Code2Video (https://github.com/showlab/Code2Video, re-implemented, no code
 * copied): Claude plans and writes one Manim scene -> a static safety check -> Manim renders it ->
 * on failure the exact error goes back to Claude for a fix (up to MANIM_ATTEMPTS). When Manim, the
 * API key or every attempt fails, an FFmpeg template diagram is drawn instead, so the pipeline
 * never stops on a missing visual.
 *
 * Model-written Python runs on this machine, so the code is screened first: only manim / math /
 * numpy / random imports, no file, OS, network, eval / exec or dunder access, no LaTeX; it runs in
 * a temp folder with a time limit.
 */

export interface DiagramRequest {
  spec: SpecVisualTag;
  /** "EGO LM2135SP" */
  product: string;
  /** The narration lines about the spec: the only source of facts and numbers. */
  narration: string;
  /** 3-8 s */
  seconds: number;
  outFile: string;
}

export interface DiagramResult {
  file: string;
  engine: "manim" | "template";
  attempts: number;
  /** Why Manim was not used / every attempt's error, for the log and manifest. */
  notes: string[];
}

/** Writes Manim code for a request; `lastError` is the previous attempt's failure. */
export type ManimCoder = (req: DiagramRequest, lastCode?: string, lastError?: string) => Promise<string>;

// ---------------------------------------------------------------------------------------------
// Safety screen (pure)

const ALLOWED_IMPORTS = new Set(["manim", "math", "numpy", "random"]);
const FORBIDDEN: [RegExp, string][] = [
  [/\b(open|exec|eval|compile|input|breakpoint|globals|locals|vars|getattr|setattr|delattr|__import__)\s*\(/, "file / dynamic-code builtin"],
  [/__\w+__/, "dunder access"],
  [/\b(os|sys|subprocess|socket|shutil|pathlib|requests|urllib|http|ctypes|importlib|pickle|builtins|threading|multiprocessing|signal|tempfile|glob|io)\b\s*\./, "OS / network module"],
  [/\b(MathTex|Tex|SVGMobject|ImageMobject|Code)\s*\(/, "LaTeX / external file mobject"],
];

/** Problems that stop the code from running; empty = OK to render. */
export function checkManimCode(code: string): string[] {
  const problems: string[] = [];
  if (!/^\s*from manim import \*/m.test(code)) problems.push('must start with "from manim import *"');
  if (!/class\s+SpecScene\s*\(\s*Scene\s*\)\s*:/.test(code)) problems.push("must define class SpecScene(Scene)");
  // [ \t] not \s: an import never spans lines (\s would swallow the next line into the module name).
  for (const m of code.matchAll(/^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import|import[ \t]+([\w., \t]+))/gm)) {
    const mods = (m[1] ?? m[2]).split(",").map((x) => x.trim().split(/\s+as\s+/)[0].split(".")[0]).filter(Boolean);
    for (const mod of mods) if (!ALLOWED_IMPORTS.has(mod)) problems.push(`import of "${mod}" is not allowed`);
  }
  for (const [re, why] of FORBIDDEN) if (re.test(code)) problems.push(`not allowed: ${why} (${re.exec(code)![0].trim()})`);
  return [...new Set(problems)];
}

// ---------------------------------------------------------------------------------------------
// Claude coder (Anthropic SDK, structured output)

const CodeSchema = z.object({
  plan: z.string(),
  code: z.string(),
});

const SYSTEM = `You write one short Manim Community (v0.19) animation for a tech product video: a clean explanatory diagram of one internal spec, shown full screen for a few seconds.

Rules:
- Return complete Python: start with "from manim import *", define "class SpecScene(Scene)" with a construct() method. Allowed imports: manim, math, numpy, random. Nothing else.
- No LaTeX: use Text(...), never MathTex/Tex. No images, SVGs, files, network, os/sys, eval/exec.
- Landscape 16:9, dark background (self.camera.background_color = "#0f172a"), white / cyan / amber accents, font size >= 28 so it reads on a phone.
- Total run time close to the requested seconds (sum of run_time and wait calls).
- Show the mechanism as simple shapes and labelled arrows (e.g. cells -> battery management -> motor, with a moving dot for energy flow).
- Facts: use ONLY facts and numbers present in the narration. Never invent specs, numbers or claims. If the narration has no numbers, show none.
- Put the product name small in a corner and the spec name as the title.`;

export function claudeCoder(): ManimCoder {
  const client = llm();
  // Its own model setting: LLM_MODEL is often a small/older model chosen for cheap scene labels.
  const model = env("MANIM_MODEL", "claude-opus-5-5");
  // effort + server-side refusal fallback exist on the current Opus / Fable / Sonnet 5.5 line only.
  const modern = /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);
  return async (req, lastCode, lastError) => {
    const ask = lastError
      ? `The previous code failed. Fix it and return the full corrected file.\n\nError:\n${lastError.slice(-2500)}\n\nPrevious code:\n${lastCode ?? ""}`
      : "Write the scene.";
    const res = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      ...(modern ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      output_config: modern ? { effort: "medium", format: betaZodOutputFormat(CodeSchema) } : { format: betaZodOutputFormat(CodeSchema) },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `${JSON.stringify({ product: req.product, spec: req.spec.spec, shot_idea: req.spec.visual, narration: req.narration, seconds: req.seconds })}\n\n${ask}`,
        },
      ],
    });
    if (res.stop_reason === "refusal") throw new Error(`model declined (${res.stop_details?.category ?? "no category"})`);
    if (!res.parsed_output?.code) throw new Error(`no code returned (stop_reason ${res.stop_reason})`);
    return res.parsed_output.code;
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering

let manimCache: boolean | undefined;
/** True when the project venv can import manim (checked once per process). */
export function manimAvailable(): boolean {
  if (manimCache !== undefined) return manimCache;
  const py = venvPythonPath();
  manimCache = !!py && spawnSync(py, ["-c", "import manim"], { windowsHide: true, timeout: 60_000 }).status === 0;
  return manimCache;
}

/** Renders SpecScene from `code` to `outFile` (1080p30). Returns null on success, else the error text. */
async function renderManim(code: string, outFile: string, timeoutMs: number): Promise<string | null> {
  const py = venvPythonPath()!;
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-manim-"));
  try {
    const src = path.join(work, "scene.py");
    fs.writeFileSync(src, code);
    const r = await run(py, ["-m", "manim", "render", "-qh", "--fps", "30", "--format", "mp4", "--disable_caching", "--media_dir", work, "-o", "out", src, "SpecScene"], { timeoutMs });
    const produced = findFile(work, "out.mp4");
    if (r.code !== 0 || !produced) return (r.stderr || r.stdout).trim().split(/\r?\n/).slice(-25).join("\n") || `manim exit ${r.code}`;
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.copyFileSync(produced, outFile);
    return null;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function findFile(dir: string, name: string): string | null {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const f = findFile(p, name);
      if (f) return f;
    } else if (e.name === name) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Template fallback (FFmpeg only)

/** Steps drawn left to right for well-known internal specs; anything else shows the spec alone. */
export const FLOWS: Record<string, string[]> = {
  "battery chemistry": ["Lithium-ion cells", "Battery management", "Motor"],
  voltage: ["Battery", "Controller", "Motor"],
  "noise cancelling": ["Microphones", "Anti-noise signal", "Speaker"],
  cooling: ["Cool air in", "Heat sink", "Warm air out"],
  "brushless motor": ["Controller", "Magnetic field", "Rotor spins"],
  battery: ["Battery pack", "Controller", "Motor"],
};

const ffEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\u2019").replace(/%/g, "\\%").replace(/,/g, "\\,");
const fontFile = () => {
  const win = "C:/Windows/Fonts/arialbd.ttf";
  return fs.existsSync(win) ? win.replace(/:/g, "\\:") : "";
};

/** lavfi graph for the template diagram: title, product tag, and steps that appear one by one with connecting bars. */
export function templateGraph(req: Pick<DiagramRequest, "spec" | "product" | "seconds">): string {
  const font = fontFile();
  const ff = font ? `fontfile='${font}':` : "";
  const steps = FLOWS[req.spec.spec] ?? [req.spec.spec.replace(/\b\w/g, (c) => c.toUpperCase())];
  const W = 1920;
  const boxW = 440;
  const gap = steps.length > 1 ? (W - 2 * 160 - steps.length * boxW) / (steps.length - 1) : 0;
  const x0 = steps.length > 1 ? 160 : (W - boxW) / 2;
  const appear = (k: number) => (0.4 + k * Math.min(1.2, (req.seconds - 1.2) / Math.max(1, steps.length))).toFixed(2);
  const parts: string[] = [
    `drawtext=${ff}text='${ffEscape(req.spec.spec.toUpperCase())}':fontsize=72:fontcolor=white:x=(w-text_w)/2:y=170`,
    `drawtext=${ff}text='${ffEscape(req.product)}':fontsize=34:fontcolor=0x94a3b8:x=60:y=h-90`,
  ];
  steps.forEach((label, k) => {
    const x = Math.round(x0 + k * (boxW + gap));
    const t = appear(k);
    parts.push(`drawbox=x=${x}:y=470:w=${boxW}:h=150:color=0x22d3ee@0.9:t=6:enable='gte(t,${t})'`);
    parts.push(`drawtext=${ff}text='${ffEscape(label)}':fontsize=38:fontcolor=white:x=${x}+(${boxW}-text_w)/2:y=530:enable='gte(t,${t})'`);
    if (k > 0) {
      const ax = Math.round(x - gap + 10);
      parts.push(`drawbox=x=${ax}:y=538:w=${Math.max(10, Math.round(gap - 20))}:h=14:color=0xf59e0b@0.95:t=fill:enable='gte(t,${t})'`);
    }
  });
  return `color=c=0x0f172a:s=1920x1080:r=30:d=${req.seconds.toFixed(2)},format=yuv420p,${parts.join(",")}`;
}

export async function renderTemplate(req: DiagramRequest): Promise<string | null> {
  const ff = ffmpegPath();
  if (!ff) return "ffmpeg not found";
  fs.mkdirSync(path.dirname(req.outFile), { recursive: true });
  const r = await run(ff, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", templateGraph(req), "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", req.outFile], { timeoutMs: 120_000 });
  return r.code === 0 && fs.existsSync(req.outFile) ? null : r.stderr.slice(-300) || `ffmpeg exit ${r.code}`;
}

// ---------------------------------------------------------------------------------------------

export const manimEnabled = () => env("MANIM_AGENT", "on").toLowerCase() !== "off";

/** Diagram for one spec: Claude + Manim when possible (with repair loop), else the FFmpeg template. */
export async function generateDiagram(req: DiagramRequest, deps: { coder?: ManimCoder; useManim?: boolean; log?: (m: string) => void } = {}): Promise<DiagramResult> {
  const log = deps.log ?? (() => {});
  const notes: string[] = [];
  const attemptsMax = Math.max(1, Number(env("MANIM_ATTEMPTS", "3")) || 3);
  const canManim = (deps.useManim ?? manimAvailable()) && manimEnabled();
  const coder = deps.coder ?? (llmAvailable() ? claudeCoder() : undefined);
  let attempts = 0;
  if (!canManim) notes.push(manimEnabled() ? "manim is not installed in .venv" : "MANIM_AGENT=off");
  else if (!coder) notes.push("no ANTHROPIC_API_KEY for the diagram agent");
  else {
    let code: string | undefined;
    let error: string | undefined;
    while (attempts < attemptsMax) {
      attempts++;
      try {
        code = await coder(req, code, error);
      } catch (err) {
        notes.push(`attempt ${attempts}: ${String((err as Error).message ?? err).slice(0, 200)}`);
        break;
      }
      const problems = checkManimCode(code);
      if (problems.length) {
        error = `Safety check rejected the code:\n- ${problems.join("\n- ")}`;
        notes.push(`attempt ${attempts}: ${problems.join("; ")}`);
        continue;
      }
      error = (await renderManim(code, req.outFile, Number(env("MANIM_TIMEOUT_MS", "180000")))) ?? undefined;
      if (!error) {
        log(`[diagram] ${req.product} / ${req.spec.spec}: Manim scene rendered (attempt ${attempts})`);
        return { file: req.outFile, engine: "manim", attempts, notes };
      }
      notes.push(`attempt ${attempts}: render failed: ${error.split("\n").pop()?.slice(0, 160)}`);
    }
  }
  const err = await renderTemplate(req);
  if (err) throw new Error(`diagram failed for ${req.spec.spec}: ${err}`);
  log(`[diagram] ${req.product} / ${req.spec.spec}: template diagram (${notes[notes.length - 1] ?? "manim not used"})`);
  return { file: req.outFile, engine: "template", attempts, notes };
}

/** Stable file name for a product + spec diagram. */
export const diagramName = (product: string, spec: string) => `diagram_${crypto.createHash("sha1").update(`${product}|${spec}`).digest("hex").slice(0, 10)}.mp4`;
