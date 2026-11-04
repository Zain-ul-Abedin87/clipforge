import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";

/**
 * A long-running Python worker (python/kokoro_tts.py, python/xtts_tts.py): the model loads once,
 * then every sentence is one JSON line in, one JSON line out. Requests are queued (one at a time).
 */

export type Spawn = (cmd: string, args: string[]) => ChildProcessWithoutNullStreams;

export class LineWorker {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private waiting: ((line: string) => void)[] = [];
  private ready: Promise<Record<string, unknown>> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private stderr = "";

  constructor(
    private cmd: string,
    private args: string[],
    private spawnFn: Spawn = (c, a) => spawn(c, a, { windowsHide: true }),
    private timeoutMs = 10 * 60_000,
  ) {}

  private nextLine(timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`worker timed out after ${Math.round(timeoutMs / 1000)} s${this.stderr ? `: ${this.stderr.slice(-300)}` : ""}`)), timeoutMs);
      this.waiting.push((l) => (clearTimeout(t), resolve(l)));
    });
  }

  start(): Promise<Record<string, unknown>> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const child = this.spawnFn(this.cmd, this.args);
      this.child = child;
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (d: string) => {
        this.buf += d;
        let i;
        while ((i = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (line.startsWith("{")) this.waiting.shift()?.(line);
        }
      });
      child.stderr.on("data", (d) => (this.stderr = (this.stderr + String(d)).slice(-4000)));
      child.on("close", (code) => {
        for (const w of this.waiting.splice(0)) w(JSON.stringify({ ok: false, ready: false, error: `worker exited (${code}): ${this.stderr.slice(-300)}` }));
        this.child = null;
      });
      child.on("error", (err) => {
        for (const w of this.waiting.splice(0)) w(JSON.stringify({ ok: false, ready: false, error: err.message }));
      });
      const hello = JSON.parse(await this.nextLine(this.timeoutMs)) as Record<string, unknown>;
      if (!hello.ready) throw new Error(String(hello.error ?? "worker did not start"));
      return hello;
    })();
    return this.ready;
  }

  /** Sends one job; resolves with the worker's answer (throws on {ok:false}). */
  request(job: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = async () => {
      await this.start();
      if (!this.child) throw new Error(`worker is not running${this.stderr ? `: ${this.stderr.slice(-300)}` : ""}`);
      const answer = this.nextLine(this.timeoutMs);
      this.child.stdin.write(JSON.stringify(job) + "\n");
      const r = JSON.parse(await answer) as Record<string, unknown>;
      if (!r.ok) throw new Error(String(r.error ?? "worker failed"));
      return r;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  close(): void {
    this.child?.stdin.end();
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }
}
