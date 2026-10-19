import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/**
 * BullMQ + Redis job state + per-host rate limiter against a real redis-server (started here on a
 * free port; the suite is skipped when redis-server is not installed).
 */
const hasRedis = spawnSync("redis-server", ["--version"]).status === 0;
let server: ChildProcess | null = null;
let url = "";
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = net.createServer().listen(0, () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
before(async () => {
  if (!hasRedis) return;
  const port = await freePort();
  server = spawn("redis-server", ["--port", String(port), "--save", "", "--appendonly", "no"], { stdio: "ignore" });
  url = `redis://127.0.0.1:${port}`;
  process.env.REDIS_URL = url;
  process.env.QUEUE_PREFIX = `test${Date.now()}`;
  for (let i = 0; i < 50; i++) {
    if (await new Promise((r) => net.connect(port, "127.0.0.1").on("connect", function (this: net.Socket) { this.end(); r(true); }).on("error", () => r(false)))) break;
    await new Promise((r) => setTimeout(r, 100));
  }
});
after(async () => {
  const { closeRedis } = await import("../src/lib/redis.js");
  await closeRedis();
  server?.kill();
});

const { splitStage, workerStages, BullDispatcher, LocalDispatcher, RedisBatchQueue } = await import("../src/server/pipelineQueue.js");
const { RedisJobStore, LOG_KEEP } = await import("../src/server/jobStore.js");
const { limitKeyFor, parseLimits, tryAcquire, limitFor } = await import("../src/lib/rateLimit.js");
type PJ = import("../src/server/pipelineQueue.js").PipelineJob;
const ALL = ["tts", "transcribe", "align", "plan", "assets", "timeline", "render", "qa"];
const job = (project: string, steps = ALL, extra: Partial<PJ> = {}): PJ => ({ project, steps, force: false, useLlm: true, gate: true, extra: {}, stageIndex: 0, ...extra });
const until = async (cond: () => boolean | Promise<boolean>, ms = 15_000) => {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("stage split (no Redis needed)", () => {
  test("steps go to plan / sourcing / render queues in order", () => {
    assert.deepEqual(splitStage(ALL), { stage: "plan", here: ["tts", "transcribe", "align", "plan"], rest: ["assets", "timeline", "render", "qa"] });
    assert.deepEqual(splitStage(["assets", "timeline"]).here, ["assets"]);
    assert.deepEqual(splitStage(["render", "qa"]), { stage: "render", here: ["render", "qa"], rest: [] });
    assert.deepEqual(workerStages("plan, render"), ["plan", "render"]);
    assert.deepEqual(workerStages("none"), []);
  });

  test("local dispatcher runs the whole job in one call (the queue.json fallback)", async () => {
    const d = new LocalDispatcher();
    const calls: [string[], boolean][] = [];
    await d.startWorkers([], async (_j, steps, final) => (calls.push([steps, final]), { failedStep: null, stopped: false }));
    await d.start(job("p"));
    assert.deepEqual(calls, [[ALL, true]]);
  });
});

describe("rate limiter (pure parts)", () => {
  test("URLs map to the API they count against", () => {
    assert.equal(limitKeyFor("https://api.pexels.com/videos/search?query=x"), "pexels");
    assert.equal(limitKeyFor("https://videos.pexels.com/video-files/1.mp4"), "host:videos.pexels.com", "file downloads are not API calls");
    assert.equal(limitKeyFor("https://pixabay.com/api/videos/?q=x"), "pixabay");
    assert.equal(limitKeyFor("https://api.unsplash.com/search/photos"), "unsplash");
    assert.equal(limitKeyFor("https://www.youtube.com/watch?v=abc"), "youtube");
    assert.equal(limitKeyFor("https://commons.wikimedia.org/w/api.php?action=query"), "wikimedia");
    assert.equal(limitKeyFor("https://upload.wikimedia.org/x.webm"), "host:upload.wikimedia.org", "media files are not API calls");
    assert.equal(limitKeyFor("https://i.ytimg.com/vi/abc/hq.jpg"), "host:i.ytimg.com", "thumbnails do not spend the YouTube budget");
  });
  test("defaults are the documented API limits; RATE_LIMITS overrides", () => {
    assert.deepEqual(limitFor("pexels"), { max: 200, windowMs: 3_600_000, gapMs: 0 });
    assert.deepEqual(limitFor("pixabay"), { max: 100, windowMs: 60_000, gapMs: 0 });
    assert.deepEqual(parseLimits("youtube=20/60:2000, bad, pexels=5/1"), { youtube: { max: 20, windowMs: 60_000, gapMs: 2000 }, pexels: { max: 5, windowMs: 1000, gapMs: 0 } });
  });
});

describe("with Redis", { skip: !hasRedis && "redis-server not installed" }, () => {
  test("job store: state, log since N, trimming keeps the counter exact", async () => {
    const { Redis } = await import("ioredis");
    const r = new Redis(url);
    const s = new RedisJobStore(r, "t:job:");
    await s.save("p", { running: true, step: "plan", failedStep: null, startedAt: 1 });
    assert.equal((await s.loadMany(["p", "none"])).get("p")?.step, "plan");
    await s.append("p", ["a", "b", "c"]);
    assert.deepEqual(await s.logSince("p", 1), { total: 3, lines: ["b", "c"] });
    await s.append("p", Array.from({ length: LOG_KEEP + 10 }, (_, i) => `x${i}`));
    const tail = await s.logSince("p", LOG_KEEP + 12);
    assert.equal(tail.total, LOG_KEEP + 13);
    assert.deepEqual(tail.lines, [`x${LOG_KEEP + 9}`]);
    await s.clearLog("p");
    assert.deepEqual(await s.logSince("p", 0), { total: 0, lines: [] });
    r.disconnect();
  });

  test("BullMQ: plan -> sourcing -> render, each stage its own steps; the last one is final", async () => {
    const d = new BullDispatcher();
    const calls: { steps: string[]; final: boolean; stageIndex: number }[] = [];
    let done: unknown = null;
    await d.startWorkers(["plan", "sourcing", "render"], async (j, steps, final) => (calls.push({ steps, final, stageIndex: j.stageIndex }), { failedStep: null, stopped: false }), (_j, r) => void (done = r));
    await d.start(job("video1"));
    await until(() => done !== null);
    assert.deepEqual(calls, [
      { steps: ["tts", "transcribe", "align", "plan"], final: false, stageIndex: 0 },
      { steps: ["assets"], final: false, stageIndex: 1 },
      { steps: ["timeline", "render", "qa"], final: true, stageIndex: 2 },
    ]);
    await d.close();
  });

  test("a gate stop or a failed step ends the run (no next stage)", async () => {
    const d = new BullDispatcher();
    const seen: string[] = [];
    const ends: string[] = [];
    await d.startWorkers(["plan", "sourcing", "render"], async (j, steps) => {
      seen.push(`${j.project}:${steps[0]}`);
      if (j.project === "gated") return { failedStep: null, stopped: true };
      return steps[0] === "assets" ? { failedStep: "assets", stopped: false } : { failedStep: null, stopped: false };
    }, (j, r) => void ends.push(`${j.project}:${r.failedStep ?? (r.stopped ? "stopped" : "done")}`));
    await d.start(job("gated"));
    await d.start(job("broken"));
    await until(() => ends.length === 2);
    assert.deepEqual(seen.sort(), ["broken:assets", "broken:tts", "gated:tts"]);
    assert.deepEqual(ends.sort(), ["broken:assets", "gated:stopped"]);
    await d.close();
  });

  test("queued jobs survive a restart: added with no worker, picked up by a new process's worker", async () => {
    const a = new BullDispatcher();
    await a.start(job("persisted", ["render", "qa"]));
    assert.ok((await a.activeProjects()).has("persisted"));
    await a.close();
    const b = new BullDispatcher();
    let ran: string[] | null = null;
    await b.startWorkers(["render"], async (_j, steps) => ((ran = steps), { failedStep: null, stopped: false }));
    await until(() => ran !== null);
    assert.deepEqual(ran, ["render", "qa"]);
    await b.close();
  });

  test("batch queue on Redis: items run through the stages; the worker records the outcome", async () => {
    const { Redis } = await import("ioredis");
    const r = new Redis(url);
    await r.del("cf:batch:items", "cf:batch:paused");
    const d = new BullDispatcher();
    const q = new RedisBatchQueue(r, d, () => ["render", "qa"]);
    await d.startWorkers(["render"], async () => ({ failedStep: null, stopped: false }), async (j) => {
      if (j.batchId) await RedisBatchQueue.update(r, j.batchId, { status: "done" });
    });
    await q.setPaused(true);
    const [it] = await q.add(["b1"], true);
    assert.equal((await q.list()).items[0].status, "queued");
    assert.equal(await d.activeProjects().then((s) => s.has("b1")), false, "paused: not handed to BullMQ yet");
    await q.setPaused(false);
    await until(async () => (await q.list()).items.find((x) => x.id === it.id)?.status === "done");
    await d.close();
    r.disconnect();
  });

  test("rate limiter: the budget is shared between processes through Redis", async () => {
    const name = `test${Date.now()}`;
    process.env.RATE_LIMITS = `${name}=3/60`;
    // Another process takes 2 slots ...
    const child = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cf-rl-")), "take.mts");
    fs.writeFileSync(child, `import { tryAcquire } from ${JSON.stringify(path.resolve("src/lib/rateLimit.ts"))};\nimport { closeRedis } from ${JSON.stringify(path.resolve("src/lib/redis.ts"))};\nconsole.log(await tryAcquire("${name}"), await tryAcquire("${name}"));\nawait closeRedis();\n`);
    const out = spawnSync(process.execPath, [path.resolve("node_modules/tsx/dist/cli.mjs"), child], { env: process.env, encoding: "utf8" });
    assert.equal(out.stdout.trim(), "0 0", out.stderr);
    // ... so this one gets the third and then has to wait.
    assert.equal(await tryAcquire(name), 0);
    const wait = await tryAcquire(name);
    assert.ok(wait > 50_000 && wait <= 60_000, `wait ${wait}`);
  });

  test("rate limiter: minimum gap between two requests", async () => {
    const name = `gap${Date.now()}`;
    process.env.RATE_LIMITS = `${name}=100/60:400`;
    assert.equal(await tryAcquire(name), 0);
    const w = await tryAcquire(name);
    assert.ok(w > 300 && w <= 400, `wait ${w}`);
    await new Promise((r) => setTimeout(r, w + 20));
    assert.equal(await tryAcquire(name), 0);
  });
});
