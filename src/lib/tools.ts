import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { env } from "./env.js";
import { paths } from "./paths.js";

const IS_WIN = process.platform === "win32";

// The Microsoft Store "python.exe" alias in WindowsApps is a stub, not a real interpreter.
const isStoreStub = (p: string) => p.toLowerCase().includes("\\windowsapps\\");

/** Platform file name of a program: "ffmpeg" -> ffmpeg.exe on Windows, ffmpeg elsewhere. */
export const exeName = (base: string) => (IS_WIN ? `${base}.exe` : base);

/** Every match for `name` on PATH, in PATH order (where.exe on Windows, a PATH scan elsewhere). */
function whereAll(name: string): string[] {
  if (IS_WIN) {
    try {
      return execFileSync("where.exe", [name], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }
  const out: string[] = [];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) out.push(p);
    } catch {
      /* not here */
    }
  }
  return out;
}

/** First `name` (platform file name) on PATH, or null. */
export const findOnPath = (name: string): string | null => whereAll(exeName(name)).find((p) => !isStoreStub(p)) ?? null;

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
  if (!IS_WIN) return [];
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
  return resolveExe("FFMPEG_PATH", exeName("ffmpeg"), wingetFfmpegDirs());
}

export function ffprobePath(): string | null {
  return resolveExe("FFPROBE_PATH", exeName("ffprobe"), wingetFfmpegDirs());
}

/** Base Python (3.11 on Windows, python3 elsewhere) used to create the project venv. */
export function basePythonPath(): string | null {
  if (!IS_WIN) return resolveExe("PYTHON_PATH", "python3", []) ?? resolveExe("PYTHON_PATH", "python", []);
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");
  return resolveExe("PYTHON_PATH", "python.exe", [
    path.join(local, "Programs", "Python", "Python311"),
    "C:\\Program Files\\Python311",
  ]);
}

/**
 * The interpreter that runs python/*.py: VENV_PYTHON (e.g. a container's venv) if set, else the
 * project venv (.venv), if it exists.
 */
export function venvPythonPath(): string | null {
  const explicit = env("VENV_PYTHON");
  if (explicit && fs.existsSync(explicit)) return explicit;
  return fs.existsSync(paths.venvPython) ? paths.venvPython : null;
}
