import fs from "node:fs";
import path from "node:path";
import type { Discrepancy } from "./align.js";
import type { Assets } from "./assets/types.js";
import { EXTERNAL_CATEGORIES, Ledger, ledgerCategory } from "./assets/licenseLedger.js";
import type { Niche } from "./niche.js";
import { readJson } from "./project.js";
import type { Scene } from "./scenes.js";

/**
 * Pre-approval gate: checks that need no rendered video (they also run inside full QA).
 * Each function is pure over the project files it is given, so tests can call them directly.
 */

export type GateStatus = "pass" | "warn" | "fail";
export interface GateCheck {
  group: string;
  name: string;
  status: GateStatus;
  detail: string;
}

interface ShotLike {
  path: string;
  kind: string;
}
export interface GateScene {
  id: number;
  start: number;
  asset: ShotLike & { source?: string; shots?: ShotLike[] };
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const shotsOf = (s: GateScene): ShotLike[] => (s.asset.shots?.length ? s.asset.shots : [s.asset]);

/** Media files that are missing, empty, or (with a probe) unreadable. */
export async function checkAssetFiles(scenes: GateScene[], probe?: (file: string) => Promise<boolean>): Promise<GateCheck> {
  const missing: string[] = [];
  const corrupt: string[] = [];
  const checked = new Set<string>();
  for (const s of scenes) {
    for (const x of shotsOf(s)) {
      if (checked.has(x.path)) continue;
      checked.add(x.path);
      const name = `#${s.id} ${path.basename(x.path)}`;
      if (!fs.existsSync(x.path)) missing.push(name);
      else if (fs.statSync(x.path).size === 0) corrupt.push(`${name} (empty file)`);
      else if (probe && !(await probe(x.path))) corrupt.push(`${name} (unreadable)`);
    }
  }
  const bad = [...missing.map((m) => `missing ${m}`), ...corrupt.map((c) => `corrupt ${c}`)];
  return { group: "Assets", name: "Media files present and readable", status: bad.length ? "fail" : "pass", detail: bad.length ? bad.slice(0, 10).join("; ") + (bad.length > 10 ? ` (+${bad.length - 10} more)` : "") : `${checked.size} file(s) ok` };
}

/** One clip shown in too many scenes reads as recycled footage. Generated cards do not count. */
export function checkClipReuse(scenes: GateScene[], maxUses = 4): GateCheck {
  const uses = new Map<string, number[]>();
  for (const s of scenes) {
    if (s.asset.source === "graphic") continue;
    for (const p of new Set(shotsOf(s).map((x) => x.path))) uses.set(p, [...(uses.get(p) ?? []), s.id]);
  }
  const over = [...uses.entries()].filter(([, ids]) => ids.length > maxUses).sort((a, b) => b[1].length - a[1].length);
  return {
    group: "Assets",
    name: `Clip reuse (max ${maxUses} scenes per clip)`,
    status: over.length ? "fail" : "pass",
    detail: over.length ? over.slice(0, 6).map(([p, ids]) => `${path.basename(p)} in ${ids.length} scenes (#${ids.join(", #")})`).join("; ") : `${uses.size} distinct clip(s)`,
  };
}

/**
 * Product scenes must show the exact model. A model conflict always fails; an unverified match
 * fails in strict niches (tech-amazon) and warns elsewhere. Own clips, press-kit and official
 * photos filed under the product count as verified (they were filed for that product).
 */
export function checkProductMatches(
  scenes: Pick<Scene, "id" | "type" | "product_name">[],
  assets: Assets,
  niche: Pick<Niche, "productMatch" | "qa">,
  /** Files a human confirmed in the review page (model_verifications.json): path -> verdict. */
  verified: Record<string, "match" | "conflict"> = {},
): GateCheck {
  const products = scenes.filter((s) => s.type === "product" && s.product_name);
  const conflicts: string[] = [];
  const unverified: string[] = [];
  for (const s of products) {
    const a = assets[String(s.id)];
    if (!a || a.source === "graphic") continue;
    const trusted = a.source === "local" || a.source === "presskit";
    const human = verified[a.path];
    if (human === "match") continue;
    if (human === "conflict" || a.modelCheck === "conflict") conflicts.push(`#${s.id} ${s.product_name}`);
    else if (a.modelCheck !== "match" && !trusted) unverified.push(`#${s.id} ${s.product_name}`);
  }
  const strict = niche.productMatch?.strict === true || niche.qa?.unverifiedProduct === "fail";
  const status: GateStatus = conflicts.length ? "fail" : unverified.length ? (strict ? "fail" : "warn") : "pass";
  return {
    group: "Products",
    name: "Exact product model matches",
    status,
    detail: conflicts.length || unverified.length
      ? [conflicts.length ? `${conflicts.length} model conflict(s): ${conflicts.slice(0, 6).join(", ")}` : "", unverified.length ? `${unverified.length} unverified: ${unverified.slice(0, 6).join(", ")}` : ""].filter(Boolean).join("; ") + " - swap or verify in the review page"
      : `${products.length} product scene(s) verified`,
  };
}

/** Every external asset must have a record in licenses.json. */
export function checkLicenseRecords(scenes: Pick<Scene, "id">[], assets: Assets, ledger: Ledger | null): GateCheck {
  if (!ledger) return { group: "Licences", name: "Licence ledger (licenses.json)", status: "fail", detail: "licenses.json missing - run the assets step" };
  const have = new Map(ledger.records.map((r) => [r.sceneId, r]));
  const missing: number[] = [];
  for (const s of scenes) {
    const a = assets[String(s.id)];
    if (!a) continue;
    if (!EXTERNAL_CATEGORIES.includes(ledgerCategory(a.source, a.license))) continue;
    const r = have.get(s.id);
    if (!r || r.path !== a.path || !r.license.trim()) missing.push(s.id);
  }
  return {
    group: "Licences",
    name: "Licence ledger (licenses.json)",
    status: missing.length ? "fail" : "pass",
    detail: missing.length ? `no current licence record for scene(s) ${missing.slice(0, 15).join(", ")} - re-run assets (swaps write the ledger too)` : `${ledger.records.length} record(s), ${ledger.summary.attributionRequired} need attribution`,
  };
}

/** Mode C: significant script/voiceover differences must be resolved before approval. */
export function checkDiscrepancies(discrepancies: Discrepancy[] | null): GateCheck {
  if (!discrepancies) return { group: "Script", name: "Script vs voiceover discrepancies", status: "pass", detail: "no script + voiceover alignment (Mode A / B)" };
  const open = discrepancies.filter((d) => d.severity === "significant" && !d.resolution);
  return {
    group: "Script",
    name: "Script vs voiceover discrepancies",
    status: open.length ? "fail" : "pass",
    detail: open.length
      ? `${open.length} unresolved significant difference(s): ${open.slice(0, 5).map((d) => `${fmt(d.start)} ${d.type} [${d.reasons.join(",")}] "${d.script}" / "${d.heard}"`).join("; ")} - choose keep_audio, correct_transcript or modify_script`
      : `${discrepancies.length} difference(s), all significant ones resolved`,
  };
}

/** Gate checks from the files in a project folder. */
export async function preflightChecks(
  dir: string,
  ctx: { scenes: Scene[]; assets: Assets; timelineScenes: GateScene[]; niche: Pick<Niche, "productMatch" | "qa">; ledger: Ledger | null },
  probe?: (file: string) => Promise<boolean>,
): Promise<GateCheck[]> {
  const discFile = path.join(dir, "discrepancies.json");
  const discrepancies = fs.existsSync(discFile) ? readJson<{ items: Discrepancy[] }>(discFile).items : null;
  return [
    await checkAssetFiles(ctx.timelineScenes, probe),
    checkClipReuse(ctx.timelineScenes, ctx.niche.qa?.maxClipUses ?? 4),
    checkProductMatches(ctx.scenes, ctx.assets, ctx.niche, readVerifications(dir)),
    checkLicenseRecords(ctx.scenes, ctx.assets, ctx.ledger),
    checkDiscrepancies(discrepancies),
  ];
}

const verificationsFile = (dir: string) => path.join(dir, "model_verifications.json");

/** Human verdicts on product media, keyed by file path so they survive re-runs of the assets step. */
export function readVerifications(dir: string): Record<string, "match" | "conflict"> {
  const f = verificationsFile(dir);
  return fs.existsSync(f) ? readJson<Record<string, "match" | "conflict">>(f) : {};
}

export function saveVerification(dir: string, file: string, verdict: "match" | "conflict" | null): void {
  const all = readVerifications(dir);
  if (verdict) all[file] = verdict;
  else delete all[file];
  fs.writeFileSync(verificationsFile(dir), JSON.stringify(all, null, 1));
}
