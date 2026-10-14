import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { env } from "../env.js";
import { paths } from "../paths.js";
import { ffmpegPath, venvPythonPath } from "../tools.js";
import type { Candidate } from "./types.js";

const CACHE = path.join(paths.root, "cache");
const SEARCH_CACHE = path.join(CACHE, "search");
const MEDIA_CACHE = path.join(CACHE, "media");
const TTL = 7 * 24 * 3600 * 1000;
/** Seconds fetched per video: only this piece is downloaded, never the whole upload. */
const SEGMENT = 15;
const WORKER = path.join(paths.python, "youtube_cc.py");

export const YOUTUBE_CC_LICENSE = "CC BY via YouTube (Creative Commons Attribution licence)";

interface Reply {
  id?: number;
  ok?: boolean;
  error?: string;
  [k: string]: unknown;
}

/**
 * One long-lived Python worker per process (yt-dlp is imported once). Requests are JSON lines;
 * replies are matched by id. A missing yt-dlp or a bad proxy setting disables the provider.
 */
export class Worker {
  constructor(private script: string = WORKER) {}

  private child: ChildProcessWithoutNullStreams | null = null;
  private waiting = new Map<number, (r: Reply) => void>();
  private nextId = 1;
  private ready: Promise<Reply> | null = null;
  private exitHook = false;

  start(): Promise<Reply> {
    if (this.ready) return this.ready;
    const py = venvPythonPath();
    if (!py || !fs.existsSync(this.script)) return (this.ready = Promise.resolve({ ready: false, error: "project .venv not found" }));
    this.ready = new Promise<Reply>((resolve) => {
      const child = spawn(py, ["-u", this.script, "serve"], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
      this.child = child;
      // An idle worker must not keep the step process alive; pending calls hold their own timers.
      child.unref();
      for (const s of [child.stdin, child.stdout, child.stderr]) (s as unknown as { unref?: () => void }).unref?.();
      let first = true;
      readline.createInterface({ input: child.stdout }).on("line", (line) => {
        let msg: Reply;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (first) {
          first = false;
          resolve(msg);
          return;
        }
        const cb = this.waiting.get(msg.id ?? -1);
        if (cb) {
          this.waiting.delete(msg.id!);
          cb(msg);
        }
      });
      child.stderr.on("data", () => {}); // yt-dlp warnings; errors arrive as replies
      const fail = (why: string) => {
        if (first) {
          first = false;
          resolve({ ready: false, error: why });
        } else if (this.child === child) this.ready = null; // crashed or killed after a timeout: restart on next call
        for (const cb of this.waiting.values()) cb({ ok: false, error: why });
        this.waiting.clear();
        this.child = null;
      };
      child.on("error", (e) => fail(String(e)));
      child.on("close", (code) => fail(`worker exited (${code})`));
      // Also keeps the event loop alive while the unref'd worker starts up.
      const t = setTimeout(() => first && (fail("worker did not start within 60 s"), child.kill()), 60_000);
      child.stdout.once("data", () => clearTimeout(t));
      child.once("close", () => clearTimeout(t));
    });
    if (!this.exitHook) process.once("exit", () => this.child?.kill());
    this.exitHook = true;
    return this.ready;
  }

  /**
   * The worker handles one request at a time, so calls queue here: each timeout starts when its
   * request is actually sent (3 parallel downloads would otherwise time out while waiting in line).
   */
  call(req: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const next = this.queue.then(() => this.send(req, timeoutMs));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private queue: Promise<unknown> = Promise.resolve();

  private async send(req: Record<string, unknown>, timeoutMs: number): Promise<Reply> {
    const hello = await this.start();
    if (!hello.ready || !this.child) throw new Error(String(hello.error ?? "youtube worker unavailable"));
    const id = this.nextId++;
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        // The worker is still busy with this request: stop it so the next one starts clean.
        this.child?.kill();
        resolve({ ok: false, error: `no answer after ${Math.round(timeoutMs / 1000)} s` });
      }, timeoutMs);
      this.waiting.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.child!.stdin.write(JSON.stringify({ ...req, id }) + "\n");
    });
  }

  stop(): void {
    this.child?.stdin.end();
    this.child = null;
    this.ready = null;
  }
}

const worker = new Worker();
let disabledWhy: string | null = null;
let searches = 0;
const said = new Set<string>();
const sayOnce = (m: string) => {
  if (!said.has(m)) console.log(m);
  said.add(m);
};

/** Live searches per run: YouTube search pages are big (~0.5 MB) and the connection is slow. */
const maxSearches = () => Number(env("YTCC_MAX_SEARCHES", "40")) || 40;

interface Hit {
  id: string;
  title: string;
  channel: string;
  channel_url: string;
  duration: number;
}

/** True when the worker starts (yt-dlp installed, proxy setting valid); the reason otherwise. */
export async function youtubeStatus(): Promise<{ ok: boolean; detail: string }> {
  const r = await worker.start();
  return r.ready ? { ok: true, detail: `yt-dlp ${r.version}${r.proxy ? ", via proxy" : ""}` } : { ok: false, detail: String(r.error) };
}

export function stopYoutubeWorker(): void {
  worker.stop();
}

/**
 * YouTube search restricted to Creative Commons videos. Only the search page is read here; each
 * picked video's licence is checked again on its watch page before anything is downloaded.
 */
export async function searchYoutubeCC(query: string): Promise<Candidate[]> {
  if (disabledWhy) return [];
  fs.mkdirSync(SEARCH_CACHE, { recursive: true });
  const f = path.join(SEARCH_CACHE, `ytcc-${crypto.createHash("sha1").update(query).digest("hex").slice(0, 16)}.json`);
  let hits: Hit[];
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < TTL) hits = JSON.parse(fs.readFileSync(f, "utf8"));
  else {
    if (searches >= maxSearches()) {
      sayOnce(`[youtube_cc] search limit reached (${maxSearches()} per run, YTCC_MAX_SEARCHES); later scenes use the other sources`);
      return [];
    }
    searches++;
    let r: Reply;
    try {
      r = await worker.call({ op: "search", query, limit: 6 }, 90_000);
    } catch (err) {
      disabledWhy = String((err as Error).message ?? err);
      sayOnce(`[youtube_cc] disabled: ${disabledWhy}`);
      return [];
    }
    if (!r.ok) throw new Error(`YouTube CC search: ${r.error}`);
    hits = r.results as Hit[];
    fs.writeFileSync(f, JSON.stringify(hits));
  }
  return hits.map((h, rank) => ({
    source: "youtube_cc" as const,
    id: `ytcc_${h.id}`,
    kind: "video" as const,
    location: h.id,
    pageUrl: `https://www.youtube.com/watch?v=${h.id}`,
    license: YOUTUBE_CC_LICENSE,
    author: h.channel.slice(0, 80) || undefined,
    // Real size is probed by the renderer; search pages do not say.
    width: 1920,
    height: 1080,
    duration: SEGMENT,
    score: 3.4 - rank * 0.1,
    tags: h.title,
    thumbUrl: `https://i.ytimg.com/vi/${h.id}/mqdefault.jpg`,
    sourceLength: h.duration,
  }));
}

/**
 * Downloads a 15 s piece (~35% in, past intros) after the watch page confirms the CC licence.
 * The full video never touches the disk, so there is nothing to clean up afterwards.
 */
export async function downloadYoutubeCC(c: Candidate): Promise<string> {
  fs.mkdirSync(MEDIA_CACHE, { recursive: true });
  const out = path.join(MEDIA_CACHE, `${c.id}.mp4`);
  if (fs.existsSync(out)) return out;
  const ff = ffmpegPath();
  if (!ff) throw new Error("ffmpeg not found");
  const len = c.sourceLength ?? 0;
  const start = len ? Math.max(0, Math.min(len * 0.35, len - SEGMENT - 2)) : 30;
  const r = await worker.call(
    { op: "fetch", video: c.location, start, seconds: SEGMENT, out, ffmpeg: ff, max_height: Number(env("STOCK_MAX_WIDTH", "1920")) <= 1280 ? 720 : 1080 },
    240_000,
  );
  if (!r.ok || !fs.existsSync(out)) throw new Error(`YouTube CC ${c.pageUrl}: ${r.error ?? "no file"}`);
  return out;
}
