/**
 * Dry-run niche auto-detect on three sample scripts (no render).
 * Usage: npx tsx scripts/dry-niche-detect.ts
 */
import fs from "node:fs";
import path from "node:path";
import { detectAndWriteNiche, heuristicDetect } from "../src/lib/nicheDetect.js";
import { paths } from "../src/lib/paths.js";

const samples: { id: string; title: string; script: string }[] = [
  {
    id: "ccw-today",
    title: "Best Budget CCW Pistols Under $350",
    script: fs.existsSync(path.join(paths.root, "inputs/ccw-today/script.txt"))
      ? fs.readFileSync(path.join(paths.root, "inputs/ccw-today/script.txt"), "utf8")
      : "Ruger LCP MAX and Taurus G3C are budget carry pistols with 9mm and .380 Auto capacity.",
  },
  {
    id: "tech-sample",
    title: "Best Noise Cancelling Headphones Under $300",
    script: `Looking for the best noise cancelling headphones under three hundred dollars? We tested the Sony WH-1000XM5, Bose QuietComfort Ultra, and the Anker Soundcore Space One. The Sony WH-1000XM5 delivers thirty hours of battery life and class-leading ANC. Bose focuses on plush comfort and a fold-flat case. Anker's Soundcore Space One is the budget king at around one hundred twenty dollars with solid Bluetooth multipoint. Unboxing each pair, we checked the ear cups, the app EQ, and real-world commute noise.`,
  },
  {
    id: "kitchen-sample",
    title: "Best Air Fryers for Small Kitchens",
    script: `If your counter space is tight, these air fryers still get dinner done fast. The Ninja Air Fryer Pro crisps fries in fifteen minutes. Cosori's 5.8 quart basket fits a family meal without dominating the kitchen. Instant Vortex is the budget pick under eighty dollars. We ran frozen fries, chicken wings, and roasted vegetables through each, watching for even browning and easy cleanup.`,
  },
];

async function main() {
  const outRoot = path.join(paths.root, "workspace", "_niche-detect-dry");
  fs.mkdirSync(outRoot, { recursive: true });
  const results = [];
  for (const s of samples) {
    const dir = path.join(outRoot, s.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    console.log("\n====", s.id, "====");
    const { niche, meta } = await detectAndWriteNiche(dir, { title: s.title, script: s.script }, console.log);
    const pacing = (niche as { pacing?: { targetShotSec?: number } }).pacing;
    const pool = (niche as { productPool?: { queries?: string[]; category?: string } }).productPool;
    const stock = niche.stock;
    const row = {
      id: s.id,
      source: meta.source,
      category: meta.category,
      label: niche.label,
      targetShotSec: meta.targetShotSec,
      pacingTarget: pacing?.targetShotSec,
      allowStock: niche.product.allowStock,
      productCategory: pool?.category,
      productQueries: pool?.queries?.slice(0, 5),
      hintCount: stock?.hints?.length ?? 0,
      hintsSample: (stock?.hints ?? []).slice(0, 3),
      fallbackQuery: stock?.fallbackQuery,
      nicheFile: path.join(dir, "niche.json"),
    };
    results.push(row);
    console.log(JSON.stringify(row, null, 2));
    // also show heuristic-only for comparison
    const h = heuristicDetect(s.title, s.script);
    console.log("heuristic-only:", h.category, h.targetShotSec);
  }
  fs.writeFileSync(path.join(outRoot, "RESULTS.json"), JSON.stringify(results, null, 2) + "\n");
  console.log("\nWrote", path.join(outRoot, "RESULTS.json"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});