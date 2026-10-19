import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyPacing, cutTimes, pacingConfig, randomPieces, seededRandom, type PacingConfig, type SubShot } from "../src/lib/pacing.js";
import { hookText, hookTitleProps } from "../src/lib/render/hookTitle.js";
import { cardFrames } from "../src/lib/render/remotionCards.js";
import type { PoolShot } from "../src/lib/assets/productPool.js";
import type { Niche } from "../src/lib/niche.js";
import type { Scene } from "../src/lib/scenes.js";

const cfg = (o: Partial<PacingConfig> = {}): PacingConfig => ({ ...pacingConfig({ name: "t" } as unknown as Niche, false), ...o });
const pieces = (start: number, end: number, cuts: number[]) => [start, ...cuts, end].slice(1).map((b, k) => b - [start, ...cuts][k]);

describe("randomPieces with narrow ranges", () => {
  test("every piece stays in range whenever the length can be split; never above the max", () => {
    for (const ch of [[1.5, 2, 2.5], [0.6, 0.8, 1], [2, 3, 4]]) {
      const lo = ch[0], hi = ch[ch.length - 1];
      for (let i = 0; i < 600; i++) {
        const len = 0.3 + i * 0.037;
        const p = randomPieces(len, ch, seededRandom(i + 1));
        assert.ok(Math.abs(p.reduce((a, b) => a + b, 0) - len) < 1e-6, "sum");
        const splittable = len <= hi || Math.ceil(len / hi - 1e-9) * lo <= len + 1e-9;
        for (const x of p) {
          assert.ok(x <= Math.max(hi, len <= hi ? len : 0) + 1e-6, `piece ${x} > max for ${len} ${ch}`);
          if (splittable && len >= lo) assert.ok(x >= lo - 1e-6, `piece ${x} < min for ${len} ${ch}`);
        }
      }
    }
  });
});

describe("opening pace", () => {
  test("hook region: 0.6-1 s teaser shots, then the normal 2-4 s pace", () => {
    const c = cfg({ hookEnd: 4.4, introEnd: 30 });
    const p = pieces(0, 12, cutTimes(0, 12, [], c));
    let t = 0;
    for (const x of p) {
      if (t < 4.4 - 1e-6) assert.ok(x >= 0.6 - 1e-6 && x <= 1 + 1e-6, `teaser shot ${x} at ${t}`);
      else assert.ok(x >= 1.5 - 1e-6 && x <= 2.5 + 1e-6, `intro shot ${x} at ${t}`);
      t += x;
    }
    assert.ok(cutTimes(0, 12, [], c).includes(4.4), "a cut lands exactly where the hook ends");
  });

  test("after the intro the 2-4 s random pace is back", () => {
    for (const x of pieces(40, 52, cutTimes(40, 52, [], cfg({ hookEnd: 4.4, introEnd: 30 })))) assert.ok(x >= 2 - 1e-6 && x <= 4 + 1e-6, `shot ${x}`);
  });

  test("TEASER_CHOICES=off / INTRO_CHOICES=off keep the old opening", () => {
    process.env.TEASER_CHOICES = "off";
    process.env.INTRO_CHOICES = "off";
    try {
      const c = cfg({ hookEnd: 4.4, introEnd: 30 });
      assert.deepEqual(c.teaserChoices, []);
      assert.deepEqual(cutTimes(0, 12, [], c), cutTimes(0, 12, [], cfg()));
    } finally {
      delete process.env.TEASER_CHOICES;
      delete process.env.INTRO_CHOICES;
    }
  });
});

describe("hook teaser picks", () => {
  const shot = (product: string, i: number, imgSim: number): PoolShot => ({
    id: `${product}${i}`, product, path: `/pool/${product}_${i}.mp4`, url: `https://v/${product}${i}`, license: "x",
    duration: 6, imgSim, textSim: 0.2, sceneSim: {}, frames: [], verified: true,
  });
  test("the teaser cycles through every product's verified footage, never one product twice in a row", () => {
    const scenes = [
      { id: 0, type: "stock", text: "Stop buying the wrong mower.", start: 0, end: 8, section: 0 },
      { id: 1, type: "product", text: "Number 2 is the Honda.", start: 8, end: 14, section: 1, product_name: "Honda" },
      { id: 2, type: "product", text: "Number 1 is the Toro.", start: 14, end: 20, section: 2, product_name: "Toro" },
    ] as unknown as Scene[];
    const tl = scenes.map((s) => ({ id: s.id, startFrame: s.start * 30, endFrame: s.end * 30, transition: "cut", asset: { path: `/stock/${s.id}.mp4`, kind: "video" as const, source: "pexels", duration: 10, in: 0 } }));
    const pool = [shot("Honda", 0, 0.9), shot("Honda", 1, 0.5), shot("Toro", 0, 0.8), shot("Toro", 1, 0.4)];
    applyPacing(tl, scenes, [], pool, cfg({ hookEnd: 4, introEnd: 8 }), () => {});
    const hook: SubShot[] = [];
    let t = 0;
    for (const s of tl[0].asset.shots as SubShot[]) {
      if (t < 4 - 1e-6) hook.push(s);
      t += s.frames / 30;
    }
    assert.ok(hook.length >= 4, `${hook.length} teaser shots`);
    assert.ok(hook.every((s) => s.product && s.verified), "teaser shots are verified product footage");
    for (let i = 1; i < hook.length; i++) assert.notEqual(hook[i].product, hook[i - 1].product, "alternates products");
  });
});

describe("hook title", () => {
  const words = [
    { word: "Stop", start: 0.1, end: 0.4 },
    { word: "buying", start: 0.45, end: 0.8 },
    { word: "lawn", start: 0.85, end: 1.1 },
    { word: "mowers.", start: 1.1, end: 1.5 },
    { word: "Seriously,", start: 2.2, end: 2.7 },
    { word: "the", start: 2.75, end: 2.85 },
    { word: "$300", start: 2.9, end: 3.4 },
    { word: "one", start: 3.45, end: 3.7 },
    { word: "wins.", start: 3.7, end: 4.1 },
    { word: "Number", start: 4.5, end: 4.8 },
  ];

  test("chunks of <= 3 words, broken at sentence ends; keywords highlighted", () => {
    const p = hookTitleProps(words, 0, 8, 4.2)!;
    assert.deepEqual(p.chunks.map((c) => c.words.map((w) => w.w).join(" ")), ["Stop buying lawn", "mowers", "Seriously", "the $300 one", "wins"]);
    assert.ok(p.chunks[0].words[0].hi, "Stop");
    assert.ok(p.chunks[3].words.find((w) => w.w === "$300")!.hi, "$300");
    assert.ok(!words.slice(9).some((w) => hookText(p).includes(w.word)), "words after the hook are not shown");
  });

  test("chunks never overlap and stay inside the card", () => {
    const p = hookTitleProps(words, 0, 8, 4.2)!;
    for (let i = 1; i < p.chunks.length; i++) assert.ok(p.chunks[i].from >= p.chunks[i - 1].to - 0.06, "no overlap");
    assert.ok(p.chunks[p.chunks.length - 1].to <= 4.6 + 1e-6);
  });

  test("times are relative to the scene the card sits on", () => {
    const p = hookTitleProps(words, 2, 8, 4.2)!;
    assert.equal(p.chunks[0].words[0].w, "Seriously");
    assert.ok(Math.abs(p.chunks[0].words[0].at - 0.2) < 1e-6);
  });

  test("no words in the hook -> no card", () => {
    assert.equal(hookTitleProps(words, 5, 9, 4.2), null);
  });

  test("a hook title may run past the usual 6 s card limit", () => {
    assert.equal(cardFrames({ delay: 0, card: { comp: "HookTitle", props: {}, seconds: 11 } }, 12), 330);
    assert.equal(cardFrames({ delay: 0, card: { comp: "LowerThird", props: {}, seconds: 11 } }, 12), 180);
  });
});
