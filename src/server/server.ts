import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { hasKey, reloadEnv } from "../lib/env.js";
import { paths } from "../lib/paths.js";
import { listChannels, loadStyle } from "../lib/style.js";
import { listNiches } from "../lib/niche.js";
import { addPresskitFile, listPresskit, removePresskitFile } from "../lib/assets/presskit.js";
import { applyCandidate, loadCandidates, saveCandidates, searchAlternatives } from "../lib/assets/review.js";
import { FOOTAGE_MODE_LABELS, FOOTAGE_MODES, loadNiche, loadProjectNiche } from "../lib/niche.js";
import { cleanQueries, savePlanEdit } from "../lib/planEdits.js";
import { youtubeStatus } from "../lib/assets/youtube.js";
import { approval, gateState, planEstimate, ProjectLike } from "./planGate.js";
import { saveWordEdit } from "../lib/wordEdits.js";
import { importFile, listLibrary, removeLibraryFile } from "../lib/assets/library.js";
import { createChannel, listMusic, removeLogo, removeMusic, saveLogo, saveMusic, updateStyle } from "../lib/channels.js";
import { BatchQueue } from "./queue.js";
import { importOfficial } from "../lib/assets/official.js";
import { parseScriptHtml, scriptSections, scriptText } from "../lib/scriptImport.js";
import { listReview, reviewThumb, swapShot } from "../lib/sceneReview.js";
import { ALL_CARDS, CARD_FONTS } from "../lib/stylePreset.js";
import { buildUiNiche, keyStatus, loadAppSettings, runEnv, saveAppSettings, ttsToWav, UiNiche } from "./simpleUi.js";
import { detectAndWriteNiche } from "../lib/nicheDetect.js";

const WEB_DIR = path.join(paths.root, "web");
const TSX_CLI = path.join(paths.root, "node_modules", "tsx", "dist", "cli.mjs");
const CLI = path.join(paths.root, "src", "cli.ts");

const STEPS = ["transcribe", "align", "plan", "assets", "timeline", "render", "qa"] as const;
type Step = (typeof STEPS)[number];
const STEP_OUTPUT: Record<Step, string> = { transcribe: "words.json", align: "aligned.json", plan: "scenes.json", assets: "assets.json", timeline: "timeline.json", render: "render_report.json", qa: "qa_report.json" };
const READABLE = new Set(["chapters.json", "facts.json", "candidates.json", "qa_report.json", "approval.json", "words.json", "aligned.json", "scenes.json", "sections.json", "plan_report.json", "drift_report.json", "assets.json", "assets_report.json", "timeline.json", "render_report.json"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a"]);

interface Job {
  running: boolean;
  step: Step | null;
  failedStep: Step | null;
  log: string[];
  startedAt: number;
  finishedAt?: number;
  /** Stopped after the plan: waiting for the user to approve it. */
  awaitingApproval?: boolean;
  /** Stopped after the timeline: waiting for the user to review scenes and press Render. */
  awaitingReview?: boolean;
}
const jobs = new Map<string, Job>();

const validName = (n: string) => /^[A-Za-z0-9_-]{1,64}$/.test(n);
const projDir = (n: string) => path.join(paths.workspace, n);

function readProject(name: string): Record<string, unknown> | null {
  const f = path.join(projDir(name), "project.json");
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null;
}

function writeProject(name: string, patch: Record<string, unknown>): void {
  fs.mkdirSync(projDir(name), { recursive: true });
  const cur = readProject(name) ?? { name };
  fs.writeFileSync(path.join(projDir(name), "project.json"), JSON.stringify({ ...cur, ...patch }, null, 2));
}

function stepStatus(name: string): Record<Step, "done" | "pending" | "running" | "failed"> {
  const job = jobs.get(name);
  const out = {} as Record<Step, "done" | "pending" | "running" | "failed">;
  for (const s of STEPS) {
    if (job?.running && job.step === s) out[s] = "running";
    else if (!job?.running && job?.failedStep === s) out[s] = "failed";
    else out[s] = fs.existsSync(path.join(projDir(name), STEP_OUTPUT[s])) ? "done" : "pending";
  }
  return out;
}

function summary(name: string) {
  const p = readProject(name) ?? {};
  const job = jobs.get(name);
  return {
    name,
    audio: p.audio ? path.basename(String(p.audio)) : null,
    hasScript: fs.existsSync(path.join(projDir(name), "script.txt")),
    channel: p.channel ?? "default",
    niche: p.niche ?? null,
    footage: p.footage ?? "stock_cc",
    planGate: gateState(projDir(name), p as ProjectLike),
    createdAt: p.createdAt ?? null,
    voiceMode: p.voiceMode ?? null,
    steps: stepStatus(name),
    running: job?.running ?? false,
  };
}

function cliArgs(name: string, step: Step, force: boolean, useLlm: boolean): string[] {
  const p = readProject(name) ?? {};
  const args = [step, "--project", name];
  if (step === "transcribe") args.push("--audio", String(p.audio));
  if (step === "align") {
    const script = path.join(projDir(name), "script.txt");
    if (fs.existsSync(script)) args.push("--script", script);
    else args.push("--no-script-mode");
  }
  if (step === "plan") {
    args.push("--channel", String(p.channel ?? "default"));
    if (!useLlm) args.push("--no-llm");
  }
  // QA always re-checks everything and has no --force option.
  if (force && step !== "qa") args.push("--force");
  return args;
}

/** Runs steps as child CLI processes so a crash in one never takes the web server down. */
async function runJob(name: string, steps: Step[], force: boolean, useLlm: boolean, gate = true): Promise<void> {
  reloadEnv();
  const job: Job = { running: true, step: null, failedStep: null, log: [], startedAt: Date.now() };
  jobs.set(name, job);
  const push = (line: string) => {
    job.log.push(line);
    if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
  };

  for (const step of steps) {
    // Plan approval gate: footage is only fetched for a plan the user has approved.
    if (gate && step === "assets" && gateState(projDir(name), (readProject(name) ?? {}) as ProjectLike) === "waiting") {
      job.awaitingApproval = true;
      push("=== plan ready ===");
      push("Review the scene plan, change searches if you like, then press \"Approve plan & make video\".");
      break;
    }
    job.step = step;
    push(`=== ${step} ===`);
    const code = await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [TSX_CLI, CLI, ...cliArgs(name, step, force, useLlm)], {
        cwd: paths.root,
        windowsHide: true,
        // Simple UI settings (web crawl on/off and mode) reach every step.
        env: { ...process.env, ...runEnv(loadAppSettings()) },
      });
      let buf = "";
      const onData = (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          // Hugging Face / tqdm noise is not useful in the UI.
          if (line.trim() && !/UserWarning|warnings\.warn|symlink|developer mode|HF_TOKEN/i.test(line)) push(line);
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("close", (c) => resolve(c ?? 1));
      child.on("error", (e) => {
        push(String(e));
        resolve(1);
      });
    });
    if (code !== 0) {
      job.failedStep = step;
      push(`!!! ${step} failed (exit ${code})`);
      break;
    }
    // Scene review gate: projects created with "review before render" stop after the timeline.
    const pj = readProject(name) ?? {};
    if (step === "timeline" && steps.includes("render") && pj.review === true && !pj.reviewDone) {
      job.awaitingReview = true;
      push("=== review ===");
      push("Scenes ready: review / swap clips, then press Render.");
      break;
    }
  }
  job.running = false;
  job.step = null;
  job.finishedAt = Date.now();
  if (!job.awaitingApproval && !job.awaitingReview) push(job.failedStep ? "Stopped." : "All steps finished.");
}

// Batch queue: one video at a time through every step; waits while any manual run is busy.
let queue: BatchQueue;
let ytStatus: Promise<{ ok: boolean; detail: string }> | undefined;

// ---------- HTTP helpers ----------

function send(res: http.ServerResponse, status: number, body: unknown, type = "application/json"): void {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, limit = 2 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

/** Streams a file with HTTP Range support (needed for seeking in <audio>). */
function streamFile(req: http.IncomingMessage, res: http.ServerResponse, file: string): void {
  const size = fs.statSync(file).size;
  const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.writeHead(206, {
      "Content-Type": type,
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Content-Length": end - start + 1,
    });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": type, "Content-Length": size, "Accept-Ranges": "bytes" });
    fs.createReadStream(file).pipe(res);
  }
}

// ---------- Routes ----------

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const method = req.method ?? "GET";

  if (parts[0] !== "api") {
    // "/" is the simple Create UI (web/simple); the full classic UI stays at /index.html.
    const rel = url.pathname === "/" ? "simple/index.html" : url.pathname.slice(1);
    const file = path.resolve(WEB_DIR, rel);
    if (!file.startsWith(WEB_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, "not found", "text/plain");
    return send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] ?? "application/octet-stream");
  }

  if (parts[1] === "status" && method === "GET") {
    reloadEnv(); // keys added to .env while the server runs show up without a restart
    ytStatus ??= youtubeStatus();
    return send(res, 200, { anthropicKey: hasKey("ANTHROPIC_API_KEY"), storyblocksKey: hasKey("STORYBLOCKS_PUBLIC_KEY") && hasKey("STORYBLOCKS_PRIVATE_KEY"), pexelsKey: hasKey("PEXELS_API_KEY"), pixabayKey: hasKey("PIXABAY_API_KEY"), unsplashKey: hasKey("UNSPLASH_ACCESS_KEY"), youtubeCC: await ytStatus });
  }

  if (parts[1] === "app-settings") {
    reloadEnv();
    if (method === "PUT") return send(res, 200, { settings: saveAppSettings(JSON.parse((await readBody(req)) || "{}")), keys: keyStatus() });
    if (method === "GET") return send(res, 200, { settings: loadAppSettings(), keys: keyStatus() });
  }

  if (parts[1] === "style-meta" && method === "GET") return send(res, 200, { cards: ALL_CARDS, fonts: CARD_FONTS });

  if (parts[1] === "footage-modes" && method === "GET") {
    return send(res, 200, FOOTAGE_MODES.map((m) => ({ name: m, label: FOOTAGE_MODE_LABELS[m] })));
  }

  // Own clips / photos uploaded from the computer (tier 1 footage), with a source note per file.
  if (parts[1] === "library") {
    const channel = url.searchParams.get("channel") ?? "default";
    if (!listChannels().includes(channel)) return send(res, 400, { error: "unknown channel" });
    const lroot = url.searchParams.get("root") === "presskit" ? "presskit" : "footage";
    if (method === "GET") return send(res, 200, listLibrary(channel, lroot));
    if (method === "POST") {
      const label = decodeURIComponent(String(req.headers["x-label"] ?? "")).trim();
      const note = decodeURIComponent(String(req.headers["x-note"] ?? "")).trim();
      const filename = decodeURIComponent(String(req.headers["x-filename"] ?? ""));
      if (!note) return send(res, 400, { error: "write where the file comes from (source / permission)" });
      try {
        return send(res, 200, { ok: true, ...(await importFile(req, channel, lroot, label, filename, note)) });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (method === "DELETE") {
      removeLibraryFile(channel, lroot, String(url.searchParams.get("folder")), String(url.searchParams.get("file")));
      return send(res, 200, { ok: true });
    }
  }

  if (parts[1] === "presskit") {
    const channel = url.searchParams.get("channel") ?? "default";
    if (!listChannels().includes(channel)) return send(res, 400, { error: "unknown channel" });
    // Official photo importer: product names -> manufacturer product pages -> press kit.
    if (parts[2] === "official" && method === "POST") {
      reloadEnv();
      const body = JSON.parse((await readBody(req)) || "{}");
      const products = (Array.isArray(body.products) ? body.products : []).map((p: unknown) => String(p).trim()).filter(Boolean).slice(0, 30);
      if (!products.length) return send(res, 400, { error: "no product names" });
      const niche = loadNiche(typeof body.niche === "string" ? body.niche : "guns");
      const lines: string[] = [];
      const results = await importOfficial(channel, products, niche, (m) => lines.push(m), !!body.force);
      return send(res, 200, { results, log: lines });
    }
    if (method === "GET") return send(res, 200, listPresskit(channel));
    if (method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!body.product?.trim() || !body.url?.trim()) return send(res, 400, { error: "product and link are required" });
      try {
        const r = await addPresskitFile(channel, body.product.trim(), body.url.trim(), (body.license || "Manufacturer press kit (editorial/review use)").trim());
        return send(res, 200, { ok: true, ...r });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (method === "DELETE") {
      removePresskitFile(channel, String(url.searchParams.get("folder")), String(url.searchParams.get("file")));
      return send(res, 200, { ok: true });
    }
  }

  if (parts[1] === "niches" && method === "GET") {
    return send(res, 200, listNiches().map((n) => ({ name: n.name, label: n.label, description: n.description ?? "", scenes: n.scenes ?? null })));
  }

  if (parts[1] === "channels" && method === "GET" && !parts[2]) {
    return send(res, 200, listChannels().map((c) => ({ name: c, style: loadStyle(c) })));
  }

  // ----- channel profiles -----
  if (parts[1] === "channels" && method === "POST" && !parts[2]) {
    const body = JSON.parse((await readBody(req)) || "{}");
    try {
      const id = createChannel(String(body.name ?? ""), listChannels().includes(body.copyFrom) ? body.copyFrom : "default");
      return send(res, 200, { ok: true, name: id });
    } catch (err) {
      return send(res, 400, { error: String((err as Error).message ?? err) });
    }
  }
  if (parts[1] === "channels" && parts[2]) {
    const ch = parts[2];
    if (!listChannels().includes(ch)) return send(res, 404, { error: "unknown channel" });
    const what = parts[3];
    if (what === "style" && method === "PUT") return send(res, 200, updateStyle(ch, JSON.parse((await readBody(req)) || "{}")));
    if (what === "logo" && method === "POST") {
      try {
        return send(res, 200, { ok: true, path: await saveLogo(req, ch, decodeURIComponent(String(req.headers["x-filename"] ?? ""))) });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (what === "logo" && method === "DELETE") {
      removeLogo(ch);
      return send(res, 200, { ok: true });
    }
    if (what === "logo" && method === "GET") {
      const p = (loadStyle(ch).logo as { path?: string } | undefined)?.path;
      return p && fs.existsSync(p) ? streamFile(req, res, p) : send(res, 404, { error: "no logo" });
    }
    if (what === "music" && method === "GET") return send(res, 200, listMusic(ch));
    if (what === "music" && method === "POST") {
      try {
        const name = await saveMusic(req, ch, decodeURIComponent(String(req.headers["x-filename"] ?? "")), decodeURIComponent(String(req.headers["x-note"] ?? "")));
        return send(res, 200, { ok: true, name });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (what === "music" && method === "DELETE") {
      removeMusic(ch, String(url.searchParams.get("file")));
      return send(res, 200, { ok: true });
    }
  }

  // ----- batch queue -----
  if (parts[1] === "queue") {
    if (method === "GET") return send(res, 200, queue.list());
    const body = JSON.parse((await readBody(req)) || "{}");
    if (method === "POST" && parts[2] === "pause") return (queue.setPaused(true), send(res, 200, { ok: true }));
    if (method === "POST" && parts[2] === "resume") return (queue.setPaused(false), send(res, 200, { ok: true }));
    if (method === "POST" && parts[2] === "clear") return (queue.clearFinished(), send(res, 200, { ok: true }));
    if (method === "POST" && parts[2] === "retry") return send(res, queue.retry(String(body.id)) ? 200 : 400, { ok: true });
    if (method === "POST" && !parts[2]) {
      const names: string[] = (body.projects ?? []).filter((n: string) => validName(n) && readProject(n)?.audio);
      if (!names.length) return send(res, 400, { error: "no uploaded projects to queue" });
      return send(res, 200, { ok: true, added: queue.add(names, body.useLlm !== false) });
    }
    if (method === "DELETE" && parts[2]) return send(res, queue.remove(parts[2]) ? 200 : 400, { ok: true });
  }

  if (parts[1] === "glossary") {
    const file = path.join(paths.inputs, "glossary.txt");
    if (method === "GET") return send(res, 200, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", "text/plain; charset=utf-8");
    if (method === "PUT") {
      fs.writeFileSync(file, await readBody(req));
      return send(res, 200, { ok: true });
    }
  }

  if (parts[1] !== "projects") return send(res, 404, { error: "unknown route" });

  if (parts.length === 2 && method === "GET") {
    const names = fs.existsSync(paths.workspace)
      ? fs.readdirSync(paths.workspace).filter((n) => validName(n) && fs.existsSync(path.join(projDir(n), "project.json")))
      : [];
    const list = names.map(summary).sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")));
    return send(res, 200, list);
  }

  const name = parts[2];
  if (!name || !validName(name)) return send(res, 400, { error: "project name: letters, digits, - and _ only" });
  const action = parts[3];

  if (!action && method === "GET") {
    if (!readProject(name)) return send(res, 404, { error: "no such project" });
    return send(res, 200, { ...summary(name), project: readProject(name) });
  }

  if (action === "audio" && method === "POST") {
    const fname = String(req.headers["x-filename"] ?? "voiceover.mp3");
    const ext = path.extname(fname).toLowerCase();
    if (!AUDIO_EXT.has(ext)) return send(res, 400, { error: "audio must be mp3, wav or m4a" });
    if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
    fs.mkdirSync(projDir(name), { recursive: true });
    const dest = path.join(projDir(name), `voiceover${ext}`);
    await new Promise<void>((resolve, reject) => {
      const ws = fs.createWriteStream(dest);
      req.pipe(ws);
      ws.on("finish", () => resolve());
      ws.on("error", reject);
    });
    // New audio invalidates everything downstream.
    for (const f of [...Object.values(STEP_OUTPUT), "sections.json", "plan_report.json", "segments.json", "assets_report.json", "license_log.csv", "plan_edits.json"]) {
      fs.rmSync(path.join(projDir(name), f), { force: true });
    }
    writeProject(name, { name, audio: dest, originalFilename: fname, createdAt: readProject(name)?.createdAt ?? new Date().toISOString() });
    return send(res, 200, { ok: true, bytes: fs.statSync(dest).size });
  }

  if (action === "audio" && method === "GET") {
    const p = readProject(name);
    if (!p?.audio || !fs.existsSync(String(p.audio))) return send(res, 404, { error: "no audio" });
    return streamFile(req, res, String(p.audio));
  }

  if (action === "script") {
    const file = path.join(projDir(name), "script.txt");
    if (method === "GET") return send(res, 200, fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "", "text/plain; charset=utf-8");
    if (method === "PUT") {
      const text = (await readBody(req, 8 * 1024 * 1024)).trim();
      const secFile = path.join(projDir(name), "script_sections.json");
      if (/^<(!doctype|html)/i.test(text)) {
        // Script HTML page: spoken text + beats as sections + product hints + glossary names.
        const imported = parseScriptHtml(text);
        fs.writeFileSync(file, scriptText(imported));
        fs.writeFileSync(secFile, JSON.stringify(scriptSections(imported), null, 1));
        fs.writeFileSync(path.join(projDir(name), "products.json"), JSON.stringify(imported.products, null, 1));
        const gfile = path.join(paths.inputs, "glossary.txt");
        const have = fs.existsSync(gfile) ? fs.readFileSync(gfile, "utf8") : "";
        const add = imported.products.map((p) => p.name).filter((n) => !have.split(/\r?\n/).includes(n));
        if (add.length) fs.appendFileSync(gfile, (have.endsWith("\n") || !have ? "" : "\n") + add.join("\n") + "\n");
        return send(res, 200, { ok: true, hasScript: true, imported: { title: imported.title, beats: imported.beats.length, products: imported.products.length, glossaryAdded: add.length } });
      }
      fs.rmSync(secFile, { force: true });
      if (text) fs.writeFileSync(file, text + "\n");
      else fs.rmSync(file, { force: true });
      return send(res, 200, { ok: true, hasScript: !!text });
    }
  }

  if (action === "settings" && method === "PUT") {
    const body = JSON.parse((await readBody(req)) || "{}");
    if (body.channel && listChannels().includes(body.channel)) writeProject(name, { channel: body.channel });
    if (body.niche && listNiches().some((n) => n.name === body.niche)) writeProject(name, { niche: body.niche });
    if ((FOOTAGE_MODES as readonly string[]).includes(body.footage)) writeProject(name, { footage: body.footage });
    if (typeof body.planGate === "boolean") writeProject(name, { planGate: body.planGate });
    // Creative brief from the home prompt ("dark atmosphere, archival footage..."): steers the footage agent.
    if (typeof body.brief === "string") writeProject(name, { brief: body.brief.trim().slice(0, 2000) });
    return send(res, 200, { ok: true });
  }

  // ----- plan review: estimate, edit a scene's searches, approve -----
  if (action === "plan") {
    const dir = projDir(name);
    const p = (readProject(name) ?? {}) as ProjectLike;
    if (!fs.existsSync(path.join(dir, "scenes.json"))) return send(res, 400, { error: "no plan yet - run the pipeline first" });
    if (parts[4] === "estimate" && method === "GET") return send(res, 200, { ...planEstimate(dir, p), gate: gateState(dir, p) });
    if (parts[4] === "scene" && parts[5] !== undefined && method === "PUT") {
      if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        return send(res, 200, { ok: true, scene: savePlanEdit(dir, Number(parts[5]), cleanQueries(body.queries)) });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (parts[4] === "approve" && method === "POST") {
      if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
      writeProject(name, { planApproval: approval(dir) });
      const body = JSON.parse((await readBody(req)) || "{}");
      void runJob(name, [...STEPS.slice(STEPS.indexOf("assets"))], false, body.useLlm !== false);
      return send(res, 200, { ok: true });
    }
  }

  // Simple UI: one button. Script and/or voiceover; no voiceover -> default Windows TTS voice.
  if (action === "go" && method === "POST") {
    if (jobs.get(name)?.running) return send(res, 409, { error: "already running" });
    const body = JSON.parse((await readBody(req)) || "{}");
    const st = loadAppSettings();
    const p00 = readProject(name);
    const channel = typeof body.channel === "string" && listChannels().includes(body.channel) ? body.channel : String(p00?.channel ?? "auto");
    const chNiche = String(loadStyle(channel).niche ?? "");
    const dir = projDir(name);
    fs.mkdirSync(dir, { recursive: true });
    const scriptFile = path.join(dir, "script.txt");
    const script = typeof body.script === "string" ? body.script.trim() : "";
    if (script) fs.writeFileSync(scriptFile, script + "\n");
    else fs.rmSync(scriptFile, { force: true });
    const title = typeof body.title === "string" ? body.title.trim().slice(0, 100) : String(p00?.title ?? "");
    const p0 = readProject(name);
    const hasAudio = !!p0?.audio && fs.existsSync(String(p0.audio)) && !(p0.voiceMode === "tts" && script);
    if (!hasAudio && !script) return send(res, 400, { error: "Script paste karein ya voiceover upload karein" });
    // Auto channel (or niche=auto): detect category/hints/pacing from script and write project niche.json.
    const wantsAuto = channel === "auto" || chNiche === "auto" || body.niche === "auto";
    let nicheName: string;
    let uiNiche: string;
    let detectMeta: { source?: string; category?: string; targetShotSec?: number } = {};
    if (wantsAuto) {
      const scriptForDetect = script || (fs.existsSync(scriptFile) ? fs.readFileSync(scriptFile, "utf8") : "");
      const { niche, meta } = await detectAndWriteNiche(dir, { title, script: scriptForDetect }, console.log);
      nicheName = niche.name || "auto";
      uiNiche = "auto";
      detectMeta = meta;
    } else {
      const niche: UiNiche = body.niche === "tech" || body.niche === "guns" ? body.niche : chNiche === "tech" ? "tech" : chNiche === "guns" ? "guns" : st.defaultNiche;
      nicheName = buildUiNiche(niche, st);
      uiNiche = niche;
    }
    writeProject(name, {
      name,
      channel,
      title,
      review: body.review === true,
      reviewDone: false,
      niche: nicheName,
      uiNiche,
      detectedCategory: detectMeta.category ?? null,
      nicheSource: detectMeta.source ?? null,
      targetShotSec: detectMeta.targetShotSec ?? null,
      planGate: false,
      createdAt: p0?.createdAt ?? new Date().toISOString(),
      voiceMode: hasAudio ? (script ? "both" : "voice") : "tts",
    });
    if (channel !== "auto") updateStyle(channel, { captions: { enabled: st.captions } });
    else updateStyle(channel, { captions: { enabled: st.captions }, pacing: { targetShotSec: detectMeta.targetShotSec ?? 2.3 } });
    void (async () => {
      if (!hasAudio) {
        const job: Job = { running: true, step: null, failedStep: null, log: ["=== voice ===", "Default test voice (Windows TTS) ..."], startedAt: Date.now() };
        jobs.set(name, job);
        const wav = path.join(dir, "voiceover.wav");
        const r = await ttsToWav(scriptFile, wav);
        if (!r.ok) {
          job.log.push(`!!! voice failed: ${r.error}`);
          Object.assign(job, { running: false, failedStep: "transcribe", finishedAt: Date.now() });
          return;
        }
        for (const f of Object.values(STEP_OUTPUT)) fs.rmSync(path.join(dir, f), { force: true });
        writeProject(name, { audio: wav, originalFilename: "tts.wav" });
      }
      await runJob(name, [...STEPS], !!body.force, true, false);
    })();
    return send(res, 200, { ok: true, niche: nicheName, detectedCategory: detectMeta.category ?? null, nicheSource: detectMeta.source ?? null });
  }

  if (action === "run" && method === "POST") {
    if (!readProject(name)?.audio) return send(res, 400, { error: "upload audio first" });
    if (jobs.get(name)?.running) return send(res, 409, { error: "already running" });
    const body = JSON.parse((await readBody(req)) || "{}");
    const from: Step = STEPS.includes(body.from) ? body.from : "transcribe";
    const only: boolean = !!body.only;
    const steps = only ? [from] : STEPS.slice(STEPS.indexOf(from));
    void runJob(name, [...steps], !!body.force, body.useLlm !== false);
    return send(res, 200, { ok: true, steps });
  }

  if (action === "log" && method === "GET") {
    const job = jobs.get(name);
    const since = Number(url.searchParams.get("since") ?? 0);
    return send(res, 200, {
      running: job?.running ?? false,
      step: job?.step ?? null,
      failedStep: job?.failedStep ?? null,
      awaitingApproval: job?.awaitingApproval ?? false,
      awaitingReview: (job?.awaitingReview ?? false) && !job?.running,
      planGate: gateState(projDir(name), (readProject(name) ?? {}) as ProjectLike),
      total: job?.log.length ?? 0,
      lines: job ? job.log.slice(since) : [],
      steps: stepStatus(name),
    });
  }

  if (action === "media" && method === "GET") {
    // Streams a scene's asset (or its thumbnail). Paths come from our own assets.json.
    const assetsFile = path.join(projDir(name), "assets.json");
    if (!fs.existsSync(assetsFile)) return send(res, 404, { error: "no assets yet" });
    const a = JSON.parse(fs.readFileSync(assetsFile, "utf8"))[parts[4]];
    const file = a && (url.searchParams.has("thumb") ? a.thumb : a.path);
    if (!file || !fs.existsSync(file)) return send(res, 404, { error: "missing file" });
    return streamFile(req, res, file);
  }

  if (action === "video" && method === "GET") {
    const file = path.join(paths.output, `${name}.mp4`);
    if (!fs.existsSync(file)) return send(res, 404, { error: "not rendered yet" });
    if (url.searchParams.has("download")) {
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": fs.statSync(file).size, "Content-Disposition": `attachment; filename="${name}.mp4"` });
      fs.createReadStream(file).pipe(res);
      return;
    }
    return streamFile(req, res, file);
  }

  if (action === "license" && method === "GET") {
    const file = path.join(projDir(name), "license_log.csv");
    if (!fs.existsSync(file)) return send(res, 404, { error: "not generated yet" });
    res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}_license_log.csv"` });
    res.end(fs.readFileSync(file));
    return;
  }

  // ----- scene review before render (simple UI) -----
  if (action === "review") {
    const dir = projDir(name);
    if (!fs.existsSync(path.join(dir, "timeline.json"))) return send(res, 404, { error: "no timeline yet" });
    if (method === "GET" && !parts[4]) {
      const p = readProject(name) ?? {};
      return send(res, 200, { awaiting: !!jobs.get(name)?.awaitingReview && !jobs.get(name)?.running, review: p.review === true, reviewDone: p.reviewDone === true, scenes: listReview(dir) });
    }
    if (method === "GET" && parts[4] === "thumb") {
      const alt = url.searchParams.get("alt");
      const f = alt ? await reviewThumb(dir, { alt }) : await reviewThumb(dir, { scene: Number(url.searchParams.get("scene")), shot: Number(url.searchParams.get("shot") ?? 0) });
      return f ? streamFile(req, res, f) : send(res, 404, { error: "no thumbnail" });
    }
    if (method === "POST" && parts[4] === "swap") {
      if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
      const body = JSON.parse((await readBody(req)) || "{}");
      try {
        swapShot(dir, Number(body.scene), Number(body.shot ?? 0), String(body.alt ?? ""));
        return send(res, 200, { ok: true, scene: listReview(dir).find((s) => s.id === Number(body.scene)) });
      } catch (err) {
        return send(res, 400, { error: String((err as Error).message ?? err) });
      }
    }
    if (method === "POST" && parts[4] === "render") {
      if (jobs.get(name)?.running) return send(res, 409, { error: "already running" });
      writeProject(name, { reviewDone: true });
      void runJob(name, ["render", "qa"], false, true, false);
      return send(res, 200, { ok: true });
    }
  }

  // ----- publish pack (title, description, thumbnails) -----
  if (action === "publish" && method === "GET") {
    const pub = path.join(projDir(name), "publish");
    if (parts[4]) {
      const f = path.join(pub, path.basename(parts[4]));
      if (!/^[A-Za-z0-9_.-]+\.(jpg|txt|json)$/.test(parts[4]) || !fs.existsSync(f)) return send(res, 404, { error: "missing file" });
      return streamFile(req, res, f);
    }
    const f = path.join(pub, "publish.json");
    return fs.existsSync(f) ? send(res, 200, fs.readFileSync(f)) : send(res, 404, { error: "not generated yet" });
  }

  // ----- review page: swap a scene's footage, fix a caption word -----

  if (action === "candidates" && parts[4] !== undefined) {
    const sceneId = String(Number(parts[4]));
    const all = loadCandidates(projDir(name));
    if (method === "GET" && !parts[5]) return send(res, 200, all[sceneId] ?? []);
    if (method === "POST" && parts[5] === "search") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (!String(body.query ?? "").trim()) return send(res, 400, { error: "type something to search for" });
      const p = readProject(name) ?? {};
      const niche = loadProjectNiche(p as ProjectLike, loadStyle(String(p.channel ?? "default")));
      const found = await searchAlternatives(String(body.query).trim(), niche);
      // Keep searched options so a later swap request can find them by id.
      const existing = all[sceneId] ?? [];
      all[sceneId] = [...existing, ...found.filter((c) => !existing.some((e) => e.id === c.id))];
      saveCandidates(projDir(name), all);
      return send(res, 200, found);
    }
  }

  if (action === "swap" && parts[4] !== undefined && method === "POST") {
    if (jobs.get(name)?.running) return send(res, 409, { error: "pipeline is running for this project" });
    const sceneId = Number(parts[4]);
    const body = JSON.parse((await readBody(req)) || "{}");
    const cand = (loadCandidates(projDir(name))[String(sceneId)] ?? []).find((c) => c.id === body.candId);
    if (!cand) return send(res, 404, { error: "unknown option for this scene" });
    try {
      const asset = await applyCandidate(projDir(name), sceneId, cand);
      // Only the swapped scene's segment re-renders; every other segment comes from the cache.
      void runJob(name, ["timeline", "render"], false, false);
      return send(res, 200, { ok: true, asset });
    } catch (err) {
      return send(res, 400, { error: String((err as Error).message ?? err) });
    }
  }

  if (action === "words" && parts[4] !== undefined && method === "PUT") {
    const index = Number(parts[4]);
    const file = path.join(projDir(name), "aligned.json");
    if (!fs.existsSync(file)) return send(res, 404, { error: "run Align first" });
    const aligned = JSON.parse(fs.readFileSync(file, "utf8"));
    const w = aligned.words?.[index];
    const body = JSON.parse((await readBody(req)) || "{}");
    const to = String(body.word ?? "").trim();
    if (!w || !to || /\s/.test(to)) return send(res, 400, { error: "one word, no spaces" });
    saveWordEdit(projDir(name), w.start, w.word, to);
    w.word = to;
    w.edited = true;
    for (const st of aligned.sentences ?? []) {
      if (index >= st.firstWord && index <= st.lastWord) st.text = aligned.words.slice(st.firstWord, st.lastWord + 1).map((x: { word: string }) => x.word).join(" ");
    }
    fs.writeFileSync(file, JSON.stringify(aligned, null, 1));
    return send(res, 200, { ok: true, word: to });
  }

  // Human review gate: approval is tied to the exact rendered file (its modification time).
  if (action === "approve") {
    const file = path.join(projDir(name), "approval.json");
    const qaFile = path.join(projDir(name), "qa_report.json");
    if (method === "POST") {
      if (!fs.existsSync(qaFile)) return send(res, 400, { error: "run QA first" });
      const qaRep = JSON.parse(fs.readFileSync(qaFile, "utf8"));
      if (qaRep.summary.fail > 0) return send(res, 400, { error: "QA has failures - fix them (or re-run QA) before approving" });
      const video = path.join(paths.output, `${name}.mp4`);
      const body = JSON.parse((await readBody(req)) || "{}");
      const approval = { approvedAt: new Date().toISOString(), note: String(body.note ?? "").slice(0, 500), videoMtime: fs.statSync(video).mtimeMs };
      fs.writeFileSync(file, JSON.stringify(approval, null, 2));
      return send(res, 200, { ok: true, ...approval });
    }
    if (method === "DELETE") {
      fs.rmSync(file, { force: true });
      return send(res, 200, { ok: true });
    }
    if (method === "GET") {
      if (!fs.existsSync(file)) return send(res, 200, { approved: false });
      const ap = JSON.parse(fs.readFileSync(file, "utf8"));
      const video = path.join(paths.output, `${name}.mp4`);
      // A re-render after approval invalidates it: the reviewer has not seen the new file.
      const stale = !fs.existsSync(video) || Math.abs(fs.statSync(video).mtimeMs - ap.videoMtime) > 1;
      return send(res, 200, { approved: !stale, stale, ...ap });
    }
  }

  if (action === "file" && method === "GET") {
    const f = parts[4];
    if (!READABLE.has(f)) return send(res, 400, { error: "not readable" });
    const file = path.join(projDir(name), f);
    if (!fs.existsSync(file)) return send(res, 404, { error: "not generated yet" });
    return send(res, 200, fs.readFileSync(file));
  }

  return send(res, 404, { error: "unknown route" });
}

export async function serve(port: number): Promise<void> {
  fs.mkdirSync(paths.workspace, { recursive: true });
  queue = new BatchQueue(
    async (project, useLlm) => {
      // Batch runs unattended: no plan approval stop.
      await runJob(project, [...STEPS], false, useLlm, false);
      return { failedStep: jobs.get(project)?.failedStep ?? null };
    },
    () => [...jobs.values()].some((j) => j.running),
  );
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: String(err?.message ?? err) });
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`ClipForge web app: http://localhost:${port}  (Ctrl+C to stop)`);
  await new Promise(() => {});
}
