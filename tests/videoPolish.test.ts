import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mentionTimes, recapCards } from "../src/lib/render/recap.js";
import { buildChapters } from "../src/lib/chapters.js";
import type { Scene } from "../src/lib/scenes.js";

const words = (s: string, from: number) => s.split(" ").map((w, i) => ({ word: w, start: from + i * 0.5 }));

describe("outro recap grid", () => {
  const items = [{ name: "Olight O'Pen Pro", rank: 3 }, { name: "Pelican R40 Ruck Case", rank: 2 }, { name: "Peltor ComTac VIII", rank: 1 }];

  test("a product lights up when a distinctive word of its name, or 'number N', is spoken in the outro", () => {
    const w = [...words("so to recap the R40 is great", 100), ...words("and number one is the ComTac headset", 104), ...words("the Olight is fine too", 108)];
    const m = mentionTimes(items, w, 100, 120);
    assert.equal(m.get(1), 102); // "R40"
    assert.equal(m.get(2), 104.5); // "number one"
    assert.equal(m.get(0), 108.5); // "olight" (a generic word like "pen" never counts)
  });

  test("one card per outro scene, countdown order, times relative to each scene, end card at the end", () => {
    const w = words("recap the R40 then the ComTac", 100);
    const cards = recapCards(items, w, [{ start: 100, end: 106 }, { start: 106, end: 112 }]);
    assert.equal(cards.length, 2);
    assert.deepEqual(cards[0].items.map((x) => x.rank), [3, 2, 1]);
    assert.deepEqual(cards[0].highlights, [{ i: 1, at: 1 }, { i: 2, at: 2.5 }]);
    assert.deepEqual(cards[1].highlights, [{ i: 1, at: -5 }, { i: 2, at: -3.5 }], "already lit when the next scene starts");
    assert.equal(cards[0].endAt, null);
    assert.equal(cards[1].endAt, 2, "end card in the last 4 s");
    assert.deepEqual([cards[0].enter, cards[0].exit, cards[1].enter, cards[1].exit], [true, false, false, true]);
  });

  test("no grid for fewer than two products", () => {
    assert.deepEqual(recapCards([{ name: "A", rank: 1 }], [], [{ start: 0, end: 5 }]), []);
  });
});

describe("chapters stop at the outro", () => {
  const sc = (id: number, start: number, end: number, product?: string): Scene => ({ id, start, end, text: "x", type: product ? "product" : "stock", queries: ["q"], ...(product ? { product_name: product } : {}) }) as Scene;
  const scenes = [sc(0, 0, 10), sc(1, 10, 40, "Alpha One"), sc(2, 40, 70, "Beta Two"), sc(3, 70, 90, "Beta Two")];

  test("the last product's chapter ends where the outro starts; an Outro chapter follows", () => {
    const ch = buildChapters(scenes, null, 70);
    assert.deepEqual(ch.map((c) => [c.title, c.start, c.end]), [["Intro", 0, 10], ["Alpha One", 10, 40], ["Beta Two", 40, 70], ["Outro", 70, 90]]);
  });

  test("without an outro the last chapter runs to the end (as before)", () => {
    assert.equal(buildChapters(scenes, null).at(-1)!.end, 90);
  });
});
