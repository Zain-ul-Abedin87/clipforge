import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const paths = {
  root: ROOT,
  inputs: path.join(ROOT, "inputs"),
  channels: path.join(ROOT, "channels"),
  workspace: path.join(ROOT, "workspace"),
  output: path.join(ROOT, "output"),
  python: path.join(ROOT, "python"),
  // Windows venvs keep the interpreter in Scripts\python.exe, POSIX ones in bin/python.
  venvPython: process.platform === "win32" ? path.join(ROOT, ".venv", "Scripts", "python.exe") : path.join(ROOT, ".venv", "bin", "python"),
  envFile: path.join(ROOT, ".env"),
};
