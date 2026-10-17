import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { applyPronunciations, loadGlossary, loadPronunciations } from "../src/lib/glossary.js";
import { chunkText, resolveTtsConfig, synthesize, TtsConfigError } from "../src/lib/tts.js";
import { alignTokens, classifyDifference, findDiscrepancies } from "../src/lib/align.js";
import { alignToScript, rewriteScript } from "../src/commands/align.js";
import { resolveInputMode } from "../src/lib/inputMode.js";
import { footageQuery, parseAsin, recordFromName, splitAmazonUrl, verifyModelMatch } from "../src/lib/productResearch.js";
import { buildLedger, classifyLicense, ledgerCategory, reusePenalty, writeLedger, readLedger } from "../src/lib/assets/licenseLedger.js";
import { canonicalJson, changedScenes, concatList, sceneContentHash, SceneHashInput } from "../src/lib/render/sceneHash.js";
import { checkAssetFiles, checkClipReuse, checkDiscrepancies, checkLicenseRecords, checkProductMatches, GateScene } from "../src/lib/qaGate.js";
import { musicEnabled } from "../src/commands/timeline.js";
import * as yx from "../src/lib/agents/youtube/ytExtractor.js";
import { paths } from "../src/lib/paths.js";
import { ffmpegPath } from "../src/lib/tools.js";
import type { Assets } from "../src/lib/assets/types.js";
import type { Scene } from "../src/lib/scenes.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-test-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** Whisper-like timed words from text, 0.4 s per word. */
const heardWords = (text: string) => text.split(/\s+/).filter(Boolean).map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.35, prob: 0.9 }));
const envOf = (vars: Record<string, string>) => (name: string, fallback = "") => vars[name] ?? fallback;

// ---------------------------------------------------------------------------------------------
describe("Phase 1: input modes", () => {
  test("A / B / C from what was supplied", () => {
    assert.equal(resolveInputMode({ hasUploadedAudio: true, hasScript: false }), "A");
    assert.equal(resolveInputMode({ hasUploadedAudio: false, hasScript: true }), "B");
    assert.equal(resolveInputMode({ hasUploadedAudio: true, hasScript: true }), "C");
    assert.equal(resolveInputMode({ hasUploadedAudio: false, hasScript: false }), null);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Phase 2: TTS (Mode B) and glossary pronunciations", () => {
  const glossary = path.join(tmp, "glossary.txt");
  before(() => fs.writeFileSync(glossary, "# names\nSig Sauer P365 = Sig Sauer P three sixty-five\nGlock 19\nM&P = M and P\n"));

  test("glossary spellings ignore the pronunciation part", () => {
    assert.deepEqual(loadGlossary(glossary), ["Sig Sauer P365", "Glock 19", "M&P"]);
    assert.deepEqual(loadPronunciations(glossary), { "Sig Sauer P365": "Sig Sauer P three sixty-five", "M&P": "M and P" });
  });

  test("pronunciations rewrite whole terms only, case-insensitive, longest first", () => {
    const o = { "Sig Sauer P365": "Sig Sauer P three sixty-five", P365: "P-three-six-five", "M&P": "M and P" };
    assert.equal(applyPronunciations("The sig sauer P365 beats the M&P.", o), "The Sig Sauer P three sixty-five beats the M and P.");
    assert.equal(applyPronunciations("P3650 is not a match", o), "P3650 is not a match");
  });

  test("no provider -> the computer's own voice; bad settings -> clear configuration error", () => {
    if (process.platform === "win32") assert.equal(resolveTtsConfig(envOf({})).provider, "windows");
    assert.throws(() => resolveTtsConfig(envOf({ TTS_PROVIDER: "robot" })), TtsConfigError);
    assert.throws(() => resolveTtsConfig(envOf({ TTS_PROVIDER: "elevenlabs" })), /ELEVENLABS_API_KEY/);
    assert.throws(() => resolveTtsConfig(envOf({ TTS_PROVIDER: "elevenlabs", ELEVENLABS_API_KEY: "k" })), /ELEVENLABS_VOICE_ID/);
    assert.throws(() => resolveTtsConfig(envOf({ TTS_PROVIDER: "openai" })), /OPENAI_API_KEY/);
    assert.throws(() => resolveTtsConfig(envOf({ TTS_PROVIDER: "piper" })), /PIPER_PATH/);
    const c = resolveTtsConfig(envOf({ TTS_PROVIDER: "openai", OPENAI_API_KEY: "k" }));
    assert.equal(c.provider, "openai");
  });

  test("chunks stay under the limit and keep every word", () => {
    const text = Array.from({ length: 50 }, (_, i) => `Sentence number ${i} is here.`).join(" ");
    const chunks = chunkText(text, 120);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => c.length <= 120));
    assert.equal(chunks.join(" ").split(/\s+/).length, text.split(/\s+/).length);
  });

  test("synthesize sends the pronounced payload and never touches the script", async () => {
    const scriptFile = path.join(tmp, "script.txt");
    const script = "Today we test the Sig Sauer P365.\n\nIt is small.";
    fs.writeFileSync(scriptFile, script);
    const sent: { url: string; body: Record<string, unknown>; auth: string }[] = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) });
      return new Response(new Uint8Array([82, 73, 70, 70]), { status: 200 });
    }) as unknown as typeof fetch;
    const out = path.join(tmp, "voice.wav");
    const r = await synthesize({ script: fs.readFileSync(scriptFile, "utf8"), outFile: out, glossaryFile: glossary, config: { provider: "openai", apiKey: "test-key", voice: "alloy", model: "gpt-4o-mini-tts" }, fetchImpl: fakeFetch });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://api.openai.com/v1/audio/speech");
    assert.equal(sent[0].auth, "Bearer test-key");
    assert.match(String(sent[0].body.input), /P three sixty-five/);
    assert.doesNotMatch(String(sent[0].body.input), /P365/);
    assert.equal(r.overridesApplied, 1);
    assert.ok(fs.existsSync(out));
    assert.equal(fs.readFileSync(scriptFile, "utf8"), script, "approved script must be unchanged");
  });

  test("a rejected key surfaces as a configuration error", async () => {
    const fakeFetch = (async () => new Response("bad key", { status: 401 })) as unknown as typeof fetch;
    await assert.rejects(
      synthesize({ script: "Hello.", outFile: path.join(tmp, "x.mp3"), config: { provider: "elevenlabs", apiKey: "k", voiceId: "v", model: "m" }, fetchImpl: fakeFetch }),
      TtsConfigError,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("Phase 2: Mode C alignment discrepancies", () => {
  const scriptText = "The Holosun Gen 3 MOS is not cheap. The iPhone 15 Pro costs 999 dollars.";
  const run = (script: string, heard: string) => {
    const tokens = script.split(/\s+/);
    const h = heardWords(heard);
    const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
    return findDiscrepancies(tokens, h, alignTokens(tokens.map(norm), h.map((w) => norm(w.word))));
  };

  test("generation, negation, variant and number differences are significant", () => {
    const d = run(scriptText, "The Holosun Gen 5 MOS is cheap. The iPhone 15 Max costs 899 dollars.");
    const gen = d.find((x) => x.script === "3");
    assert.ok(gen, "Gen 3 vs Gen 5 found");
    assert.equal(gen!.type, "substitution");
    assert.equal(gen!.severity, "significant");
    assert.ok(gen!.reasons.includes("number") && gen!.reasons.includes("model_variant"));
    const neg = d.find((x) => x.script === "not");
    assert.equal(neg?.type, "omission");
    assert.deepEqual(neg?.reasons, ["negation"]);
    const variant = d.find((x) => x.script === "Pro");
    assert.equal(variant?.heard, "Max");
    assert.ok(variant?.reasons.includes("model_variant"));
    const price = d.find((x) => x.script === "999");
    assert.ok(price?.reasons.includes("number"));
  });

  test("ad-libs without numbers / negations / variants are minor additions", () => {
    const d = run("This drill is great.", "This drill is um really great.");
    assert.equal(d.length, 1);
    assert.equal(d[0].type, "addition");
    assert.equal(d[0].severity, "minor");
    assert.equal(d[0].heard, "um really");
  });

  test("fuzzy spelling never hides a different number", () => {
    const pairs = alignTokens(["gen3"], ["gen5"]);
    assert.equal(pairs[0].kind, "sub");
    assert.deepEqual(classifyDifference(["five"], ["5"]), []);
  });

  test("ids are stable across runs", () => {
    const a = run(scriptText, "The Holosun Gen 5 MOS is not cheap. The iPhone 15 Pro costs 999 dollars.");
    const b = run(scriptText, "The Holosun Gen 5 MOS is not cheap. The iPhone 15 Pro costs 999 dollars.");
    assert.deepEqual(a.map((x) => x.id), b.map((x) => x.id));
  });

  test("resolutions: keep_audio shows the spoken words, correct_transcript keeps the script and drops ad-libs", () => {
    const heard = heardWords("The Holosun Gen 5 MOS is not uh cheap.");
    const script = "The Holosun Gen 3 MOS is not cheap.";
    const base = alignToScript(script, heard, []);
    const gen = base.discrepancies!.find((x) => x.script === "3")!;
    const filler = base.discrepancies!.find((x) => x.type === "addition")!;
    assert.equal(base.stats.unresolvedSignificant, 1);
    assert.ok(base.words.some((w) => w.word === "3"), "unresolved: script word shown");

    const kept = alignToScript(script, heard, [], { [gen.id]: "keep_audio", [filler.id]: "correct_transcript" });
    assert.ok(kept.words.some((w) => w.word === "5" && w.source === "whisper"));
    assert.ok(!kept.words.some((w) => w.word === "3"));
    assert.ok(!kept.words.some((w) => w.word === "uh"), "ad-lib dropped");
    assert.equal(kept.stats.unresolvedSignificant, 0);
    const five = heard.find((w) => w.word === "5")!;
    assert.equal(kept.words.find((w) => w.word === "5")!.start, five.start, "voiceover timing stays authoritative");

    const fixed = alignToScript(script, heard, [], { [gen.id]: "correct_transcript" });
    assert.ok(fixed.words.some((w) => w.word === "3" && w.start === five.start));
  });

  test("modify_script rewrites only the chosen differences", () => {
    const script = "The Holosun Gen 3 MOS is cheap.\n\nBuy it today.";
    const heard = heardWords("The Holosun Gen 5 MOS is really cheap. Buy it today.");
    const r = alignToScript(script, heard, []);
    const gen = r.discrepancies!.find((x) => x.script === "3")!;
    const add = r.discrepancies!.find((x) => x.type === "addition")!;
    gen.resolution = "modify_script";
    assert.equal(rewriteScript(script, r.discrepancies!), "The Holosun Gen 5 MOS is cheap.\n\nBuy it today.");
    add.resolution = "modify_script";
    assert.equal(rewriteScript(script, r.discrepancies!), "The Holosun Gen 5 MOS is really cheap.\n\nBuy it today.");
  });
});

// ---------------------------------------------------------------------------------------------
describe("Phase 3: niches and channel defaults", () => {
  test("tech-amazon niche: strict exact-model matching, music off", () => {
    const n = JSON.parse(fs.readFileSync(path.join(paths.root, "niches", "tech-amazon.json"), "utf8"));
    assert.equal(n.name, "tech-amazon");
    assert.equal(n.productMatch.strict, true);
    assert.equal(n.productMatch.onConflict, "reject");
    assert.equal(n.music.enabled, false);
    assert.equal(n.affiliate.separateFromFootage, true);
    assert.equal(n.product.allowStock, false);
    for (const f of ["general.json", "guns.json"]) assert.ok(fs.existsSync(path.join(paths.root, "niches", f)), f);
  });

  test("every channel style defaults background music to OFF", () => {
    const dir = path.join(paths.root, "channels");
    const styles = fs.readdirSync(dir).filter((c) => fs.existsSync(path.join(dir, c, "style.json")));
    assert.ok(styles.length > 0);
    for (const c of styles) {
      const s = JSON.parse(fs.readFileSync(path.join(dir, c, "style.json"), "utf8").replace(/^\uFEFF/, ""));
      assert.equal(s.music?.enabled, false, `${c}/style.json`);
    }
  });

  test("music is opt-in and a niche can veto it", () => {
    assert.equal(musicEnabled({ music: {} }), false);
    assert.equal(musicEnabled({ music: { enabled: true } }), true);
    assert.equal(musicEnabled({ music: { enabled: true } }, { music: { enabled: false } }), false);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Phase 3: product research and exact-model matching", () => {
  test("ASIN parsing and affiliate separation", () => {
    assert.equal(parseAsin("https://www.amazon.com/Apple-AirPods-Pro/dp/B0CHWRXH8B/ref=sr_1_1"), "B0CHWRXH8B");
    assert.equal(parseAsin("https://www.amazon.com/gp/product/B09JQMJHXY?th=1"), "B09JQMJHXY");
    const s = splitAmazonUrl("https://www.amazon.com/dp/B0CHWRXH8B?tag=mychannel-20&linkCode=ll1");
    assert.equal(s.asin, "B0CHWRXH8B");
    assert.equal(s.amazonUrl, "https://www.amazon.com/dp/B0CHWRXH8B");
    assert.match(s.affiliateUrl!, /tag=mychannel-20/);
    assert.equal(splitAmazonUrl("https://www.amazon.com/dp/B0CHWRXH8B").affiliateUrl, undefined);
    assert.throws(() => splitAmazonUrl("https://example.com/dp/B0CHWRXH8B"), /not an Amazon link/);
  });

  test("footage queries never carry affiliate data", () => {
    const r = { ...recordFromName("Apple AirPods Pro 2"), asin: "B0CHWRXH8B", affiliateUrl: "https://amzn.to/abc" };
    const q = footageQuery(r, "unboxing");
    assert.match(q, /Apple AirPods Pro 2 unboxing/);
    assert.doesNotMatch(q, /amzn|B0CHWRXH8B|tag=/);
    assert.throws(() => footageQuery({ ...r, model: "AirPods https://amzn.to/x" }), /link/);
  });

  test("exact model verification: match, conflict, review, no match", () => {
    const pro2 = { manufacturer: "Apple", model: "AirPods Pro", variant: "Pro", generation: "2" };
    assert.equal(verifyModelMatch(pro2, "Apple AirPods Pro (2nd Generation) hands-on").verdict, "match");
    assert.equal(verifyModelMatch(pro2, "Apple AirPods Pro Max review").verdict, "conflict");
    assert.equal(verifyModelMatch(pro2, "AirPods Pro 1st gen teardown").verdict, "conflict");
    assert.equal(verifyModelMatch(pro2, "AirPods Pro review").verdict, "needs_review");
    assert.equal(verifyModelMatch(pro2, "Sony WH-1000XM5 review").verdict, "no_match");
    assert.equal(verifyModelMatch("Holosun MOS Gen 3", "Holosun MOS Gen 5 red dot").verdict, "conflict");
    assert.equal(verifyModelMatch("Apple iPhone 15 Pro", "iPhone 15 Pro Max camera test").verdict, "conflict");
    assert.equal(verifyModelMatch("Apple iPhone 15 Pro", "iPhone 14 Pro camera test").verdict, "conflict");
    assert.equal(verifyModelMatch("Samsung Galaxy S24", "Google Galaxy S24", { knownManufacturers: ["Samsung", "Google"] }).verdict, "conflict");
    assert.equal(verifyModelMatch("Apple iPhone 15 Pro", "Apple iPhone 15 Pro unboxing").verdict, "match");
  });
});

// ---------------------------------------------------------------------------------------------
describe("Phase 3: licence ledger", () => {
  const scenes = [0, 1, 2, 3, 4, 5, 6, 7].map((id) => ({ id }));
  const a = (o: Partial<Assets[string]>): Assets[string] => ({ path: `/m/${o.url ?? "x"}.mp4`, source: "pexels", license: "Pexels License", url: "", kind: "video", ...o });
  const assets: Assets = {
    "0": a({ source: "wikimedia", license: "CC BY-SA 4.0", url: "https://commons.wikimedia.org/a", author: "Ann" }),
    "1": a({ source: "archive", license: "Public domain", url: "https://archive.org/b" }),
    "2": a({ source: "unsplash", license: "Unsplash License", url: "https://unsplash.com/c" }),
    "3": a({ source: "pexels", license: "Pexels License", url: "https://pexels.com/d" }),
    "4": a({ source: "presskit", license: "Manufacturer product photo (official, editorial/review use) - https://maker.com", url: "https://maker.com/e" }),
    "5": a({ source: "presskit", license: "Press kit from brand PR", url: "https://maker.com/f" }),
    "6": a({ source: "youtube_cc", license: "CC BY (YouTube) review clip", url: "https://youtube.com/g" }),
    "7": a({ source: "pexels", license: "Pexels License", url: "https://pexels.com/d" }), // same clip as scene 3
  };

  test("categories cover wikimedia / archive / unsplash / stock / official / presskit / review", () => {
    const l = buildLedger(scenes, assets, null, "2026-01-01T00:00:00.000Z");
    assert.deepEqual(l.records.map((r) => r.category), ["wikimedia", "archive", "unsplash", "stock", "official", "presskit", "review", "stock"]);
    assert.equal(l.records[0].licenseClass, "cc_by_sa");
    assert.equal(l.records[0].attributionRequired, true);
    assert.equal(l.records[1].licenseClass, "public_domain");
    assert.equal(classifyLicense("CC BY-NC 4.0"), "unknown");
    assert.equal(ledgerCategory("graphic"), "generated");
  });

  test("repeated clips are counted and penalised more each time", () => {
    const l = buildLedger(scenes, assets);
    assert.equal(l.records.find((r) => r.sceneId === 3)!.uses, 2);
    assert.deepEqual(l.summary.reused, [{ assetKey: "https://pexels.com/d", uses: 2, scenes: [3, 7] }]);
    assert.equal(reusePenalty(0), 0);
    assert.ok(reusePenalty(1) > 0 && reusePenalty(2) > 2 * reusePenalty(1) && reusePenalty(3) > reusePenalty(2));
  });

  test("licenses.json keeps first-logged times and lists missing licences", () => {
    const dir = fs.mkdtempSync(path.join(tmp, "ledger-"));
    const first = writeLedger(dir, scenes, assets);
    const again = writeLedger(dir, scenes, { ...assets, "2": { ...assets["2"], license: "" } });
    assert.equal(readLedger(dir)!.records.length, 7);
    assert.deepEqual(again.summary.missing, [2]);
    assert.equal(again.records[0].firstLoggedAt, first.records[0].firstLoggedAt);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Phase 4: scene content hash", () => {
  const media = path.join(tmp, "clip.png");
  const voice = path.join(tmp, "voice.wav");
  before(() => {
    fs.writeFileSync(media, "png");
    fs.writeFileSync(voice, "wav");
  });
  const base = (): SceneHashInput => ({
    sceneId: 1,
    audio: { file: voice, start: 1, end: 3 },
    asset: { path: media, kind: "image", source: "local" },
    captions: { lines: [{ text: "hi", start: 1, end: 2 }] },
    overlays: [],
    transition: "cut",
    motion: "zoom_in",
    frames: 60,
    fadeIn: false,
    fadeOut: false,
    version: 5,
  });

  test("deterministic and key-order independent", () => {
    assert.equal(sceneContentHash(base()), sceneContentHash(base()));
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    assert.match(sceneContentHash(base()), /^[0-9a-f]{64}$/);
  });

  test("captions, motion, transition, audio slice and asset file changes all change the hash", () => {
    const h = sceneContentHash(base());
    assert.notEqual(sceneContentHash({ ...base(), captions: { lines: [{ text: "hey", start: 1, end: 2 }] } }), h);
    assert.notEqual(sceneContentHash({ ...base(), motion: "pan_left" }), h);
    assert.notEqual(sceneContentHash({ ...base(), transition: "fade" }), h);
    assert.notEqual(sceneContentHash({ ...base(), audio: { file: voice, start: 1, end: 3.5 } }), h);
    const t = new Date(Date.now() + 60_000);
    fs.utimesSync(media, t, t);
    assert.notEqual(sceneContentHash(base()), h, "touching the asset file invalidates the segment");
  });

  test("concat list and change detection", () => {
    assert.equal(concatList([{ file: "C:\\a\\it's.mp4", frames: 45 }]), "file 'C:/a/it'\\''s.mp4'\nduration 1.500000\n");
    assert.deepEqual(changedScenes({ updatedAt: "", scenes: { "0": { hash: "a", file: "", frames: 1 }, "1": { hash: "b", file: "", frames: 1 } } }, { "0": "a", "1": "c", "2": "d" }), [1, 2]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Phase 4: QA gate", () => {
  const good = path.join(tmp, "good.mp4");
  const empty = path.join(tmp, "empty.mp4");
  before(() => {
    fs.writeFileSync(good, "data");
    fs.writeFileSync(empty, "");
  });
  const gs = (id: number, p: string, source = "pexels"): GateScene => ({ id, start: id * 5, asset: { path: p, kind: "video", source } });

  test("missing, empty and unreadable files fail", async () => {
    assert.equal((await checkAssetFiles([gs(0, good)])).status, "pass");
    const r = await checkAssetFiles([gs(0, good), gs(1, empty), gs(2, path.join(tmp, "nope.mp4"))]);
    assert.equal(r.status, "fail");
    assert.match(r.detail, /missing #2/);
    assert.match(r.detail, /empty file/);
    const probed = await checkAssetFiles([gs(0, good)], async () => false);
    assert.match(probed.detail, /unreadable/);
  });

  test("excessive clip reuse fails, cards do not count", () => {
    assert.equal(checkClipReuse([0, 1, 2].map((i) => gs(i, good)), 3).status, "pass");
    assert.equal(checkClipReuse([0, 1, 2, 3].map((i) => gs(i, good)), 3).status, "fail");
    assert.equal(checkClipReuse([0, 1, 2, 3].map((i) => gs(i, good, "graphic")), 3).status, "pass");
  });

  test("unverified product models fail in strict niches, conflicts always fail", () => {
    const scenes = [{ id: 0, type: "product" as const, product_name: "Apple iPhone 15 Pro" }];
    const asset = (modelCheck?: Assets[string]["modelCheck"]): Assets => ({ "0": { path: good, source: "pexels", license: "Pexels License", url: "u", kind: "video", ...(modelCheck ? { modelCheck } : {}) } });
    assert.equal(checkProductMatches(scenes, asset("match"), {}).status, "pass");
    assert.equal(checkProductMatches(scenes, asset(), {}).status, "warn");
    assert.equal(checkProductMatches(scenes, asset(), { productMatch: { strict: true } }).status, "fail");
    assert.equal(checkProductMatches(scenes, asset("conflict"), {}).status, "fail");
    assert.equal(checkProductMatches(scenes, asset(), { productMatch: { strict: true } }, { [good]: "match" }).status, "pass", "human verification clears it");
  });

  test("external assets need a current licence record", () => {
    const scenes = [{ id: 0 }, { id: 1 }] as Pick<Scene, "id">[];
    const assets: Assets = {
      "0": { path: good, source: "pexels", license: "Pexels License", url: "https://pexels.com/x", kind: "video" },
      "1": { path: "/card.png", source: "graphic", license: "Generated by ClipForge (own work)", url: "", kind: "image" },
    };
    assert.equal(checkLicenseRecords(scenes, assets, null).status, "fail");
    assert.equal(checkLicenseRecords(scenes, assets, buildLedger(scenes, assets)).status, "pass");
    const swapped: Assets = { ...assets, "0": { ...assets["0"], path: empty } };
    assert.equal(checkLicenseRecords(scenes, swapped, buildLedger(scenes, assets)).status, "fail", "stale record after a swap");
  });

  test("unresolved significant discrepancies block approval", () => {
    const tokens = "Gen 3 MOS".split(" ");
    const h = heardWords("Gen 5 MOS");
    const d = findDiscrepancies(tokens, h, alignTokens(["gen", "3", "mos"], ["gen", "5", "mos"]));
    assert.equal(checkDiscrepancies(d).status, "fail");
    d[0].resolution = "keep_audio";
    assert.equal(checkDiscrepancies(d).status, "pass");
    assert.equal(checkDiscrepancies(null).status, "pass");
  });
});

// ---------------------------------------------------------------------------------------------
const ff = ffmpegPath();
describe("Phase 4: incremental render (FFmpeg)", { skip: ff ? false : "ffmpeg not found" }, () => {
  const project = `_test_incremental_${process.pid}`;
  const dir = path.join(paths.workspace, project);
  const out = path.join(paths.output, `${project}.mp4`);
  let render: typeof import("../src/commands/render.js").render;

  before(async () => {
    render = (await import("../src/commands/render.js")).render;
    process.env.VIDEO_ENCODER = "libx264"; // portable: no GPU needed for the test
    process.env.RENDER_CONCURRENCY = "1";
    fs.mkdirSync(dir, { recursive: true });
    const gen = (args: string[]) => assert.equal(spawnSync(ff!, ["-hide_banner", "-loglevel", "error", "-y", ...args]).status, 0);
    for (const [i, c] of ["red", "green", "blue", "yellow"].entries()) gen(["-f", "lavfi", "-i", `color=c=${c}:s=1920x1080`, "-frames:v", "1", path.join(dir, `c${i}.png`)]);
    gen(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", path.join(dir, "voice.wav")]);
    const scene = (id: number, img: number) => ({ id, start: id, end: id + 1, startFrame: id * 30, endFrame: (id + 1) * 30, asset: { path: path.join(dir, `c${img}.png`), kind: "image", source: "local" }, motion: "none", transition: "cut" });
    const tl = {
      version: 2, fps: 30, width: 1920, height: 1080, duration: 3, voice: path.join(dir, "voice.wav"),
      music: { files: [], volumeDb: -18, duckDb: -10 }, logo: null, motion: { graphics: false, sfx: false, sfxDb: -14 },
      captions: { enabled: false, font: "Arial", fontSize: 54, maxWordsPerLine: 7 },
      scenes: [scene(0, 0), scene(1, 1), scene(2, 2)],
    };
    fs.writeFileSync(path.join(dir, "timeline.json"), JSON.stringify(tl));
  });
  after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { force: true });
  });

  const report = () => JSON.parse(fs.readFileSync(path.join(dir, "render_report.json"), "utf8"));
  const quiet = () => {};

  test("first render builds every segment, a second render reuses all", async () => {
    assert.equal(await render({ project }, quiet), 0);
    assert.equal(report().segmentsRendered, 3);
    assert.ok(fs.existsSync(out));
    assert.equal(fs.readdirSync(path.join(dir, "cache", "segments")).filter((f) => f.endsWith(".mp4")).length, 3);
    assert.equal(await render({ project }, quiet), 0);
    assert.equal(report().segmentsRendered, 0);
  });

  test("editing one scene re-renders only that scene and stitches the rest", async () => {
    const tlFile = path.join(dir, "timeline.json");
    const tl = JSON.parse(fs.readFileSync(tlFile, "utf8"));
    tl.scenes[1].asset.path = path.join(dir, "c3.png");
    fs.writeFileSync(tlFile, JSON.stringify(tl));
    assert.equal(await render({ project }, quiet), 0);
    assert.equal(report().segmentsRendered, 1);
    assert.deepEqual(report().scenesRerendered, [1]);
    assert.equal(report().sync, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "cache", "segments", "manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.scenes), ["0", "1", "2"]);
    assert.equal(fs.readdirSync(path.join(dir, "cache", "segments")).filter((f) => f.endsWith(".mp4")).length, 3, "old segment of scene 1 pruned");
  });

  test("--scene forces a single-scene rerender", async () => {
    assert.equal(await render({ project, scenes: [2] }, quiet), 0);
    assert.deepEqual(report().scenesRerendered, [2]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Exact-model footage: source policy", () => {
  test("generic stock is off by default and never searched", async () => {
    const { genericStockAllowed, nicheProviders, searchProvider } = await import("../src/lib/assets/sources.js");
    const { loadNiche } = await import("../src/lib/niche.js");
    const prev = process.env.GENERIC_STOCK;
    delete process.env.GENERIC_STOCK;
    try {
      assert.equal(genericStockAllowed(), false);
      assert.deepEqual(nicheProviders(loadNiche("general")), []);
      for (const p of ["pexels", "pixabay", "unsplash", "wikimedia_video", "archive"] as const) assert.deepEqual(await searchProvider(p, "lawn mower", loadNiche("general")), []);
      process.env.GENERIC_STOCK = "on";
      assert.ok(nicheProviders(loadNiche("general")).includes("pexels"), "opt back in with GENERIC_STOCK=on");
    } finally {
      if (prev === undefined) delete process.env.GENERIC_STOCK;
      else process.env.GENERIC_STOCK = prev;
    }
  });

  test("exact-model clips are logged as review / official media", () => {
    assert.equal(ledgerCategory("youtube_exact_model", "YouTube - Joe (YouTube review / dealer video; ...)"), "review");
    assert.equal(ledgerCategory("youtube_exact_model", "YouTube - Scag Power (official brand channel; ...)"), "official");
  });

  test("multi-word brands split correctly", () => {
    const r = recordFromName("John Deere Z930M");
    assert.equal(r.manufacturer, "John Deere");
    assert.equal(r.model, "Z930M");
    assert.equal(recordFromName("Scag Turf Tiger II").model, "Turf Tiger II");
  });
});

describe("Exact-model footage: YouTube title / window / shot logic", () => {
  test("title must contain the exact model token", () => {
    assert.equal(yx.titleHasModel("Honda HRX 217 self propelled walk around", "HRX217"), true);
    assert.equal(yx.titleHasModel("Honda HRX217HZA Battle Axe", "HRX217"), true, "trim suffix of the same model");
    assert.equal(yx.titleHasModel("Honda HRX2170 mower", "HRX217"), false);
    assert.equal(yx.titleHasModel("John Deere Z930R walkaround", "Z930M"), false);
    assert.equal(yx.titleHasModel("John Deere z-930m review", "Z930M"), true);
    assert.equal(yx.titleHasModel("Scag Turf Tiger III review", "Turf Tiger II"), false);
    assert.equal(yx.titleHasModel('Scag Turf Tiger II 61" walkaround', "Turf Tiger II"), true);
  });

  test("comparison titles and other models are rejected; sizes are not model numbers", () => {
    assert.equal(yx.conflictingModel('Honda HRX217 Review | 21" Self Propelled Mower', "HRX217"), null);
    assert.equal(yx.conflictingModel("Honda HRX216 vs HRX217", "HRX217"), "HRX216");
    assert.equal(yx.conflictingModel("John Deere Z930M vs Z960M", "Z930M"), "Z960M");
    assert.equal(yx.generationConflict("MOS Gen 5 review", "MOS Gen 3"), "5");
    const hit = (id: string, title: string, duration: number) => ({ id, url: `u/${id}`, title, duration, channel: "c" });
    const { kept, rejected } = yx.filterHits(
      [
        hit("a", "Honda HRX217 walkaround", 300),
        hit("b", "Honda HRX217 short", 30),
        hit("c", "Honda HRX217 full service", 3600),
        hit("d", "Honda HRX216 vs HRX217", 400),
        hit("e", "Honda HRN216 demo", 200),
        hit("f", "Honda HRX217 vs Toro Recycler 22", 500),
      ],
      "Honda",
      "HRX217",
      ["Recycler 22"],
    );
    assert.deepEqual(kept.map((h) => h.id), ["a"]);
    assert.deepEqual(rejected.map((r) => r.hit.id).sort(), ["b", "c", "d", "e", "f"]);
    assert.match(rejected.find((r) => r.hit.id === "b")!.why, /length/);
  });

  test("search queries cover walkaround / review / demo / official", () => {
    assert.deepEqual(yx.searchQueries("Scag", "Turf Tiger II"), ['"Scag Turf Tiger II" walkaround', '"Scag Turf Tiger II" review', '"Scag Turf Tiger II" demo', '"Scag Turf Tiger II" official']);
  });

  test("windows skip the intro, prefer feature chapters and never overlap", () => {
    const w = yx.planWindows(300, [{ start: 0, end: 15, title: "Intro" }, { start: 120, end: 150, title: "Deck and blades" }], ["deck"], { count: 4, seconds: 20 });
    assert.equal(w.length, 4);
    assert.ok(w.every((v) => v.start >= 10), "first 10 s skipped");
    assert.deepEqual(w.find((v) => v.feature === "deck"), { start: 120, end: 140, feature: "deck" });
    for (let i = 1; i < w.length; i++) assert.ok(w[i].start >= w[i - 1].end);
  });

  test("camera cuts become clean shots; long shots are sliced to 5 s", () => {
    const cuts = yx.cutsFromShowinfo("[Parsed_showinfo_1] n:0 pts:1 pts_time:4.2 ...\n[Parsed_showinfo_1] n:1 pts:2 pts_time:5.0 ...");
    assert.deepEqual(cuts, [4.2, 5]);
    const shots = yx.shotsFromCuts(cuts, 20);
    assert.deepEqual(shots[0], { start: 0, end: 4.1 });
    assert.ok(!shots.some((s) => s.start >= 4.2 && s.end <= 5.0), "the 0.8 s shot between the cuts is dropped");
    assert.ok(shots.filter((s) => s.start >= 5).every((s) => s.end - s.start <= 5.01));
    assert.deepEqual(yx.shotsFromCuts([], 12), [{ start: 0, end: 5 }, { start: 5, end: 10 }, { start: 10, end: 12 }], "no cuts: 5 s slices");
  });

  test("talking heads, logos and title cards are rejected (scores measured on real frames)", () => {
    const t = { minPositive: 0.2, maxNegative: 0.34, margin: 0.005 };
    // [machine prompt, worst negative prompt] measured on real frames: walkaround B-roll vs. a dealer
    // talking beside the mower and a channel's cartoon logo.
    assert.equal(yx.classifyShot(0.3214, 0.2972, t), "keep");
    assert.equal(yx.classifyShot(0.2498, 0.2063, t), "keep");
    assert.equal(yx.classifyShot(0.2992, 0.3906, t, "person"), "talking_head");
    assert.equal(yx.classifyShot(0.3446, 0.3632, t, "person"), "talking_head");
    assert.equal(yx.classifyShot(0.2609, 0.2932, t, "graphic"), "off_topic");
    assert.equal(yx.classifyShot(0.19, 0.1, t), "off_topic", "not the machine at all");
    assert.equal(yx.negativePrompts("lawn mower")[0].text, yx.NEGATIVE_PROMPT);
  });
});

describe("Exact-model footage: model vault", () => {
  const root = fs.mkdtempSync(path.join(tmp, "vaults-"));
  const dir = path.join(root, yx.vaultName("Scag", "Turf Tiger II"));
  before(() => {
    fs.mkdirSync(path.join(dir, "clips"), { recursive: true });
    fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
    fs.writeFileSync(path.join(dir, "clips", "v1_100.mp4"), "mp4");
    fs.writeFileSync(path.join(dir, "frames", "v1_100.jpg"), "jpg");
    const base = { videoId: "v1", title: "Scag Turf Tiger II Walkaround", channel: "Scag Power Equipment", start: 10, end: 14, clipPositive: 0.31, clipNegative: 0.1, feature: "deck", width: 1920, height: 1080, addedAt: "t", url: "https://www.youtube.com/watch?v=v1&t=10s" };
    const m = {
      brand: "Scag", model: "Turf Tiger II", category: "lawn mower", features: ["deck"], updatedAt: "", processed: {}, rejectedVideos: [],
      stats: { shotsScored: 3, talkingHeads: 2, offTopic: 0, kept: 1 },
      items: [{ ...base, id: "v1_100_v", kind: "video", file: "clips/v1_100.mp4", duration: 4 }, { ...base, id: "v1_100_i", kind: "image", file: "frames/v1_100.jpg" }],
    };
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m));
  });

  test("vault folder name", () => assert.equal(yx.vaultName("John Deere", "Z930M"), "john-deere_z930m"));

  test("scenes find the vault by the exact model in the product name", () => {
    assert.equal(yx.findVaultFor("Scag Turf Tiger II", root)?.manifest.model, "Turf Tiger II");
    assert.equal(yx.findVaultFor("the Turf Tiger II zero turn", root)?.dir, dir);
    assert.equal(yx.findVaultFor("Scag Turf Tiger III", root), null);
    assert.equal(yx.findVaultFor("Honda HRX217", root), null);
  });

  test("vault clips become verified product-pool shots and review-page options", () => {
    const pool = yx.vaultPoolShots(["Scag Turf Tiger II"], root);
    assert.equal(pool.length, 1);
    assert.equal(pool[0].verified, true);
    assert.equal(pool[0].product, "Scag Turf Tiger II");
    assert.equal(pool[0].frames.length, 1, "the matching still is the shot's frame");
    assert.match(pool[0].license, /official brand channel/);
    const found = yx.searchVaults("turf tiger deck", root);
    assert.equal(found.length, 2);
    assert.ok(found.every((c) => c.source === "youtube_exact_model" && c.thumbUrl?.startsWith("/api/vaults/")));
    assert.equal(yx.searchVaults("pexels sunset", root).length, 0);
  });
});
