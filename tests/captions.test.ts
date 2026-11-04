import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NO_CLEANUP, parseVoiceCleanup, voiceCleanupFilter } from "../src/audio/voiceCleanup.js";
import { fromLegacyTimeline, LegacyTimeline } from "../src/domain/timeline.types.js";
import { compileTimeline, writeTimelineV3 } from "../src/lib/compiler/timelineCompiler.js";
import { run } from "../src/lib/exec.js";
import { buildPreviewModel } from "../src/lib/preview/previewModel.js";
import { CAPTION_PRESETS, captionMaxWords, captionPreset, isCaptionPreset } from "../src/lib/render/captionPresets.js";
import { buildAss, CaptionStyle, captionLines } from "../src/lib/render/captions.js";
import { ffmpegPath } from "../src/lib/tools.js";
import { ProjectStore } from "../src/server/state/projectStore.js";
import { createEditorAPI } from "../src/server/routes/editorAPI.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-captions-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const touch = (f: string) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, "x"), f);
const ff = ffmpegPath();

const style: CaptionStyle = { enabled: true, font: "Arial", fontSize: 54, maxWordsPerLine: 7, background: "rgba(0,0,0,0.55)", textColor: "#FFFFFF", marginV: 70 };
const words = [
  { word: "Ruger", start: 1, end: 1.4, source: "script" as const }, { word: "makes", start: 1.4, end: 1.9, source: "script" as const },
  { word: "a", start: 1.9, end: 2.0, source: "script" as const }, { word: "good", start: 2.0, end: 2.5, source: "script" as const },
  { word: "pistol.", start: 2.5, end: 3.2, source: "script" as const },
];
const styleLineOf = (ass: string) => ass.split("\n").find((l) => l.startsWith("Style:"))!;
const eventsOf = (ass: string) => ass.split("\n").filter((l) => l.startsWith("Dialogue:"));

describe("caption presets", () => {
  test("ids are validated; an unknown or missing id is Classic", () => {
    assert.deepEqual(CAPTION_PRESETS.map((p) => p.id), ["classic", "bold", "karaoke", "pop", "highlight", "bold-pop", "minimal"]);
    assert.equal(isCaptionPreset("bold"), true);
    assert.equal(isCaptionPreset("../x"), false);
    assert.equal(captionPreset("nope").id, "classic");
    assert.equal(captionPreset(undefined).id, "classic");
  });

  test("words per line: the preset's, else the channel's", () => {
    assert.equal(captionMaxWords({ maxWordsPerLine: 7 }), 7);
    assert.equal(captionMaxWords({ preset: "bold", maxWordsPerLine: 7 }), 3);
    assert.equal(captionMaxWords({ preset: "pop", maxWordsPerLine: 7 }), 1);
  });

  test("lines carry word timing only when the style needs it", () => {
    assert.equal(captionLines(words, 7)[0].words, undefined);
    const l = captionLines(words, 7, { withWords: true })[0];
    assert.deepEqual(l.words?.map((w) => [w.text, w.start, w.end]), [["Ruger", 1, 1.4], ["makes", 1.4, 1.9], ["a", 1.9, 2], ["good", 2, 2.5], ["pistol.", 2.5, 3.2]]);
  });
});

describe("ASS for each preset", () => {
  const lines = captionLines(words, 7);
  const withWords = captionLines(words, 7, { withWords: true });

  test("classic is the look every existing video has: the channel's box, plain text", () => {
    const ass = buildAss(lines, style);
    assert.equal(styleLineOf(ass), "Style: Default,Arial,54,&H00FFFFFF,&H00FFFFFF,&H73000000,&H73000000,-1,0,0,0,100,100,0,0,3,12,0,2,160,160,70,1");
    assert.deepEqual(eventsOf(ass), ["Dialogue: 0,0:00:01.00,0:00:03.80,Default,,0,0,0,,Ruger makes a good pistol."]);
    assert.equal(buildAss(lines, { ...style, preset: "classic" }), ass, "naming it changes nothing");
  });

  test("bold: capitals, no box, heavy outline, bigger", () => {
    const ass = buildAss(captionLines(words, 3), { ...style, preset: "bold" });
    assert.match(styleLineOf(ass), /^Style: Default,Arial,68,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,8,3,2,160,160,70,1$/);
    assert.match(eventsOf(ass)[0], /,RUGER MAKES A$/);
  });

  test("karaoke: every word has a fill sweep that lasts until the next word", () => {
    const ass = buildAss(withWords, { ...style, preset: "karaoke" });
    assert.match(styleLineOf(ass), /,&H000AD6FF,&H00FFFFFF,&H00000000,/, "accent is the sung colour, the text colour comes first");
    assert.equal(eventsOf(ass)[0].split(",,0,0,0,,")[1], "{\\kf40}Ruger {\\kf50}makes {\\kf10}a {\\kf50}good {\\kf70}pistol.");
  });

  test("pop: one event per word, each with the pop-in", () => {
    const ass = buildAss(captionLines(words, 1, { withWords: true }), { ...style, preset: "pop" });
    assert.equal(eventsOf(ass).length, 5);
    assert.match(eventsOf(ass)[0], /\{\\fscx75\\fscy75\\t\(0,120,\\fscx100\\fscy100\)\}RUGER$/);
    assert.match(styleLineOf(ass), /,92,&H000AD6FF,/, "54 x 1.7, in the accent colour");
  });

  test("minimal: smaller, outline only", () => {
    assert.match(styleLineOf(buildAss(lines, { ...style, preset: "minimal" })), /,Arial,43,.*,1,3,2,2,160,160,70,1$/);
  });

  test("channel text colour and size still apply where a preset does not override them", () => {
    assert.match(styleLineOf(buildAss(lines, { ...style, preset: "minimal", textColor: "#00FF00", fontSize: 40 })), /,Arial,32,&H0000FF00,/);
    assert.match(styleLineOf(buildAss(lines, { ...style, preset: "bold", textColor: "#00FF00" })), /,&H00FFFFFF,/, "bold is always white");
  });

  test("FFmpeg accepts every preset's file and draws it", { skip: !ff }, async () => {
    for (const p of CAPTION_PRESETS) {
      const st = { ...style, preset: p.id };
      const file = path.join(tmp, `${p.id}.ass`);
      fs.writeFileSync(file, buildAss(captionLines(words, captionMaxWords(st), { withWords: p.mode !== "line" }), st), "utf8");
      const out = path.join(tmp, `${p.id}.png`);
      const r = await run(ff!, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=0x205030:s=1280x720:d=4", "-vf", `subtitles='${file.replace(/\\/g, "/").replace(":", "\\:")}'`, "-ss", "2.1", "-frames:v", "1", out]);
      assert.equal(r.code, 0, `${p.id}: ${r.stderr}`);
      assert.ok(fs.statSync(out).size > 3000, `${p.id}: frame written`);
    }
  });
});

describe("voice cleanup", () => {
  test("filter chain per option, in a fixed order; nothing on = no filter", () => {
    assert.equal(voiceCleanupFilter(undefined), "");
    assert.equal(voiceCleanupFilter(NO_CLEANUP), "");
    assert.equal(voiceCleanupFilter({ rumble: true }), "highpass=f=80");
    assert.equal(voiceCleanupFilter({ denoise: "light", rumble: true, even: true, loudness: true }), "highpass=f=80,afftdn=nr=10:nf=-40:tn=1,acompressor=threshold=-21dB:ratio=3:attack=15:release=200:makeup=3,loudnorm=I=-16:TP=-1.5:LRA=9");
    assert.match(voiceCleanupFilter({ denoise: "strong" }), /afftdn=nr=20/);
  });

  test("settings are validated; anything unknown keeps the previous value", () => {
    assert.deepEqual(parseVoiceCleanup({ denoise: "light", rumble: true, even: "yes", loudness: 1 }), { denoise: "light", rumble: true, even: false, loudness: false });
    assert.deepEqual(parseVoiceCleanup({ denoise: "extreme" }, { denoise: "strong", rumble: true, even: false, loudness: true }), { denoise: "strong", rumble: true, even: false, loudness: true });
  });

  test("FFmpeg runs the full chain, and strong denoise lowers steady hiss", { skip: !ff }, async () => {
    const level = async (filter: string) => {
      const af = ["volumedetect"].join(",");
      const chain = filter ? `${filter},${af}` : af;
      const r = await run(ff!, ["-hide_banner", "-f", "lavfi", "-i", "anoisesrc=c=pink:a=0.01:d=6:r=48000", "-af", chain, "-f", "null", "-"]);
      assert.equal(r.code, 0, r.stderr.slice(-200));
      return Number(r.stderr.match(/mean_volume: (-?[\d.]+) dB/)![1]);
    };
    const raw = await level("");
    const cleaned = await level(voiceCleanupFilter({ denoise: "strong" }));
    // FFT denoising takes a few dB off steady hiss (heavy noise needs a cleaner recording).
    assert.ok(cleaned < raw - 2, `pink noise ${raw} dB -> ${cleaned} dB`);
    await level(voiceCleanupFilter({ denoise: "light", rumble: true, even: true, loudness: true }));
  });
});

describe("caption style and voice cleanup on the studio timeline", () => {
  const dir = path.join(tmp, "ws", "p");
  let store: ProjectStore;
  beforeEach(() => {
    const legacy: LegacyTimeline = {
      version: 2, fps: 30, width: 1920, height: 1080, voice: touch(path.join(tmp, "media", "voice.wav")), music: { files: [], volumeDb: -18 }, motion: { sfx: false, sfxDb: -14 }, captions: { enabled: false }, logo: null,
      scenes: [0, 1].map((i) => ({ id: i, startFrame: i * 90, endFrame: i * 90 + 90, motion: "none" as const, transition: "cut" as const, asset: { path: touch(path.join(tmp, "media", `${i}.png`)), kind: "image" as const, source: "local" } })),
    };
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    writeTimelineV3(dir, fromLegacyTimeline(legacy, { 0: "a", 1: "b" }));
    fs.writeFileSync(path.join(dir, "aligned.json"), JSON.stringify({ words: words.map(({ source: _s, ...w }) => w) }));
    store = new ProjectStore(() => dir);
  });

  test("turning captions on starts from the defaults; a style change re-renders every scene", () => {
    const r = store.apply("p", null, [{ op: "setCaptions", enabled: true, preset: "karaoke", fontSize: 60 }]);
    assert.deepEqual(r.touched.sort(), [0, 1]);
    const c = store.get("p").tl.settings!.captions as unknown as CaptionStyle;
    assert.deepEqual([c.enabled, c.preset, c.fontSize, c.font, c.maxWordsPerLine, c.background], [true, "karaoke", 60, "Arial", 7, "rgba(0,0,0,0.55)"]);
    assert.deepEqual((compileTimeline(store.get("p").tl).captions as unknown as CaptionStyle).preset, "karaoke");
    assert.throws(() => store.apply("p", null, [{ op: "setCaptions", preset: "neon" }]), /caption style must be one of/);
    assert.throws(() => store.apply("p", null, [{ op: "setCaptions", fontSize: 500 }]), /caption size must be between/);
  });

  test("the preview model draws the chosen style, with word timing for karaoke", () => {
    store.apply("p", null, [{ op: "setCaptions", enabled: true, preset: "karaoke" }]);
    const m = buildPreviewModel(store.get("p").tl, { mediaUrl: (id) => id, voiceUrl: "/v", words: words.map(({ source: _s, ...w }) => w) });
    assert.equal(m.captions?.preset, "karaoke");
    // Karaoke shows four words per line.
    assert.deepEqual(m.captions?.lines.map((l) => l.words?.map((w) => [w.text, w.startFrame])), [[["Ruger", 30], ["makes", 42], ["a", 57], ["good", 60]], [["pistol.", 75]]]);
    store.apply("p", null, [{ op: "setCaptions", preset: "classic" }]);
    assert.equal(buildPreviewModel(store.get("p").tl, { mediaUrl: (id) => id, voiceUrl: "/v", words: [] }).captions, null, "no words, no captions");
  });

  test("voice cleanup is a mix change: compile carries the filter, no scene is dirty, undo restores", () => {
    assert.equal(compileTimeline(store.get("p").tl).audio.voiceFilter, "");
    store.apply("p", null, [{ op: "setVoice", denoise: "light", rumble: true }]);
    assert.equal(compileTimeline(store.get("p").tl).audio.voiceFilter, "highpass=f=80,afftdn=nr=10:nf=-40:tn=1");
    assert.deepEqual([store.get("p").audioDirty, store.get("p").dirty], [true, []]);
    store.apply("p", null, [{ op: "setVoice", even: true }]);
    assert.match(compileTimeline(store.get("p").tl).audio.voiceFilter, /highpass.*afftdn.*acompressor/, "earlier options are kept");
    assert.throws(() => store.apply("p", null, [{ op: "setVoice", denoise: "extreme" }]), /denoise must be one of/);
  });

  test("RPC: the view shows the settings; a sample needs a cleanup option; files are served by name only", { skip: !ff }, async () => {
    const wav = path.join(tmp, "media", "tone.wav");
    await run(ff!, ["-v", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=10", wav]);
    const tl = store.get("p").tl;
    (tl.tracks.find((t) => t.kind === "voiceover")!.clips[0] as { media: { path: string } }).media.path = wav;
    writeTimelineV3(dir, tl);
    store = new ProjectStore(() => dir);
    const api = createEditorAPI({ store, dirOf: () => dir, validProject: () => true, render: () => {}, isBusy: () => false, categoryOf: () => "pistol", musicLibrary: () => [] });
    const call = async (method: string, params: Record<string, unknown> = {}) => (await api.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { project: "p", ...params } }))) as { result?: any; error?: { message: string } };
    const open = (await call("editor.open")).result;
    assert.deepEqual(open.settings.captions.styles.map((x: { id: string }) => x.id), ["classic", "bold", "karaoke", "pop", "highlight", "bold-pop", "minimal"]);
    assert.deepEqual({ ...open.settings, captions: { ...open.settings.captions, styles: undefined } }, { captions: { enabled: false, preset: "classic", fontSize: 54, styles: undefined }, voice: { denoise: "off", rumble: false, even: false, loudness: false } });
    assert.match((await call("editor.voiceSample", { frame: 30, cleaned: true })).error!.message, /switch at least one cleanup option on first/);
    const orig = (await call("editor.voiceSample", { frame: 30, seconds: 3 })).result;
    assert.ok(api.voiceSampleFile("p", orig.name));
    await call("editor.edit", { baseRevision: open.revision, ops: [{ op: "setVoice", rumble: true, even: true }] });
    const cleaned = (await call("editor.voiceSample", { frame: 30, seconds: 3, cleaned: true })).result;
    assert.notEqual(cleaned.name, orig.name);
    assert.match(cleaned.url, /voice-sample\?project=p&name=cleaned_/);
    assert.equal(api.voiceSampleFile("p", "../timeline.v3.json"), null);
  });
});
