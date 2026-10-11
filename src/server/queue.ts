import fs from "node:fs";
import path from "node:path";
import { paths } from "../lib/paths.js";

export interface QueueItem {
  id: string;
  project: string;
  status: "queued" | "running" | "done" | "failed";
  useLlm: boolean;
  addedAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** QA summary of the finished video. */
  qa?: { pass: number; warn: number; fail: number };
}

interface QueueState {
  paused: boolean;
  items: QueueItem[];
}

const FILE = path.join(paths.workspace, "queue.json");

/**
 * Batch queue: videos run one after another through the whole pipeline (one at a time, so RAM
 * stays low). State lives in workspace/queue.json, so a restart resumes where it stopped.
 */
export class BatchQueue {
  private state: QueueState;
  private working = false;

  constructor(
    private runProject: (project: string, useLlm: boolean) => Promise<{ failedStep: string | null }>,
    private isBusy: () => boolean,
  ) {
    this.state = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { paused: false, items: [] };
    // An item that was running when the server stopped starts over (each step resumes from cache).
    for (const it of this.state.items) if (it.status === "running") it.status = "queued";
    this.save();
    setInterval(() => void this.tick(), 3000);
  }

  private save(): void {
    fs.mkdirSync(paths.workspace, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(this.state, null, 2));
  }

  list(): QueueState & { working: boolean } {
    return { ...this.state, working: this.working };
  }

  add(projects: string[], useLlm: boolean): QueueItem[] {
    const added = projects.map((project, i) => ({
      id: `${Date.now().toString(36)}${i}`,
      project,
      status: "queued" as const,
      useLlm,
      addedAt: new Date().toISOString(),
    }));
    this.state.items.push(...added);
    this.save();
    void this.tick();
    return added;
  }

  remove(id: string): boolean {
    const it = this.state.items.find((x) => x.id === id);
    if (!it || it.status === "running") return false;
    this.state.items = this.state.items.filter((x) => x.id !== id);
    this.save();
    return true;
  }

  retry(id: string): boolean {
    const it = this.state.items.find((x) => x.id === id);
    if (!it || it.status === "running" || it.status === "queued") return false;
    Object.assign(it, { status: "queued", error: undefined, startedAt: undefined, finishedAt: undefined });
    this.save();
    void this.tick();
    return true;
  }

  clearFinished(): void {
    this.state.items = this.state.items.filter((x) => x.status === "queued" || x.status === "running");
    this.save();
  }

  setPaused(paused: boolean): void {
    this.state.paused = paused;
    this.save();
    if (!paused) void this.tick();
  }

  /** Starts the next queued video when nothing else (queue or a manual run) is rendering. */
  private async tick(): Promise<void> {
    if (this.working || this.state.paused || this.isBusy()) return;
    const next = this.state.items.find((x) => x.status === "queued");
    if (!next) return;
    this.working = true;
    next.status = "running";
    next.startedAt = new Date().toISOString();
    this.save();
    try {
      const r = await this.runProject(next.project, next.useLlm);
      next.status = r.failedStep ? "failed" : "done";
      if (r.failedStep) next.error = `stopped at step: ${r.failedStep}`;
      const qaFile = path.join(paths.workspace, next.project, "qa_report.json");
      if (fs.existsSync(qaFile)) next.qa = JSON.parse(fs.readFileSync(qaFile, "utf8")).summary;
    } catch (err) {
      next.status = "failed";
      next.error = String((err as Error).message ?? err);
    }
    next.finishedAt = new Date().toISOString();
    this.working = false;
    this.save();
    void this.tick();
  }
}
