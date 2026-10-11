import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { env } from "./env.js";
import { paths } from "./paths.js";

// The Microsoft Store "python.exe" alias in WindowsApps is a stub, not a real interpreter.
const isStoreStub = (p: string) => p.toLowerCase().includes("\\windowsapps\\");

function whereAll(name: string): string[] {
  try {
    return execFileSync("where.exe", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Finds an executable: explicit env var -> PATH -> known install dirs.
 * Known dirs matter right after a winget install, when this shell's PATH is stale.
 */
function resolveExe(envVar: string, exe: string, extraDirs: string[]): string | null {
  const explicit = env(envVar);
  if (explicit && fs.existsSync(explicit)) return explicit;

  const onPath = whereAll(exe).find((p) => !isStoreStub(p));
  if (onPath) return onPath;

  for (const dir of extraDirs) {
    const candidate = path.join(dir, exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function wingetFfmpegDirs(): string[] {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  const dirs = [path.join(local, "Microsoft", "WinGet", "Links")];
  const pkgRoot = path.join(local, "Microsoft", "WinGet", "Packages");
  if (fs.existsSync(pkgRoot)) {
    for (const pkg of fs.readdirSync(pkgRoot).filter((d) => d.toLowerCase().startsWith("gyan.ffmpeg"))) {
      const pkgDir = path.join(pkgRoot, pkg);
      for (const build of fs.readdirSync(pkgDir)) {
        dirs.push(path.join(pkgDir, build, "bin"));
      }
    }
  }
  return dirs;
}

export function ffmpegPath(): string | null {
  return resolveExe("FFMPEG_PATH", "ffmpeg.exe", wingetFfmpegDirs());
}

export function ffprobePath(): string | null {
  return resolveExe("FFPROBE_PATH", "ffprobe.exe", wingetFfmpegDirs());
}

/** Base Python 3.11 used to create the project venv. */
export function basePythonPath(): string | null {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return resolveExe("PYTHON_PATH", "python.exe", [
    path.join(local, "Programs", "Python", "Python311"),
    "C:\\Program Files\\Python311",
  ]);
}

/** The project venv interpreter, if the venv exists. */
export function venvPythonPath(): string | null {
  return fs.existsSync(paths.venvPython) ? paths.venvPython : null;
}
