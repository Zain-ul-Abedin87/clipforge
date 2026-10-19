import fs from "node:fs";
import path from "node:path";
import { titleHasModel } from "../agents/youtube/ytExtractor.js";
import { recordFromName } from "../productResearch.js";
import { coreModel, hasModelToken } from "../productNames.js";

/**
 * Fallback trust for a press-kit photo the vision check never judged (local vision model crashed,
 * too slow on the CPU, or off). A clear "no" from vision is never overridden; only "not checked"
 * photos come here. A retailer photo (retail_*, logged in retail_sources.json) counts when its
 * listing title / URL names the brand and the model (or its core code, "R40"); an official
 * press-kit photo (any other file: the brand's own product page) counts as it is.
 * PHOTO_NAME_TRUST=off keeps the old rule (only vision-confirmed photos).
 */
export const photoNameTrustEnabled = () => (process.env.PHOTO_NAME_TRUST ?? "on").toLowerCase() !== "off";

type Sources = Record<string, { title?: string; url?: string; source?: string }>;

export function readRetailSources(dir: string): Sources {
  const f = path.join(dir, "retail_sources.json");
  try {
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, "")) as Sources) : {};
  } catch {
    return {};
  }
}

export function nameTrusted(file: string, product: string, sources: Sources): boolean {
  const base = path.basename(file);
  if (!base.startsWith("retail_")) return true;
  const s = sources[base];
  if (!s) return false;
  const text = `${s.title ?? ""} ${s.url ?? ""} ${s.source ?? ""}`.toLowerCase();
  const rec = recordFromName(product);
  const brandOk = !rec.manufacturer || text.includes(rec.manufacturer.toLowerCase());
  const models = [rec.model, coreModel(rec.model)].filter(hasModelToken);
  return brandOk && models.some((m) => titleHasModel(text, m));
}
