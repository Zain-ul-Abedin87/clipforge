import { Queue, Worker, type Job } from "bullmq";
import type { Redis } from "ioredis";
import { env } from "../lib/env.js";
import { bullConnection } from "../lib/redis.js";
import type { QueueItem, VideoQueue } from "./queue.js";

/**
 * Pipeline dispatch. Local (no REDIS_URL): steps run in this process, one call after another, exactly
 * as before. BullMQ: a video is split into three stage queues and each stage hands the rest of its
 * steps to the next queue when it finishes:
 *   planQueue      tts, transcribe, align, plan   (LLM calls, light)
 *   sourcingQueue  assets                         (network heavy; per-host rate limits in lib/rateLimit.ts)
 *   renderQueue    timeline, render, qa           (CPU / GPU heavy)
 * Jobs persist in Redis: a restart picks them up again (BullMQ marks a job whose worker died as
 * stalled and runs it again; each step resumes from its own cache). Workers can run in the server
 * (QUEUE_WORKERS=all, default) or as separate `clipforge worker` processes on other machines that
 * share the same workspace folder.
 */

export type Stage = "plan" | "sourcing" | "render";
export const STAGES: Stage[] = ["plan", "sourcing", "render"];
export const QUEUE_NAMES: Record<Stage, string> = { plan: "planQueue", sourcing: "sourcingQueue", render: "renderQueue" };

const STAGE_OF: Record<string, Stage> = { tts: "plan", transcribe: "plan", align: "plan", plan: "plan", assets: "sourcing", timeline: "render", render: "render", qa: "render" };
export const stageOf = (step: string): Stage => STAGE_OF[step] ?? "render";

export interface PipelineJob {
  project: string;
  steps: string[];
  force: boolean;
  useLlm: boolean;
  gate: boolean;
  extra: Record<string, string[]>;
  /** 0 for the first stage of a run (it starts a new log), then 1, 2. */
  stageIndex: number;
  /** Batch queue item this run belongs to. */
  batchId?: string;
}

export interface StageResult {
  failedStep: string | null;
  /** Stopped at the plan-approval or scene-review gate. */
  stopped: boolean;
}

/** Runs `steps` of a job; `final`: no stage follows (the run ends here). */
export type StageRunner = (job: PipelineJob, steps: string[], final: boolean) => Promise<StageResult>;
export type DoneHook = (job: PipelineJob, r: StageResult) => Promise<void> | void;

/** Leading steps that belong to the first step's stage, and the rest. */
export function splitStage(steps: string[]): { stage: Stage; here: string[]; rest: string[] } {
  const stage = stageOf(steps[0]);
  let n = 0;
  while (n < steps.length && stageOf(steps[n]) === stage) n++;
  return { stage, here: steps.slice(0, n), rest: steps.slice(n) };
}

export interface Dispatcher {
  readonly kind: "local" | "bullmq";
  /** Accepts a run (local: runs it to the end; BullMQ: queues its first stage). */
  start(job: PipelineJob): Promise<void>;
  startWorkers(stages: Stage[], run: StageRunner, onDone?: DoneHook): Promise<void>;
  /** Projects with a waiting or active stage job. */
  activeProjects(): Promise<Set<string>>;
  pause(paused: boolean): Promise<void>;
  close(): Promise<void>;
}

export class LocalDispatcher implements Dispatcher {
  readonly kind = "local" as const;
  private run: StageRunner | null = null;
  private onDone?: DoneHook;
  async startWorkers(_stages: Stage[], run: StageRunner, onDone?: DoneHook): Promise<void> {
    this.run = run;
    this.onDone = onDone;
  }
  async start(job: PipelineJob): Promise<void> {
    if (!this.run) throw new Error("local dispatcher has no runner");
    const r = await this.run(job, job.steps, true);
    await this.onDone?.(job, r);
  }
  async activeProjects(): Promise<Set<string>> {
    return new Set();
  }
  async pause(): Promise<void> {}
  async close(): Promise<void> {}
}

const concurrency = (s: Stage) => Math.max(1, Number(env(`QUEUE_CONCURRENCY_${s.toUpperCase()}`, s === "plan" ? "2" : "1")) || 1);

export class BullDispatcher implements Dispatcher {
  readonly kind = "bullmq" as const;
  readonly queues: Record<Stage, Queue>;
  private workers: Worker[] = [];

  constructor(private connection = bullConnection()!, private prefix = env("QUEUE_PREFIX", "clipforge")) {
    const q = (s: Stage) => new Queue(QUEUE_NAMES[s], { connection: this.connection, prefix: this.prefix });
    this.queues = { plan: q("plan"), sourcing: q("sourcing"), render: q("render") };
  }

  async start(job: PipelineJob): Promise<void> {
    if (!job.steps.length) return;
    await this.add(job);
  }

  private add(job: PipelineJob): Promise<Job> {
    const { stage } = splitStage(job.steps);
    // One attempt: a failed step needs a person (bad key, missing footage); stalled jobs still rerun.
    return this.queues[stage].add(job.project, job, { attempts: 1, removeOnComplete: { count: 500 }, removeOnFail: { count: 1000 } });
  }

  async startWorkers(stages: Stage[], run: StageRunner, onDone?: DoneHook): Promise<void> {
    for (const stage of stages) {
      const w = new Worker(
        QUEUE_NAMES[stage],
        async (bj: Job<PipelineJob>) => {
          const job = bj.data;
          const { here, rest } = splitStage(job.steps);
          const r = await run(job, here, rest.length === 0);
          if (r.failedStep) {
            await onDone?.(job, r);
            throw new Error(`step ${r.failedStep} failed`);
          }
          if (r.stopped || !rest.length) await onDone?.(job, r);
          else await this.add({ ...job, steps: rest, stageIndex: job.stageIndex + 1 });
          return r;
        },
        { connection: this.connection, prefix: this.prefix, concurrency: concurrency(stage) },
      );
      w.on("error", (e) => console.warn(`[queue] ${stage} worker: ${String(e.message ?? e).slice(0, 200)}`));
      this.workers.push(w);
    }
  }

  async activeProjects(): Promise<Set<string>> {
    const out = new Set<string>();
    for (const q of Object.values(this.queues)) {
      for (const j of await q.getJobs(["active", "waiting", "delayed", "prioritized", "waiting-children"])) if (j?.data?.project) out.add(j.data.project);
    }
    return out;
  }

  /** Pauses new plan-stage work (videos already past planning finish). */
  async pause(paused: boolean): Promise<void> {
    if (paused) await this.queues.plan.pause();
    else await this.queues.plan.resume();
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all(Object.values(this.queues).map((q) => q.close()));
  }
}

/** Local without REDIS_URL, BullMQ with it. */
export function createDispatcher(): Dispatcher {
  return bullConnection() ? new BullDispatcher() : new LocalDispatcher();
}

/** Stages this process works on: QUEUE_WORKERS=all (default) | none | plan,render ... */
export function workerStages(raw = env("QUEUE_WORKERS", "all")): Stage[] {
  const v = raw.trim().toLowerCase();
  if (v === "none" || v === "off") return [];
  if (v === "all" || !v) return [...STAGES];
  return v.split(/[,\s]+/).filter((s): s is Stage => (STAGES as string[]).includes(s));
}

/**
 * Batch queue on Redis (same API as the queue.json BatchQueue). Items live in the hash
 * cf:batch:items (one field per item, so a worker on another machine can update its own item
 * without racing the server); every queued item is a pipeline run in BullMQ, so several videos
 * move through the stages at once (plan of the next while the previous one renders).
 */
export class RedisBatchQueue implements VideoQueue {
  private key = "cf:batch:items";
  private pausedKey = "cf:batch:paused";

  constructor(private r: Redis, private d: Dispatcher, private stepsOf: () => string[]) {}

  private async items(): Promise<QueueItem[]> {
    const raw = await this.r.hgetall(this.key);
    return Object.values(raw).map((v) => JSON.parse(v) as QueueItem).sort((a, b) => a.addedAt.localeCompare(b.addedAt));
  }

  private async put(it: QueueItem & { enqueued?: boolean }): Promise<void> {
    await this.r.hset(this.key, it.id, JSON.stringify(it));
  }

  async list(): Promise<{ paused: boolean; items: QueueItem[]; working: boolean }> {
    const items = await this.items();
    return { paused: (await this.r.get(this.pausedKey)) === "1", items, working: items.some((i) => i.status === "running") };
  }

  async add(projects: string[], useLlm: boolean): Promise<QueueItem[]> {
    const added = projects.map((project, i) => ({ id: `${Date.now().toString(36)}${i}`, project, status: "queued" as const, useLlm, addedAt: new Date().toISOString() }));
    for (const it of added) await this.put(it);
    if ((await this.r.get(this.pausedKey)) !== "1") await this.enqueuePending();
    return added;
  }

  /** Hands queued items that are not in BullMQ yet to the plan queue (batch runs never stop at gates). */
  private async enqueuePending(): Promise<void> {
    for (const it of (await this.items()) as (QueueItem & { enqueued?: boolean })[]) {
      if (it.status !== "queued" || it.enqueued) continue;
      await this.put({ ...it, enqueued: true });
      await this.d.start({ project: it.project, steps: this.stepsOf(), force: false, useLlm: it.useLlm, gate: false, extra: {}, stageIndex: 0, batchId: it.id });
    }
  }

  async remove(id: string): Promise<boolean> {
    const raw = await this.r.hget(this.key, id);
    if (!raw) return false;
    const it = JSON.parse(raw) as QueueItem & { enqueued?: boolean };
    if (it.status === "running" || (it.status === "queued" && it.enqueued)) return false;
    await this.r.hdel(this.key, id);
    return true;
  }

  async retry(id: string): Promise<boolean> {
    const raw = await this.r.hget(this.key, id);
    if (!raw) return false;
    const it = JSON.parse(raw) as QueueItem;
    if (it.status === "running" || it.status === "queued") return false;
    await this.put({ id: it.id, project: it.project, status: "queued", useLlm: it.useLlm, addedAt: it.addedAt });
    if ((await this.r.get(this.pausedKey)) !== "1") await this.enqueuePending();
    return true;
  }

  async clearFinished(): Promise<void> {
    for (const it of await this.items()) if (it.status === "done" || it.status === "failed") await this.r.hdel(this.key, it.id);
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.r.set(this.pausedKey, paused ? "1" : "0");
    if (!paused) await this.enqueuePending();
  }

  /** Called by whichever worker runs a batch item's stages. */
  static async update(r: Redis, id: string, patch: Partial<QueueItem>): Promise<void> {
    const raw = await r.hget("cf:batch:items", id);
    if (!raw) return;
    await r.hset("cf:batch:items", id, JSON.stringify({ ...JSON.parse(raw), ...patch }));
  }
}
