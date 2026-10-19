import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Niche } from "../src/lib/niche.js";
import type { Scene, Section } from "../src/lib/scenes.js";
import type { PacingConfig, SubShot } from "../src/lib/pacing.js";
import type { PoolShot } from "../src/lib/assets/productPool.js";

// Fake Qwen as the only LLM: never the user's settings, never the network.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-plancache-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
process.env.QWEN_API_KEY = "test-qwen";
delete process.env.ANTHROPIC_API_KEY;
const { setQwenFetch } = await import("../src/lib/agents/llm/llm.js");
const S = await import("../src/lib/agents/llm/settings.js");
const { LlmCache } = await import("../src/lib/llmCache.js");
const { llmLabels } = await import("../src/lib/planner/label.js");
const { routeSegments } = await import("../src/lib/planner/segmentRoute.js");
const { findBounds } = await import("../src/lib/planner/introOutro.js");
const { planSubjects } = await import("../src/lib/agent/editor.js");
const { applyPacing, pacingConfig } = await import("../src/lib/pacing.js");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Fake model: answers every id it is shown; `call` makes each answer recognisable per request. */
let call = 0;
const seen: string[] = [];
function fakeModel(answer: (user: unknown, call: number) => unknown) {
  setQwenFetch((async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: { role: string; content: string }[] };
    const user = body.messages.filter((m) => m.role === "user").at(-1)!.content;
    seen.push(user);
    call++;
    let parsed: unknown = user;
    try {
      parsed = JSON.parse(user);
    } catch {
      /* plain-text prompt */
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer(parsed, call)) }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } }), { status: 200 });
  }) as unknown as typeof fetch);
}
beforeEach(() => {
  S.saveLlmSettings({ primary: "qwen", fallback: "none" });
  seen.length = 0;
});

const niche = { name: "t", label: "Test", llmGuidance: "", stock: { fallbackQuery: "lawn", blockedTerms: [], hints: [] }, structure: { titleCardPerItem: false, maxPriceBadgesPerItem: 1, maxProsConsPerItem: 1 } } as unknown as Niche;

describe("LlmCache", () => {
  test("keys are stable, survive a reload, oldest entries go first", () => {
    const f = path.join(tmp, "c.json");
    const c = new LlmCache<number>(f, 2);
    assert.equal(LlmCache.key({ b: 1, a: 2 }), LlmCache.key({ a: 2, b: 1 }));
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3);
    c.save();
    const d = new LlmCache<number>(f, 2);
    assert.equal(d.get("a"), undefined, "evicted");
    assert.equal(d.get("c"), 3);
  });
});

describe("plan labels: only edited sections go to the LLM", () => {
  const sections: Section[] = [{ id: 0, kind: "intro", start: 0, end: 10 }, { id: 1, kind: "item", start: 10, end: 30, rank: 1, product_name: "Honda" }];
  const spansOf = (t1: string) => [
    { start: 0, end: 5, section: 0, text: "Five mowers tested." },
    { start: 5, end: 10, section: 0, text: "Here is the winner." },
    { start: 10, end: 20, section: 1, text: t1 },
    { start: 20, end: 30, section: 1, text: "It mulches well." },
  ];
  fakeModel((u, n) => ({ scenes: (u as { id: number }[]).map((x) => ({ id: x.id, type: "stock", product_name: null, queries: [`q${n}-${x.id}`], graphic_kind: "none", graphic_title: "", graphic_lines: [], price: null })) }));

  test("first run labels all; an edit in section 1 re-asks section 1 only, section 0 keeps its labels", async () => {
    const cache = new LlmCache<never>(path.join(tmp, "labels.json")) as never;
    const r1 = (await llmLabels(spansOf("Number 1 is the Honda."), sections, () => {}, niche, cache))!;
    assert.equal(seen.length, 1);
    const r2 = (await llmLabels(spansOf("Number 1 is the Honda HRX."), sections, () => {}, niche, cache))!;
    assert.equal(seen.length, 2);
    assert.deepEqual((JSON.parse(seen[1]) as { id: number }[]).map((x) => x.id), [2, 3], "only the edited section was sent");
    assert.equal(r2.cachedSections, 1);
    assert.deepEqual(r2.scenes.slice(0, 2).map((s) => s.queries), r1.scenes.slice(0, 2).map((s) => s.queries));
    assert.notDeepEqual(r2.scenes[2].queries, r1.scenes[2].queries);
    await llmLabels(spansOf("Number 1 is the Honda HRX."), sections, () => {}, niche, cache);
    assert.equal(seen.length, 2, "nothing changed -> no request");
  });
});

describe("segment routing: per line", () => {
  test("an edited line is re-routed; others and the cinematic list are kept", async () => {
    fakeModel((u, n) => {
      const ids = [...String(u).matchAll(/^(\d+)/gm)].map((m) => Number(m[1]));
      return { cinematic: [`cine${n}`], scenes: ids.map((id) => ({ id, segment: "generic_hook", reason: `r${n}` })) };
    });
    const sc = (t: string) => [0, 1].map((id) => ({ id, start: id * 5, end: id * 5 + 5, text: id ? t : "Intro line.", type: "stock", queries: ["x"], section: 0, labeledBy: "llm" })) as unknown as Scene[];
    const cache = new LlmCache<never>(path.join(tmp, "route.json")) as never;
    const a = await routeSegments(sc("Old line."), niche, "mowers", true, () => {}, cache);
    const b = await routeSegments(sc("New line."), niche, "mowers", true, () => {}, cache);
    assert.equal(seen.length, 2);
    assert.match(seen[1], /1: New line\./);
    assert.doesNotMatch(seen[1], /Intro line/);
    assert.equal(b[0].segmentReason, a[0].segmentReason);
    assert.deepEqual(b[0].cinematicQueries, a[0].cinematicQueries);
  });
});

describe("intro/outro bounds: cached by the opening and closing lines", () => {
  test("an edit in the middle reuses the answer, mapped to the new sentence numbers", async () => {
    let asked = 0;
    const ask = async () => (asked++, { hook_end_sentence: 1, intro_end_sentence: null, outro_start_sentence: 58 });
    // 2 hook + 50 body + 6 tail + 2 outro; edits go between body 19 and 20 (outside the first 10 / last 25).
    const body = Array.from({ length: 50 }, (_, i) => `Body ${i}.`);
    const sent = (mid: string[]) => [...["Stop.", "This mower wins."], ...body.slice(0, 20), ...mid, ...body.slice(20), ...Array.from({ length: 6 }, (_, i) => `Tail ${i}.`), "So which one would you pick?", "Bye."].map((text, i) => ({ text, start: i * 5, end: i * 5 + 5 }));
    const cache = new LlmCache<never>(path.join(tmp, "bounds.json")) as never;
    const s1 = sent([]);
    const b1 = await findBounds(s1, s1.length * 5, { useLlm: true, ask, cache });
    const s2 = sent(["An added sentence.", "And another."]);
    const b2 = await findBounds(s2, s2.length * 5, { useLlm: true, ask, cache });
    assert.equal(asked, 1);
    assert.equal(b1.outroStart, 58 * 5);
    assert.equal(b2.outroStart, 60 * 5, "outro follows its sentence, not its old number");
  });
});

describe("subjects: per section", () => {
  test("only the edited section is sent; the other keeps its subjects", async () => {
    fakeModel((u, n) => ({ scenes: (u as { scenes: { id: number }[] }).scenes.map((s) => ({ id: s.id, subject: "Honda", shot: n === 1 ? "hero" : "detail" })) }));
    const file = path.join(tmp, "subjects.json");
    const scenes = (t: string) => [
      { id: 0, text: "The Honda is great.", section: 0 },
      { id: 1, text: t, section: 1 },
    ];
    const a = await planSubjects(scenes("It mulches."), ["Honda"], "mowers", file, () => {});
    const b = await planSubjects(scenes("It mulches well."), ["Honda"], "mowers", file, () => {});
    assert.equal(seen.length, 2);
    assert.deepEqual((JSON.parse(seen[1]) as { scenes: { id: number }[] }).scenes.map((s) => s.id), [1]);
    assert.deepEqual(b.get(0), a.get(0));
  });
});

describe("shot locks: an edited scene does not reshuffle the rest", () => {
  const shot = (product: string, i: number, imgSim: number): PoolShot => ({ id: `${product}${i}`, product, path: `/pool/${product}_${i}.mp4`, url: `https://v/${product}${i}`, license: "x", duration: 12, imgSim, textSim: 0.2, sceneSim: {}, frames: [], verified: true });
  const pool = [0, 1, 2, 3].map((i) => shot("Honda", i, 0.9 - i * 0.1));
  const build = (firstText: string, firstEnd: number) => {
    const scenes = [
      { id: 0, type: "product", text: firstText, start: 0, end: firstEnd, section: 0, product_name: "Honda", queries: ["Honda"] },
      { id: 1, type: "product", text: "It mulches well.", start: firstEnd, end: firstEnd + 9, section: 0, product_name: "Honda", queries: ["Honda"] },
      { id: 2, type: "product", text: "The deck is steel.", start: firstEnd + 9, end: firstEnd + 18, section: 0, product_name: "Honda", queries: ["Honda"] },
    ] as unknown as Scene[];
    const tl = scenes.map((s) => ({ id: s.id, startFrame: s.start * 30, endFrame: s.end * 30, transition: "cut", asset: { path: "/stock/x.mp4", kind: "video" as const, source: "pexels", duration: 10, in: 0 } }));
    return { scenes, tl };
  };
  const cfg = (): PacingConfig => pacingConfig({ name: "t" } as unknown as Niche, false);
  const shotsOf = (tl: { asset: { shots?: SubShot[] } }[], i: number) => tl[i].asset.shots!.map((s) => `${s.path}@${s.in}`);

  test("scenes 1-2 keep their shots after scene 0 gets longer and changes", () => {
    const first = build("Number 1 is the Honda.", 6);
    const lockOut = new Map<string, SubShot>();
    applyPacing(first.tl, first.scenes, [], pool, cfg(), () => {}, { lockOut });
    const second = build("Number 1 is the Honda HRX, the mower that surprised everyone.", 9);
    applyPacing(second.tl, second.scenes, [], pool, cfg(), () => {}, { locks: lockOut });
    assert.deepEqual(shotsOf(second.tl, 1), shotsOf(first.tl, 1));
    assert.deepEqual(shotsOf(second.tl, 2), shotsOf(first.tl, 2));
  });

  test("changed searches release the lock", () => {
    const first = build("Number 1 is the Honda.", 6);
    const lockOut = new Map<string, SubShot>();
    applyPacing(first.tl, first.scenes, [], pool, cfg(), () => {}, { lockOut });
    const again = build("Number 1 is the Honda.", 6);
    (again.scenes[1] as { queries: string[] }).queries = ["honda mulching close up"];
    const relocked = new Map<string, SubShot>();
    applyPacing(again.tl, again.scenes, [], pool, cfg(), () => {}, { locks: lockOut, lockOut: relocked });
    const keys1 = [...lockOut.keys()], keys2 = [...relocked.keys()];
    assert.ok(keys2.some((k) => !keys1.includes(k)), "scene 1 has a new lock identity");
  });
});
