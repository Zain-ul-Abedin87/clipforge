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
  venvPython: path.join(ROOT, ".venv", "Scripts", "python.exe"),
  envFile: path.join(ROOT, ".env"),
};
