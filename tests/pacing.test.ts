import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyPacing, cutTimes, farthestIn, pacingConfig, randomCuts, randomPieces, seededRandom, ShotLedger, type PacingConfig, type SubShot } from "../src/lib/pacing.js";
import { checkExactRepeats, checkShotLength, type GateScene } from "../src/lib/qaGate.js";
import { webClipSeconds } from "../src/lib/assets/webCrawler.js";
import type { Niche } from "../src/lib/niche.js";
import type { Scene } from "../src/lib/scenes.js";

const niche = (pacing?: Record<string, unknown>) => ({ name: "t", ...(pacing ? { pacing } : {}) }) as unknown as Niche;
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("random shot lengths (2 / 3 / 4 s)", () => {
  test("every piece is 2-4 s and the pieces fill the scene", () => {
    for (let seed = 1; seed < 400; seed++) {
      const len = 4.1 + (seed % 97) / 7; // 4.1 .. 17.8 s
      const p = randomPieces(len, [2, 3, 4], seededRandom(seed));
      assert.ok(Math.abs(sum(p) - len) < 1e-6, `sum ${sum(p)} != ${len}`);
      for (const x of p) assert.ok(x >= 2 - 1e-6 && x <= 4 + 1e-6, `piece ${x} of ${len}`);
    }
  });

  test("lengths vary (not one fixed length)", () => {
    const all = new Set<number>();
    for (let seed = 1; seed < 50; seed++) for (const x of randomPieces(12, [2, 3, 4], seededRandom(seed))) all.add(Math.round(x));
    assert.deepEqual([...all].sort(), [2, 3, 4]);
  });

  test("short scenes stay whole", () => {
    assert.deepEqual(randomPieces(3.6, [2, 3, 4], seededRandom(1)), [3.6]);
    assert.deepEqual(randomPieces(1.5, [2, 3, 4], seededRandom(1)), [1.5]);
  });

  test("same scene start -> same cuts (render cache stays valid)", () => {
    assert.deepEqual(randomCuts(10, 21, [], [2, 3, 4]), randomCuts(10, 21, [], [2, 3, 4]));
  });

  test("a 7 s scene is never one 7 s shot; word snapping keeps the 4 s maximum", () => {
    const words = Array.from({ length: 40 }, (_, k) => ({ word: "w", start: 20 + k * 0.23, end: 20 + k * 0.23 + 0.2 }));
    for (let s = 20; s < 21; s += 0.1) {
      const cuts = randomCuts(s, s + 7, words, [2, 3, 4]);
      const b = [s, ...cuts, s + 7];
      assert.ok(cuts.length >= 1);
      for (let k = 1; k < b.length; k++) assert.ok(b[k] - b[k - 1] <= 4 + 1e-3 && b[k] - b[k - 1] >= 2 - 1e-3, `piece ${b[k] - b[k - 1]}`);
    }
  });
});

describe("pacingConfig", () => {
  test("niches without a pacing block now cut (random 2-4 s)", () => {
    const c = pacingConfig(niche(), false);
    assert.equal(c.enabled, true);
    assert.deepEqual(c.shotChoices, [2, 3, 4]);
  });
  test("tuned niches keep their target pacing; enabled:false and PACING=off still switch it off", () => {
    assert.deepEqual(pacingConfig(niche({ enabled: true, targetShotSec: 2.1, maxShotSec: 3 }), false).shotChoices, []);
    assert.equal(pacingConfig(niche({ enabled: false }), false).enabled, false);
    assert.equal(pacingConfig(niche(), true).enabled, false);
  });
  test("cutTimes uses the random mode when shotChoices is set", () => {
    const cfg: PacingConfig = { ...pacingConfig(niche(), false), shotChoices: [2, 3, 4] };
    assert.deepEqual(cutTimes(5, 14, [], cfg), randomCuts(5, 14, [], [2, 3, 4]));
  });
});

describe("no repeated footage", () => {
  test("farthestIn stays inside the file and away from shown moments", () => {
    const l = new ShotLedger();
    l.take("k", 0, 2, 1);
    const at = farthestIn(l, "k", 6, 2, 0);
    assert.ok(at + 2 <= 6 && at >= 3.5, `in ${at}`);
    assert.equal(farthestIn(l, "k", 1.5, 2, 0), 0); // shorter than needed: never a negative in-point
  });

  test("a 7 s scene on a 7.5 s clip shows different moments, never the same frames twice", () => {
    const scenes = [{ id: 1, type: "broll", text: "old servers humming", start: 0, end: 7 }] as unknown as Scene[];
    const tl = [{ id: 1, startFrame: 0, endFrame: 210, transition: "cut", asset: { path: "/w/clip.mp4", kind: "video" as const, source: "pexels", duration: 7.5, in: 0 } }];
    const cfg: PacingConfig = { ...pacingConfig(niche(), false), shotChoices: [2, 3, 4] };
    applyPacing(tl, scenes, [], [], cfg, () => {});
    const shots = tl[0].asset.shots as SubShot[];
    assert.ok(shots.length >= 2);
    assert.equal(sum(shots.map((s) => s.frames)), 210);
    for (const s of shots) assert.ok(s.frames <= 120, `shot of ${s.frames} frames`);
    const ins = shots.map((s) => `${s.in}|${s.variant ?? ""}`);
    assert.equal(new Set(ins).size, ins.length, `repeated moment: ${ins.join(", ")}`);
    for (const s of shots) assert.ok(s.in + s.frames / 30 <= 7.5 + 1e-6, "window runs past the end of the file (renderer would loop it)");
  });
});

describe("QA gate", () => {
  const scene = (id: number, shots: { in: number; frames: number; variant?: string }[]): GateScene => ({
    id,
    start: 0,
    asset: { path: "/a.mp4", kind: "video", source: "pexels", shots: shots.map((s) => ({ path: "/a.mp4", kind: "video", ...s })) },
  });
  test("checkExactRepeats fails on the same moment twice, passes on a mirrored reuse", () => {
    assert.equal(checkExactRepeats([scene(1, [{ in: 0, frames: 60 }]), scene(2, [{ in: 0, frames: 60 }])]).status, "fail");
    assert.equal(checkExactRepeats([scene(1, [{ in: 0, frames: 60 }]), scene(2, [{ in: 0, frames: 60, variant: "mirror" }])]).status, "pass");
  });
  test("checkShotLength warns above 4 s", () => {
    assert.equal(checkShotLength([scene(1, [{ in: 0, frames: 210 }])]).status, "warn");
    assert.equal(checkShotLength([scene(1, [{ in: 0, frames: 120 }, { in: 4, frames: 90 }])]).status, "pass");
  });
});

describe("web_cc clip length", () => {
  test("covers the whole scene, so the renderer never loops the file", () => {
    assert.equal(webClipSeconds(6.4), 8);
    assert.equal(webClipSeconds(15), 16); // was capped at 12 s -> a 15 s scene looped
    assert.equal(webClipSeconds(2), 5);
    assert.equal(webClipSeconds(90), 30);
  });
});
