import type { Redis } from "ioredis";

/**
 * Where pipeline job state and logs live. Memory (no REDIS_URL): nothing is persisted, the server's
 * own map is the state, as before. Redis: every state change and log line is written through, so a
 * restarted server, or another machine's worker, sees the same job.
 * Keys: cf:job:<project> (state JSON), cf:job:<project>:log (last LOG_KEEP lines),
 * cf:job:<project>:logtotal (lines ever written, so "?since=N" polling stays exact after trimming).
 */

export interface JobState {
  running: boolean;
  step: string | null;
  failedStep: string | null;
  log: string[];
  startedAt: number;
  finishedAt?: number;
  /** Stopped after the plan: waiting for the user to approve it. */
  awaitingApproval?: boolean;
  /** Stopped after the timeline: waiting for the user to review scenes and press Render. */
  awaitingReview?: boolean;
  /** BullMQ: the stage queue the next steps wait in. */
  queuedStage?: string;
}

export type StoredState = Omit<JobState, "log">;

export interface JobStore {
  readonly kind: "memory" | "redis";
  save(project: string, state: StoredState): Promise<void>;
  append(project: string, lines: string[]): Promise<void>;
  clearLog(project: string): Promise<void>;
  loadMany(projects: string[]): Promise<Map<string, StoredState>>;
  logSince(project: string, since: number): Promise<{ total: number; lines: string[] }>;
}

export const LOG_KEEP = 2000;

export class MemoryJobStore implements JobStore {
  readonly kind = "memory" as const;
  async save(): Promise<void> {}
  async append(): Promise<void> {}
  async clearLog(): Promise<void> {}
  async loadMany(): Promise<Map<string, StoredState>> {
    return new Map();
  }
  async logSince(): Promise<{ total: number; lines: string[] }> {
    return { total: 0, lines: [] };
  }
}

export class RedisJobStore implements JobStore {
  readonly kind = "redis" as const;
  constructor(private r: Redis, private prefix = "cf:job:") {}

  private k(p: string, suffix = "") {
    return `${this.prefix}${p}${suffix}`;
  }

  async save(project: string, state: StoredState): Promise<void> {
    await this.r.set(this.k(project), JSON.stringify(state));
  }

  async append(project: string, lines: string[]): Promise<void> {
    if (!lines.length) return;
    await this.r
      .multi()
      .rpush(this.k(project, ":log"), ...lines)
      .ltrim(this.k(project, ":log"), -LOG_KEEP, -1)
      .incrby(this.k(project, ":logtotal"), lines.length)
      .exec();
  }

  async clearLog(project: string): Promise<void> {
    await this.r.multi().del(this.k(project, ":log")).set(this.k(project, ":logtotal"), 0).exec();
  }

  async loadMany(projects: string[]): Promise<Map<string, StoredState>> {
    const out = new Map<string, StoredState>();
    if (!projects.length) return out;
    const raw = await this.r.mget(...projects.map((p) => this.k(p)));
    raw.forEach((v, i) => {
      if (!v) return;
      try {
        out.set(projects[i], JSON.parse(v) as StoredState);
      } catch {
        /* unreadable entry: treated as no job */
      }
    });
    return out;
  }

  async logSince(project: string, since: number): Promise<{ total: number; lines: string[] }> {
    const total = Number((await this.r.get(this.k(project, ":logtotal"))) ?? 0);
    const want = Math.min(total - Math.max(0, since), LOG_KEEP);
    if (want <= 0) return { total, lines: [] };
    return { total, lines: await this.r.lrange(this.k(project, ":log"), -want, -1) };
  }
}
