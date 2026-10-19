import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { applyPacing, mentionedProduct, pacingConfig, type PacingConfig, type SubShot } from "../src/lib/pacing.js";
import { checkExactRepeats, type GateScene } from "../src/lib/qaGate.js";
import { INTENT_QUERIES, lineIntent, peopleCap } from "../src/lib/planner/lineIntent.js";
import { heuristicLabels } from "../src/lib/planner/label.js";
import { loadNiche } from "../src/lib/niche.js";
import type { PoolShot } from "../src/lib/assets/productPool.js";
import type { Niche } from "../src/lib/niche.js";
import type { Scene, Section } from "../src/lib/scenes.js";

const cfg = (o: Partial<PacingConfig> = {}): PacingConfig => ({ ...pacingConfig({ name: "t" } as unknown as Niche, false), ...o });
const shot = (product: string, i: number, imgSim: number): PoolShot => ({
  id: `${product}${i}`, product, path: `/pool/${product}_${i}.mp4`, url: `https://v/${product}${i}`, license: "x",
  duration: 8, imgSim, textSim: 0.2, sceneSim: {}, frames: [], verified: true,
});
const tlOf = (scenes: Scene[]) => scenes.map((s) => ({ id: s.id, startFrame: s.start * 30, endFrame: s.end * 30, transition: "cut", asset: { path: `/stock/${s.id}.mp4`, kind: "video" as const, source: "pexels", duration: 12, in: 0 } }));
/** Sub-shots with their start time on the video clock. */
const timed = (tl: ReturnType<typeof tlOf>) =>
  tl.flatMap((t) => {
    let at = t.startFrame / 30;
    return (t.asset as { shots?: SubShot[] }).shots!.map((s) => {
      const r = { at, s };
      at += s.frames / 30;
      return r;
    });
  });
const covering = (list: { at: number; s: SubShot }[], t: number) => list.filter((x) => x.at <= t + 1e-6).pop()!.s;
const w = (word: string, start: number) => ({ word, start, end: start + 0.3 });

describe("mentionedProduct", () => {
  const names = ["Honda HRX217", "Toro Recycler 22", "Toro"];
  test("full name, model without the brand, longest name first", () => {
    assert.equal(mentionedProduct("the Honda HRX217 is great", names), "Honda HRX217");
    assert.equal(mentionedProduct("and the HRX217 wins", names), "Honda HRX217");
    assert.equal(mentionedProduct("get the Toro Recycler 22.", names), "Toro Recycler 22");
    assert.equal(mentionedProduct("any Toro will do", names), "Toro");
  });
  test("whole words only", () => {
    assert.equal(mentionedProduct("a toroidal coil", names), undefined);
  });
});

describe("intro preview", () => {
  test("the intro shows the product it names; its chapter may show that best shot once more; QA accepts it", () => {
    const scenes = [
      { id: 0, type: "stock", text: "Five mowers tested. The Honda HRX217 surprised me most.", start: 0, end: 8, section: 0 },
      { id: 1, type: "product", text: "Number 1 is the Honda HRX217.", start: 8, end: 14, section: 1, product_name: "Honda HRX217" },
      { id: 2, type: "product", text: "It mulches well.", start: 14, end: 20, section: 1, product_name: "Honda HRX217" },
    ] as unknown as Scene[];
    const tl = tlOf(scenes);
    const words = [w("Five", 0.1), w("mowers", 0.5), w("tested.", 0.9), w("The", 4), w("Honda", 4.3), w("HRX217", 4.7), w("surprised", 5.2)];
    applyPacing(tl, scenes, words, [shot("Honda HRX217", 0, 0.95), shot("Honda HRX217", 1, 0.6)], cfg({ hookEnd: 2, introEnd: 8 }), () => {});
    const all = timed(tl);
    const intro = covering(all, 4.4);
    assert.equal(intro.product, "Honda HRX217");
    assert.equal(intro.preview, true);
    // The best moment (highest image match, from 0 s) is in the intro and opens the chapter again.
    const best = (x: SubShot) => x.path === "/pool/Honda HRX217_0.mp4" && x.in === 0;
    assert.ok(all.some((x) => x.at < 8 - 1e-6 && x.s.preview && best(x.s)), "best moment previewed in the intro");
    assert.ok(best(covering(all, 8)), "chapter opens on the same best moment");
    // Inside the intro the preview is never repeated.
    const introShots = all.filter((x) => x.at < 8 - 1e-6 && x.s.preview).map((x) => `${x.s.path}@${x.s.in}`);
    assert.equal(new Set(introShots).size, introShots.length);
    const gate = tl.map((t) => ({ id: t.id, start: t.startFrame / 30, asset: t.asset })) as unknown as GateScene[];
    assert.equal(checkExactRepeats(gate).status, "pass");
  });
});

describe("outro follows its lines", () => {
  test("each product named in the outro gets its own footage, not the last chapter's product", () => {
    const scenes = [
      { id: 0, type: "product", text: "Number 2 is the Honda HRX217.", start: 0, end: 10, section: 0, product_name: "Honda HRX217" },
      { id: 1, type: "product", text: "Number 1 is the Toro Recycler.", start: 10, end: 20, section: 1, product_name: "Toro Recycler" },
      { id: 2, type: "stock", text: "For small yards get the Honda HRX217, for big ones the Toro Recycler.", start: 20, end: 30, section: 2 },
    ] as unknown as Scene[];
    const tl = tlOf(scenes);
    const words = [w("For", 20.1), w("small", 20.4), w("yards", 20.7), w("get", 21), w("the", 21.5), w("Honda", 21.8), w("HRX217,", 22.2), w("for", 24), w("big", 24.3), w("ones", 24.6), w("the", 25), w("Toro", 25.4), w("Recycler.", 25.8)];
    const pool = [shot("Honda HRX217", 0, 0.9), shot("Honda HRX217", 1, 0.8), shot("Toro Recycler", 0, 0.9), shot("Toro Recycler", 1, 0.8)];
    applyPacing(tl, scenes, words, pool, cfg({ outroStart: 20 }), () => {});
    const all = timed(tl);
    assert.equal(covering(all, 22).product, "Honda HRX217");
    assert.equal(covering(all, 25.6).product, "Toro Recycler");
  });
});

describe("line intent", () => {
  test("lines are matched to what they do", () => {
    assert.equal(lineIntent("Let me know in the comments which one you'd buy."), "comment");
    assert.equal(lineIntent("And don't forget to subscribe."), "subscribe");
    assert.equal(lineIntent("Thanks for watching, see you next time."), "goodbye");
    assert.equal(lineIntent("What do you think about that?"), "question");
    assert.equal(lineIntent("Honestly, I was shocked."), "surprise");
    assert.equal(lineIntent("The real problem is the battery."), "problem");
    assert.equal(lineIntent("It has a 21 inch steel deck."), undefined);
  });
  test("queries never ask for people talking to the camera; reaction shots are capped", () => {
    for (const qs of Object.values(INTENT_QUERIES)) for (const q of qs) assert.ok(!/talking|speaking|vlog|interview/i.test(q), q);
    assert.equal(peopleCap(40), 6);
    assert.equal(peopleCap(3), 1);
  });
});

describe("outro labels", () => {
  test("the last scene is footage, not a 'See you next time' card", () => {
    const sections: Section[] = [{ id: 0, kind: "item", start: 0, end: 10, rank: 1, product_name: "Honda" }, { id: 1, kind: "outro", start: 10, end: 18 }];
    const spans = [{ start: 0, end: 10, section: 0, text: "Number 1 is the Honda." }, { start: 10, end: 18, section: 1, text: "Thanks for watching." }];
    const scenes = heuristicLabels(spans, sections, loadNiche("listicle"));
    assert.ok(!scenes.some((x) => x.graphic?.kind === "end_card"));
    assert.notEqual(scenes[1].type, "graphic");
  });
});
