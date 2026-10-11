import { spawn } from "node:child_process";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a binary without a shell (paths with spaces are safe). `timeoutMs` kills a process that
 * hangs (e.g. FFmpeg waiting forever on a stalled network read) and reports it as a failure.
 */
export function run(cmd: string, args: string[], opts: { echo?: boolean; timeoutMs?: number } = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    if (opts.timeoutMs) {
      const timer = setTimeout(() => {
        stderr += `\n[killed after ${Math.round(opts.timeoutMs! / 1000)} s without finishing]`;
        child.kill();
      }, opts.timeoutMs);
      child.on("close", () => clearTimeout(timer));
    }
    child.stdout.on("data", (d) => {
      stdout += d;
      if (opts.echo) process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      stderr += d;
      if (opts.echo) process.stderr.write(d);
    });
    child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
