import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { allowedEdits, editDistance, fuzzyEqual, fuzzyTitleHasModel, fuzzyTokenMatch, suggestSpelling } from "../src/lib/agents/youtube/fuzzyMatcher.js";
import { filterHits, findKeywordMoments } from "../src/lib/agents/youtube/ytExtractor.js";
import { checkManimCode, generateDiagram, manimAvailable, templateGraph } from "../src/lib/agents/generative/manimAgent.js";
import { diagramPoolShots, ensureFootage, planFetches, readDiagrams } from "../src/lib/agents/autoFetch.js";
import { SPEC_LEXICON } from "../src/lib/planner/activeSubject.js";
import { recordFromName } from "../src/lib/productResearch.js";
import { ffmpegPath, ffprobePath } from "../src/lib/tools.js";
import { norm } from "../src/lib/text.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-agents-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ff = ffmpegPath();
const spec = (name: string) => SPEC_LEXICON.find((s) => s.spec === name)!;

describe("fuzzy names: letters forgiven, digits never", () => {
  test("edit distance with transpositions", () => {
    assert.equal(editDistance("tiger", "tigre"), 1);
    assert.equal(editDistance("brushless", "brushles"), 1);
    assert.equal(editDistance("kitten", "sitting"), 3);
    assert.deepEqual([allowedEdits(4), allowedEdits(5), allowedEdits(8)], [0, 1, 2]);
  });

  test("tokens", () => {
    assert.ok(fuzzyEqual("tigre", "tiger"));
    assert.ok(fuzzyEqual("milwaukee", "milwalkee"));
    assert.ok(!fuzzyEqual("lm2135sp", "lm2153sp"), "digits differ: another model");
    assert.ok(!fuzzyEqual("gen3", "gen5"));
    assert.ok(!fuzzyEqual("deck", "desk"), "short words get no edits");
    assert.ok(!fuzzyEqual("motor", "rotor"), "first letter must agree");
    assert.ok(fuzzyTokenMatch("blades", "blade") && fuzzyTokenMatch("brushles", "brushless"));
  });

  test("titles: typos and spacing in the model, never a different number", () => {
    assert.ok(fuzzyTitleHasModel("Scag Turf Tiger II walkaround", "Turf Tigre II"));
    assert.ok(fuzzyTitleHasModel("EGO LM 2135SP review", "LM2135SP"));
    assert.ok(fuzzyTitleHasModel("Scag TurfTiger II demo", "Turf Tiger II"));
    assert.ok(!fuzzyTitleHasModel("EGO LM2153SP review", "LM2135SP"));
    assert.ok(!fuzzyTitleHasModel("Ryobi RY401140 review", "RY401150"));
    assert.ok(!fuzzyTitleHasModel("Scag Turf Tiger III", "Turf Tiger II"), "ii vs iii: 2 letters, no edit budget");
    // Real titles from the live search: same mower written with an Arabic numeral or "ll".
    assert.ok(fuzzyTitleHasModel("NEW SCAG turf Tiger 2.", "Turf Tiger II"));
    assert.ok(fuzzyTitleHasModel("Scag Turf Tiger ll Big Property", "Turf Tiger II"));
    assert.ok(!fuzzyTitleHasModel("Scag Turf Tiger 3 review", "Turf Tiger II"));
    assert.ok(!fuzzyTitleHasModel("Scag Turf Tiger Spring 2013 walkaround", "Turf Tiger II"), "no generation named: not accepted");
  });

  test("the spelling titles agree on replaces a typo (digits kept)", () => {
    const titles = ["Scag Turf Tiger II walkaround", "SCAG Turf Tiger II review", "Turf Tiger II zero turn"];
    assert.equal(suggestSpelling("Turf Tigre II", titles), "Turf Tiger II");
    assert.equal(suggestSpelling("Turf Tiger II", titles), null);
    assert.equal(suggestSpelling("Milwalkee", ["Milwaukee M18 mower", "Milwaukee mower review"]), "Milwaukee");
    assert.equal(suggestSpelling("LM2153SP", ["EGO LM2135SP", "EGO LM2135SP review"]), null, "never 'corrects' digits");
  });

  test("search filter: fuzzy only when asked; caption keywords tolerate ASR typos", () => {
    const hits = [{ id: "a", url: "https://www.youtube.com/watch?v=a", title: "Scag Turf Tiger II walkaround", duration: 300, channel: "c" }];
    assert.equal(filterHits(hits, "Scag", "Turf Tigre II", [], false, false).kept.length, 0);
    assert.equal(filterHits(hits, "Scag", "Turf Tigre II", [], false, true).kept.length, 1);
    const words = [{ text: "the", t: 1 }, { text: "brushles", t: 1.3 }, { text: "motor", t: 1.7 }];
    assert.equal(findKeywordMoments(words, "brushless motor").length, 0);
    assert.equal(findKeywordMoments(words, "brushless motor", { matcher: fuzzyTokenMatch }).length, 1);
  });
});

describe("auto-fetch planning and orchestration", () => {
  const products = [recordFromName("EGO LM2135SP"), recordFromName("Ryobi RY401150")];
  const specs = { "EGO LM2135SP": [spec("brushless motor"), spec("battery chemistry")], "Ryobi RY401150": [spec("deck")] };

  test("missing / thin vaults first, then each spec without a clip", () => {
    const state = { clips: (p: string) => (p.startsWith("EGO") ? 12 : 2), hasSpec: (p: string, s: string) => s === "brushless motor" };
    const needs = planFetches(products, specs, state, 6);
    assert.deepEqual(needs.map((n) => `${n.kind}:${n.product}${n.spec ? `/${n.spec.spec}` : ""}`), ["model:Ryobi RY401150", "spec:EGO LM2135SP/battery chemistry", "spec:Ryobi RY401150/deck"]);
    assert.match(needs[0].why, /only 2 clip/);
  });

  test("fetches, then a diagram only for an internal spec that is still missing", async () => {
    const dir = fs.mkdtempSync(path.join(tmp, "af-"));
    const have = new Set<string>(["EGO LM2135SP/brushless motor"]);
    const clips = new Map([["EGO LM2135SP", 12], ["Ryobi RY401150", 0]]);
    const calls: string[] = [];
    const logs: string[] = [];
    const report = await ensureFootage(
      dir,
      { products, specsByProduct: specs, narrationFor: () => "it uses lithium-ion cells", category: "lawn mower", log: (m) => logs.push(m) },
      {
        state: { clips: (p) => clips.get(p) ?? 0, hasSpec: (p, s) => have.has(`${p}/${s}`) },
        harvestModel: async (o) => (calls.push(`model ${o.brand} ${o.model}`), clips.set("Ryobi RY401150", 8), { added: 8 }),
        harvestKeyword: async (o) => {
          calls.push(`keyword ${o.model} ${o.keyword}`);
          if (o.keyword === "deck") have.add("Ryobi RY401150/deck"); // real footage found
          return { added: o.keyword === "deck" ? 3 : 0 };
        },
        generateDiagram: async (req) => {
          calls.push(`diagram ${req.product} ${req.spec.spec} :: ${req.narration}`);
          fs.mkdirSync(path.dirname(req.outFile), { recursive: true });
          fs.writeFileSync(req.outFile, "mp4");
          return { file: req.outFile, engine: "template", attempts: 0, notes: [] };
        },
      },
    );
    assert.deepEqual(calls, [
      "model Ryobi RY401150",
      "keyword LM2135SP battery chemistry",
      "keyword RY401150 deck",
      "diagram EGO LM2135SP battery chemistry :: it uses lithium-ion cells",
    ]);
    assert.equal(report.diagrams.length, 1);
    assert.ok(logs[0].startsWith("[auto-fetch] pausing assets"));
    assert.ok(logs[logs.length - 1].startsWith("[auto-fetch] resuming"));
    assert.equal(readDiagrams(dir).length, 1);
    const shots = diagramPoolShots(dir);
    assert.deepEqual([shots[0].product, shots[0].keyword, shots[0].verified], ["EGO LM2135SP", "battery chemistry", true]);
    assert.match(shots[0].license, /Generated by ClipForge/);
  });
});

describe("Manim diagram agent", () => {
  const good = `from manim import *
import math

class SpecScene(Scene):
    def construct(self):
        self.camera.background_color = "#0f172a"
        t = Text("BATTERY CHEMISTRY", font_size=48)
        self.play(Write(t), run_time=1)
        self.wait(0.5)
`;

  test("safety screen allows plain Manim and rejects files, OS, eval, dunders and LaTeX", () => {
    assert.deepEqual(checkManimCode(good), []);
    const bad = (extra: string) => checkManimCode(good + extra);
    assert.match(bad("import os\n").join(), /import of "os"/);
    assert.match(bad("x = open('a.txt')\n").join(), /file \/ dynamic-code builtin/);
    assert.match(bad("eval('1+1')\n").join(), /dynamic-code/);
    assert.match(bad("y = ().__class__\n").join(), /dunder/);
    assert.match(bad("m = MathTex('x^2')\n").join(), /LaTeX/);
    assert.match(checkManimCode("print(1)").join(), /from manim import/);
  });

  test("template diagram: known flows, escaped text", () => {
    const g = templateGraph({ spec: spec("battery chemistry"), product: "EGO LM2135SP", seconds: 5 });
    assert.match(g, /LITHIUM-ION|Lithium-ion cells/);
    assert.match(g, /Battery management/);
    assert.match(g, /enable='gte\(t\\?,/.test(g) ? /enable/ : /enable/);
    assert.ok(!/text='[^']*:[^\\]/.test(g.replace(/fontfile='[^']*'/g, "")), "colons inside text are escaped");
  });

  test("template renders a 1920x1080 clip (FFmpeg)", { skip: ff ? false : "ffmpeg not found" }, async () => {
    const out = path.join(tmp, "tpl.mp4");
    const r = await generateDiagram({ spec: spec("voltage"), product: "Ryobi RY401150", narration: "a 40 volt battery", seconds: 3, outFile: out }, { useManim: false });
    assert.equal(r.engine, "template");
    const p = spawnSync(ffprobePath()!, ["-v", "error", "-show_entries", "stream=width,height:format=duration", "-of", "csv=p=0", out], { encoding: "utf8" });
    assert.match(p.stdout, /1920,1080/);
  });

  test("repair loop: unsafe code, then a crash, then a render (real Manim, scripted coder)", { skip: manimAvailable() ? false : "manim not installed in .venv", timeout: 600_000 }, async () => {
    const seen: (string | undefined)[] = [];
    const scripts = [
      good + "import os\n", // rejected by the safety screen
      good.replace('Text("BATTERY CHEMISTRY", font_size=48)', "Text(undefined_name)"), // NameError at render time
      good,
    ];
    const out = path.join(tmp, "manim.mp4");
    const r = await generateDiagram(
      { spec: spec("battery chemistry"), product: "EGO LM2135SP", narration: "lithium-ion cells", seconds: 2, outFile: out },
      { useManim: true, coder: async (_req, _code, err) => (seen.push(err), scripts[seen.length - 1]) },
    );
    assert.equal(r.engine, "manim", r.notes.join(" | "));
    assert.equal(r.attempts, 3);
    assert.equal(seen[0], undefined);
    assert.match(seen[1]!, /Safety check rejected/);
    assert.match(seen[2]!, /NameError|undefined_name/, "the render error is fed back to the coder");
    assert.ok(fs.statSync(out).size > 1000);
  });
});

test("norm keeps digits (sanity for digit-strict matching)", () => assert.equal(norm("LM-2135SP"), "lm2135sp"));
