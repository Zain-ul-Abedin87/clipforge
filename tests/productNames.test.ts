import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cleanProductName, coreModel, hasModelToken, mergeProductNames } from "../src/lib/productNames.js";
import { filterHits, type SearchHit } from "../src/lib/agents/youtube/ytExtractor.js";
import { planFetches } from "../src/lib/agents/autoFetch.js";
import { recordFromName } from "../src/lib/productResearch.js";

describe("product names from the planner", () => {
  test("an LLM \"null\" / \"none\" / empty is no product", () => {
    for (const n of ["null", " NULL ", "None", "n/a", "unknown", "", "  ", "--", undefined, null]) assert.equal(cleanProductName(n), null, String(n));
    assert.equal(cleanProductName("  Gerber  Downrange Tomahawk "), "Gerber Downrange Tomahawk");
  });

  test("a bare fragment joins the one full name it is part of", () => {
    const m = mergeProductNames(["Bounce Imaging Explorer throwable 360 camera", "Explorer", "Impactyt 3", "Mechanics Wear Impactyt 3"]);
    assert.equal(m.get("Explorer"), "Bounce Imaging Explorer throwable 360 camera");
    assert.equal(m.get("Impactyt 3"), "Mechanics Wear Impactyt 3");
    assert.equal(m.has("Mechanics Wear Impactyt 3"), false);
  });

  test("an ambiguous fragment is kept as it is", () => {
    assert.equal(mergeProductNames(["Pro", "Caldwell Emax Pro", "O-Lite O-Pin Pro"]).has("Pro"), false);
  });

  test("core model: the letter+digit code, else the first two of a long model", () => {
    assert.equal(coreModel("R40 Personal Utility Ruck Case"), "R40");
    assert.equal(coreModel("Imaging Explorer throwable 360 camera"), "Imaging Explorer");
    assert.equal(coreModel("Comtac 8"), "Comtac 8");
    assert.equal(hasModelToken(""), false);
  });
});

describe("one bad product does not break the others", () => {
  const hit = (title: string): SearchHit => ({ id: title, url: `https://www.youtube.com/watch?v=${title.length}`, title, duration: 300, channel: "x" });

  test("an empty other model is ignored instead of throwing", () => {
    const { kept } = filterHits([hit("Peltor Comtac 8 review")], "3M", "Comtac 8", ["", "R40"]);
    assert.equal(kept.length, 1);
  });

  test("the \"null\" product is not fetched", () => {
    const state = { clips: () => 0, hasSpec: () => false };
    const needs = planFetches([recordFromName("null"), recordFromName("Explorer"), recordFromName("Pelican R40")], {}, state);
    assert.deepEqual(needs.map((n) => n.product), ["Pelican R40"]);
  });
});
