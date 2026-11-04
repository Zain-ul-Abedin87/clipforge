import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-localize-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.GPU_TIME_FILE = path.join(tmp, "gpu_time.json");

const { paths } = await import("../src/lib/paths.js");
const T = await import("../src/lib/localize/translate.js");
const V = await import("../src/lib/localize/versions.js");
const { LANGUAGES } = await import("../src/lib/localize/languages.js");
const { norm } = await import("../src/lib/text.js");
const { scriptHeadings } = await import("../src/lib/planner/structure.js");
const { resolveTtsConfigFor, TtsConfigError } = await import("../src/lib/tts.js");
const W = await import("../src/lib/orchestrator/wizard.js");
const P = await import("../src/lib/orchestrator/pipeline.js");
const { friendlyHint } = await import("../src/lib/orchestrator/friendly.js");
const { wizardRoute } = await import("../src/server/routes/wizard.js");

const made: string[] = [];
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const p of made) fs.rmSync(path.join(paths.workspace, p), { recursive: true, force: true });
});

const de = LANGUAGES.de;
const en = LANGUAGES.en;
/** A fake "model": translates by a word table and keeps every marker. */
const fakeGerman: import("../src/lib/localize/translate.js").Ask = async (_sys, user) => {
  const para = user.split("Translate this paragraph:")[1].split("\n").slice(1).join(" ").trim();
  return para.replace(/\bThe\b/g, "Die").replace(/\bis\b/g, "ist").replace(/\bweighs\b/g, "wiegt").replace(/\bNumber\b/g, "Platz").replace(/\bcosts\b/g, "kostet");
};

describe("translation keeps the facts", () => {
  test("product names and every token with a digit become markers, and come back unchanged", () => {
    const p = T.protect("The Glock 19 Gen 5 costs $549 and the Glock 19 weighs 1.2 lbs. Number 3 is the P365.", ["Glock 19", "Glock 19 Gen 5"]);
    assert.ok(!/Glock|549|365|1\.2/.test(p.text), p.text);
    assert.deepEqual(p.terms, ["Glock 19 Gen 5", "Glock 19", "$549", "1.2", "3", "P365"]);
    const back = T.restore(p.text, p.text, p.terms);
    assert.equal(back, "The Glock 19 Gen 5 costs $549 and the Glock 19 weighs 1.2 lbs. Number 3 is the P365.");
  });

  test("a dropped or invented marker is refused (never a guessed number)", () => {
    const p = T.protect("It holds 15 rounds and costs $499.", []);
    assert.equal(T.restore(p.text.replace("⟦2⟧", "499 Dollar"), p.text, p.terms), null);
    assert.equal(T.restore(`${p.text} ⟦9⟧`, p.text, p.terms), null);
  });

  test("decimal comma only where the language writes one; the value never changes", () => {
    assert.equal(T.localNumber("4.5", de), "4,5");
    assert.equal(T.localNumber("$1,299.99", de), "$1299,99");
    assert.equal(T.localNumber("4.5mm", de), "4,5mm");
    assert.equal(T.localNumber("P365", de), "P365");
    assert.equal(T.localNumber("2024", de), "2024");
    assert.equal(T.localNumber("4.5", en), "4.5");
    assert.equal(T.localNumber("4.5", de, false), "4.5");
  });

  test("US prices and units are flagged, as are paragraphs far shorter / longer than the original", () => {
    const n = T.reviewNotes("It costs $499 and weighs 2 pounds with a 4 inch barrel.", "Sie kostet $499 und wiegt 2 Pfund mit einem 4 Zoll Lauf.", de);
    assert.equal(n.length, 2);
    assert.match(n[0], /US price/);
    assert.match(n[1], /US unit/);
    assert.match(T.reviewNotes("one two three four five six seven eight nine ten", "eins zwei", de)[0], /shorter/);
    assert.deepEqual(T.reviewNotes("A plain sentence here.", "Ein einfacher Satz hier.", de), []);
  });

  test("a paragraph is translated with the markers put back (decimal comma in German)", async () => {
    const r = await T.translateParagraph("The Glock 19 weighs 1.5 pounds.", { from: en, to: de, names: ["Glock 19"], ask: fakeGerman });
    assert.equal(r.translated, true);
    assert.equal(r.text, "Die Glock 19 wiegt 1,5 pounds.");
    assert.match(r.issues[0], /US unit/);
  });

  test("a model that keeps breaking the markers: the original stays, flagged, after one retry", async () => {
    let calls = 0;
    const bad: import("../src/lib/localize/translate.js").Ask = async () => (calls++, "Die Glock wiegt 700 Gramm.");
    const r = await T.translateParagraph("The Glock 19 weighs 1.5 pounds.", { from: en, to: de, names: ["Glock 19"], ask: bad });
    assert.equal(calls, 2);
    assert.equal(r.translated, false);
    assert.equal(r.text, "The Glock 19 weighs 1.5 pounds.");
    assert.match(r.issues[0], /Not translated/);
  });

  test("the whole script: paragraph by paragraph, the previous translation sent as context", async () => {
    const seen: string[] = [];
    const ask: import("../src/lib/localize/translate.js").Ask = async (s, u) => (seen.push(u), fakeGerman(s, u));
    const r = await T.translateScript("Number 3 is the P365.\n\nThe P365 is small.", { from: en, to: de, names: ["P365"], ask });
    assert.equal(r.text, "Platz 3 ist the P365.\n\nDie P365 ist small.");
    assert.equal(r.paragraphs.length, 2);
    assert.match(seen[1], /Previous paragraph[\s\S]*Platz 3 ist/);
  });

  test("long paragraphs are cut at sentence ends", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} has six words.`).join(" ");
    const parts = T.paragraphsOf(long, 100);
    assert.ok(parts.length >= 4);
    assert.ok(parts.every((p) => p.split(/\s+/).length <= 100));
    assert.equal(parts.join(" "), long);
  });
});

describe("other languages in the rest of the pipeline", () => {
  test("norm keeps letters of any language; ASCII keys are unchanged", () => {
    assert.equal(norm("für"), "fur");
    assert.equal(norm("Größer,"), "grosser");
    assert.equal(norm("Número"), "numero");
    assert.equal(norm("M&P"), "mandp");
    assert.equal(norm("Glock™"), "glock");
    assert.equal(norm("five"), "5");
    assert.equal(norm("½"), "");
  });

  test("ranked headings in German / Spanish scripts are found (and English still is)", () => {
    assert.deepEqual(scriptHeadings("Platz 3: Glock 19\ntext\nPlatz 2: Sig P365\nPlatz 1: CZ P-10 C").map((h) => h.rank), [3, 2, 1]);
    assert.deepEqual(scriptHeadings("Número 3 - Glock 19\nNúmero 2 - Sig P365\nNúmero 1 - CZ P-10 C").map((h) => h.rank), [3, 2, 1]);
    assert.deepEqual(scriptHeadings("Number 3: Glock 19\nNo. 2: Sig P365\n#1 CZ P-10 C").map((h) => h.rank), [3, 2, 1]);
  });

  test("the voice: an English voice never reads a German script", () => {
    const piper = path.join(tmp, "piper");
    const enVoice = path.join(tmp, "en_US-voice.onnx");
    const deVoice = path.join(tmp, "de_DE-thorsten-high.onnx");
    for (const f of [piper, enVoice, deVoice]) fs.writeFileSync(f, "x");
    const env = (vars: Record<string, string>) => (n: string, f?: string) => vars[n] ?? f ?? "";
    // English Piper set up, nothing for German: refused with the setting to add.
    assert.throws(() => resolveTtsConfigFor("de", env({ PIPER_PATH: piper, PIPER_MODEL: enVoice })), (e: Error) => e instanceof TtsConfigError && /PIPER_MODEL_DE/.test(e.message) && /Kokoro has no German/.test(e.message));
    const c = resolveTtsConfigFor("de", env({ PIPER_PATH: piper, PIPER_MODEL: enVoice, PIPER_MODEL_DE: deVoice }));
    assert.equal(c.provider, "piper");
    assert.equal((c as { model: string }).model, deVoice);
    assert.throws(() => resolveTtsConfigFor("de", env({ TTS_PROVIDER_DE: "kokoro" })), /Kokoro has no German voice/);
    assert.throws(() => resolveTtsConfigFor("es", env({ TTS_PROVIDER_ES: "kokoro", KOKORO_VOICE: "am_michael" })), /KOKORO_VOICE_ES/);
    // English: the normal settings, untouched.
    assert.equal((resolveTtsConfigFor("en", env({ TTS_PROVIDER: "piper", PIPER_PATH: piper, PIPER_MODEL: enVoice })) as { model: string }).model, enVoice);
  });

  test("a missing language voice gets a plain-English fix", () => {
    const h = friendlyHint(["[tts] CONFIGURATION ERROR: No German voice is set up. Add PIPER_MODEL_DE=<a German Piper .onnx voice> (Kokoro has no German) to .env, or set TTS_PROVIDER_DE."], "tts exited with code 2")!;
    assert.match(h.title, /German/);
    assert.match(h.fix, /PIPER_MODEL_DE/);
    assert.equal(h.where, "/tools");
  });
});

describe("language version of a video", () => {
  const script = "Number 3 is the P365. The P365 is small and costs $499.\n\nNumber 2 is the Glock 19. The Glock 19 weighs 1.5 pounds.";

  test("a new project next to the original; the original only gets a link", async () => {
    const src = W.createVideo({ topic: "zz localize test pistols", products: ["P365", "Glock 19", "CZ P-10 C"], scriptMode: "own", script: script + " " + "More words here to pass the minimum length check of twenty words.".repeat(1) }).project;
    made.push(src);
    const before = fs.readFileSync(path.join(paths.workspace, src, "script.txt"), "utf8");
    const r = V.createLanguageVersion(src, "de");
    made.push(r.project);
    assert.equal(r.project, `${src}-de`);
    assert.equal(r.needsTranslation, true);
    assert.equal(fs.readFileSync(path.join(paths.workspace, src, "script.txt"), "utf8"), before);
    assert.deepEqual(V.versionInfo(src).versions, { de: r.project });
    assert.equal(V.versionInfo(r.project).sourceProject, src);
    assert.equal(V.languageOf(r.project), "de");
    assert.deepEqual(P.readConfig(r.project)!.products, ["P365", "Glock 19", "CZ P-10 C"]);
    // Its Writing stage translates; it has no research of its own.
    assert.deepEqual(P.stageSteps("writing", r.project, P.readConfig(r.project)), [["translate", "-p", r.project]]);
    assert.deepEqual(P.stageSteps("research", r.project, P.readConfig(r.project)), []);

    assert.equal(await V.translateProject(r.project, { ask: fakeGerman, log: () => {} }), 2); // 2 = done, with things to check
    const text = fs.readFileSync(path.join(paths.workspace, r.project, "script.txt"), "utf8");
    assert.match(text, /^Platz 3 ist the P365\./);
    assert.match(text, /\$499/);
    assert.match(text, /1,5 pounds/);
    const v = W.scriptView(r.project);
    assert.ok(v.translation);
    assert.equal(v.translation!.to, "de");
    assert.equal(v.translation!.stale, false);
    assert.equal(v.unsourced.length, 0);
    assert.ok(v.translation!.checks.some((c) => c.issues.some((i) => /US price/.test(i))));
    assert.equal(W.readApprovals(r.project).script, undefined);

    // Same script again: kept. Original edited: the translation is stale, then refreshed.
    assert.equal(V.createLanguageVersion(src, "de").needsTranslation, false);
    W.saveScript(src, before.trim() + " The CZ is new.", false);
    assert.equal(W.scriptView(r.project).translation!.stale, true);
    assert.equal(await V.translateProject(r.project, { ask: fakeGerman, log: () => {} }), 2);
    assert.match(fs.readFileSync(path.join(paths.workspace, r.project, "script.txt"), "utf8"), /CZ ist new/);
    assert.equal(W.scriptView(r.project).translation!.stale, false);
  });

  test("refused: same language, unknown language, no script, not a version", async () => {
    const src = W.createVideo({ topic: "zz localize test refused", products: ["A", "B"] }).project;
    made.push(src);
    assert.throws(() => V.createLanguageVersion(src, "de"), /script first/);
    assert.throws(() => V.createLanguageVersion(src, "xx"), /Unknown language/);
    fs.writeFileSync(path.join(paths.workspace, src, "script.txt"), "word ".repeat(30));
    assert.throws(() => V.createLanguageVersion(src, "en"), /already in English/);
    assert.equal(await V.translateProject(src, { ask: fakeGerman, log: () => {} }), 1);
  });

  test("wizard API: languages offered, version made, its link on the original", async () => {
    const src = W.createVideo({ topic: "zz localize test api", products: ["A1", "B2"], scriptMode: "own", script: "word ".repeat(30) }).project;
    made.push(src, `${src}-es`);
    const info = (await wizardRoute(["api", "wizard", src], "GET", async () => ""))!.body as { languages: { code: string }[]; language: string; versions: Record<string, string> };
    assert.equal(info.language, "en");
    assert.ok(info.languages.some((l) => l.code === "de"));
    const r = await wizardRoute(["api", "wizard", src, "translate"], "POST", async () => JSON.stringify({ language: "es" }));
    assert.equal(r!.status, 200);
    assert.equal((r!.body as { project: string }).project, `${src}-es`);
    const bad = await wizardRoute(["api", "wizard", src, "translate"], "POST", async () => JSON.stringify({ language: "klingon" }));
    assert.equal(bad!.status, 400);
    const again = (await wizardRoute(["api", "wizard", src], "GET", async () => ""))!.body as { versions: Record<string, string> };
    assert.deepEqual(again.versions, { es: `${src}-es` });
  });
});
