import fs from "node:fs";
import dotenv from "dotenv";
import { paths } from "./paths.js";

/**
 * Loads .env over the inherited environment. `override` matters: the web server spawns step
 * processes with its own env, and a key added to .env after the server started must still win.
 */
export function reloadEnv(): void {
  if (fs.existsSync(paths.envFile)) {
    dotenv.config({ path: paths.envFile, override: true, quiet: true });
  }
}

reloadEnv();

export function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : fallback;
}

/** Reports whether a key is set without ever exposing its value. */
export function hasKey(name: string): boolean {
  return env(name) !== "";
}
