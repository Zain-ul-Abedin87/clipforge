import fs from "node:fs";
import path from "node:path";
import { paths } from "./paths.js";

export interface Style {
  name: string;
  scenes: { avgLengthSec: number; minLengthSec: number; maxLengthSec: number };
  captions: { enabled: boolean };
  [key: string]: unknown;
}

export function listChannels(): string[] {
  if (!fs.existsSync(paths.channels)) return [];
  return fs
    .readdirSync(paths.channels)
    .filter((d) => fs.existsSync(path.join(paths.channels, d, "style.json")));
}

export function loadStyle(channel = "default"): Style {
  const file = path.join(paths.channels, channel, "style.json");
  if (!fs.existsSync(file)) throw new Error(`Channel style not found: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")) as Style;
}
