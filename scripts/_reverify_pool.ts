// One-off: re-check cached product pools with the stricter exact-model prompt (no downloads).
import fs from "node:fs";
import path from "node:path";
import { verifyCandidates } from "../src/lib/agent/visionVerify.js";
import { exactModelPrompt } from "../src/lib/assets/productPool.js";
const files = process.argv.slice(3);
const cat = process.argv[2];
for (const f of files) {
  const shots = JSON.parse(fs.readFileSync(f, "utf8"));
  const name = shots[0]?.product;
  if (!name) continue;
  const text = exactModelPrompt(name, cat);
  const items = [];
  for (let k = 0; k < shots.length; k += 4) items.push({ sceneId: 9000 + k, text, before: "", cands: shots.slice(k, k + 4).map((s: any) => ({ id: s.id, frames: (s.frames ?? []).slice(0, 3) })) });
  const v = await verifyCandidates(items, `${name}`, path.join("workspace", "mower-v2", "vision_pool_v3.json"), console.log);
  const keep = shots.filter((s: any, i: number) => v.get(`${9000 + Math.floor(i / 4) * 4}|${s.id}`) !== false);
  console.log(`[reverify] ${name}: kept ${keep.length}/${shots.length} (${path.basename(f)})`);
  fs.writeFileSync(f, JSON.stringify(keep, null, 1));
}