import { run, RunResult } from "../exec.js";

/**
 * Runs an external video tool (explainroo, argo) given as a setting: "explainroo", "npx argo", or a
 * path to a .js entry ("C:\\tools\\explainroo\\bin\\explainroo.js", run with this Node).
 */
export type Exec = (cmd: string, args: string[], o?: { timeoutMs?: number; cwd?: string }) => Promise<RunResult>;

export function splitCommand(command: string): { cmd: string; pre: string[] } {
  const c = command.trim();
  if (/\.m?js$/i.test(c)) return { cmd: process.execPath, pre: [c] };
  const parts = c.split(/\s+/).filter(Boolean);
  // npx / npm on Windows are .cmd files: spawn needs the extension without a shell.
  const head = process.platform === "win32" && /^(npx|npm)$/i.test(parts[0]) ? `${parts[0]}.cmd` : parts[0];
  return { cmd: head, pre: parts.slice(1) };
}

export const execTool: Exec = (cmd, args, o = {}) => {
  if (!o.cwd) return run(cmd, args, { timeoutMs: o.timeoutMs });
  // run() has no cwd: a tiny wrapper with spawn's cwd.
  return import("node:child_process").then(
    ({ spawn }) =>
      new Promise<RunResult>((resolve) => {
        const child = spawn(cmd, args, { cwd: o.cwd, windowsHide: true });
        let stdout = "";
        let stderr = "";
        const timer = o.timeoutMs ? setTimeout(() => child.kill(), o.timeoutMs) : null;
        child.stdout.on("data", (d) => (stdout += d));
        child.stderr.on("data", (d) => (stderr += d));
        child.on("error", (err) => resolve({ code: -1, stdout, stderr: stderr + String(err) }));
        child.on("close", (code) => {
          if (timer) clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      }),
  );
};

export async function runTool(command: string, args: string[], o: { timeoutMs?: number; cwd?: string; exec?: Exec } = {}): Promise<RunResult> {
  const { cmd, pre } = splitCommand(command);
  return (o.exec ?? execTool)(cmd, [...pre, ...args], { timeoutMs: o.timeoutMs, cwd: o.cwd });
}

/**
 * Fails fast when no AI can answer: with the local AI first and Ollama not running, the shared LLM
 * code would wait a minute for it. With an API key as backup ("both"), the API answers instead.
 */
export async function requireAi(): Promise<void> {
  const { engineStatus } = await import("../agents/llm/engine.js");
  const e = await engineStatus();
  const localFirst = e.engine === "local" || e.engine === "both";
  const apiBackup = e.engine === "both" && (e.api.claude || e.api.qwenCloud);
  if (localFirst && !e.local.running && !apiBackup) throw new Error("Qwen not reachable: the local AI (Ollama) is not running. Start Ollama, or switch the AI engine to API.");
}
