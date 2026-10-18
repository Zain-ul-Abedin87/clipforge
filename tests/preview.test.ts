import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromLegacyTimeline, LegacyTimeline } from "../src/domain/timeline.types.js";
import { writeTimelineV3 } from "../src/lib/compiler/timelineCompiler.js";
import { buildPreviewModel } from "../src/lib/preview/previewModel.js";
import { ProjectStore } from "../src/server/state/projectStore.js";
import { createEditorAPI } from "../src/server/routes/editorAPI.js";
import { musicGain, PREVIEW_DUCK_DB } from "../cards/src/preview/mix.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-preview-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const touch = (f: string) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, "x"), f);
const media = (n: string) => touch(path.join(tmp, "media", n));

/** Three 3 s scenes: a flash into scene 1, a fade into scene 2; scene 0 carries a card and a PNG layer. */
function timeline() {
  const legacy: LegacyTimeline = {
    version: 2, fps: 30, width: 1920, height: 1080, voice: media("voice.wav"), music: { files: [], volumeDb: -18 }, motion: { sfx: false, sfxDb: -14 }, captions: { enabled: true, font: "Arial", fontSize: 50, maxWordsPerLine: 4, background: "rgba(0,0,0,0.5)", textColor: "#fff", marginV: 70 } as never, logo: { path: media("logo.png"), position: "top-left", opacity: 0.7 },
    scenes: [
      {
        id: 0, startFrame: 0, endFrame: 90, motion: "zoom_in", transition: "cut", asset: { path: media("a.png"), kind: "image", source: "local" },
        overlays: [
          { path: media("price.png"), delay: 0.5, anim: "slide_up", out: 2, card: { comp: "PriceCard", props: { name: "Ruger", price: "$300" } } },
          { path: media("badge.png"), delay: 1, anim: "slide_left" },
          { path: media("alpha.mov"), delay: 1, anim: "fade", video: true },
        ],
      },
      { id: 1, startFrame: 90, endFrame: 180, motion: "none", transition: "flash", asset: { path: media("b.mp4"), kind: "video", source: "youtube_exact_model", in: 2 } },
      { id: 2, startFrame: 180, endFrame: 270, motion: "none", transition: "fade", asset: { path: media("c.mp4"), kind: "video", source: "youtube_exact_model", in: 0 } },
    ],
  };
  return fromLegacyTimeline(legacy, { 0: "a", 1: "b", 2: "c" });
}

const words = [
  { word: "Ruger", start: 0.2, end: 0.5 }, { word: "makes", start: 0.5, end: 0.8 }, { word: "this.", start: 0.8, end: 1.1 },
  { word: "Cut", start: 3.2, end: 3.5 }, { word: "this", start: 3.5, end: 3.8 }, { word: "part.", start: 3.8, end: 4.1 },
  { word: "Keep", start: 6.2, end: 6.5 }, { word: "going.", start: 6.5, end: 6.9 },
];
const input = { mediaUrl: (id: string) => `/m/${id}`, voiceUrl: "/voice", words };

describe("preview model", () => {
  test("clips carry source in-points and the scene transitions (flash in, fade in + previous fades out)", () => {
    const m = buildPreviewModel(timeline(), input);
    assert.deepEqual([m.fps, m.width, m.totalFrames], [30, 1920, 270]);
    const byId = Object.fromEntries(m.clips.map((c) => [c.id, c]));
    assert.deepEqual([byId.broll_0_0.kind, byId.broll_0_0.motion, byId.broll_0_0.url], ["image", "zoom_in", "/m/broll_0_0"]);
    assert.deepEqual([byId.broll_1_0.kind, byId.broll_1_0.sourceInSec, byId.broll_1_0.startFrame, byId.broll_1_0.frames], ["video", 2, 90, 90]);
    assert.equal(byId.broll_1_0.flashFrames, 9);
    assert.deepEqual([byId.broll_2_0.fadeInFrames, byId.broll_1_0.fadeOutFrames, byId.broll_0_0.fadeOutFrames], [8, 8, 0], "the fade into scene 2 also fades scene 1 out");
    assert.equal(byId.broll_2_0.flashFrames, 0);
  });

  test("overlays: cards are drawn from props, PNG layers streamed, pre-rendered alpha videos skipped", () => {
    const m = buildPreviewModel(timeline(), input);
    assert.equal(m.overlays.length, 2);
    const [card, still] = m.overlays;
    assert.deepEqual([card.card, card.url, card.startFrame, card.frames], [{ comp: "PriceCard", props: { name: "Ruger", price: "$300" } }, undefined, 15, 45]);
    assert.deepEqual([still.card, still.url, still.anim], [undefined, "/m/overlay_0_1", "slide_left"]);
  });

  test("captions follow the voice after a cut; logo, voice and music come along", () => {
    const dir = path.join(tmp, "ws", "p");
    const store = new ProjectStore(() => dir);
    fs.mkdirSync(dir, { recursive: true });
    writeTimelineV3(dir, timeline());
    const tl0 = buildPreviewModel(store.get("p").tl, input);
    assert.deepEqual(tl0.captions?.lines.map((l) => [l.startFrame, l.text]), [[6, "Ruger makes this."], [96, "Cut this part."], [186, "Keep going."]]);
    assert.deepEqual([tl0.captions?.fontSize, tl0.captions?.marginV], [50, 70]);
    assert.deepEqual(tl0.logo, { url: "/m/@logo", position: "top-left", opacity: 0.7 });

    // Cut seconds 3-4.5 (frames 90-135): the words inside are gone, later ones move left, the voice is in two parts.
    store.apply("p", null, [{ op: "cutRange", fromFrame: 90, toFrame: 135 }]);
    store.apply("p", null, [{ op: "setMusic", path: media("bed.mp3") }]);
    const m = buildPreviewModel(store.get("p").tl, input);
    assert.equal(m.totalFrames, 225);
    assert.deepEqual(m.captions?.lines.map((l) => [l.startFrame, l.text]), [[6, "Ruger makes this."], [141, "Keep going."]], "the cut line goes, the later line moves 45 frames left");
    assert.deepEqual(m.voice.parts.map((p) => [p.startFrame, p.frames, p.sourceInSec]), [[0, 90, 0], [90, 135, 4.5]]);
    assert.deepEqual(m.music, { url: "/m/music_0", gainDb: -18, duck: true, fadeInSec: 2, fadeOutSec: 3 });
  });

  test("no aligned words or captions off: no captions", () => {
    assert.equal(buildPreviewModel(timeline(), { ...input, words: null }).captions, null);
  });
});

describe("music level in the preview", () => {
  const music = { url: "", gainDb: -20, duck: false, fadeInSec: 2, fadeOutSec: 3 };
  test("level, ducking and fades, as a linear volume", () => {
    assert.equal(musicGain(music, 300, 900, 30), 0.1);
    assert.ok(Math.abs(musicGain({ ...music, duck: true }, 300, 900, 30) - 10 ** ((-20 + PREVIEW_DUCK_DB) / 20)) < 1e-9);
    assert.equal(musicGain(music, 0, 900, 30), 0, "fade in starts silent");
    assert.ok(Math.abs(musicGain(music, 30, 900, 30) - 0.05) < 1e-9, "half way through the 2 s fade in");
    assert.ok(Math.abs(musicGain(music, 855, 900, 30) - 0.05) < 1e-9, "half way through the 3 s fade out (1.5 s left)");
    assert.equal(musicGain({ ...music, fadeInSec: 0, fadeOutSec: 0 }, 0, 900, 30), 0.1);
  });
});

describe("editor API: preview and media", () => {
  const dir = path.join(tmp, "ws", "api");
  fs.mkdirSync(dir, { recursive: true });
  writeTimelineV3(dir, timeline());
  const api = createEditorAPI({ store: new ProjectStore(() => dir), dirOf: () => dir, validProject: () => true, render: () => {}, isBusy: () => false, categoryOf: () => "pistol", musicLibrary: () => [] });

  test("editor.preview returns the model with URLs that point at this project", async () => {
    const r = (await api.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "editor.preview", params: { project: "api" } }))) as { result: { clips: { url: string }[]; voice: { url: string } } };
    assert.match(r.result.clips[0].url, /^\/api\/editor\/media\?project=api&clip=broll_0_0$/);
    assert.equal(r.result.voice.url, "/api/projects/api/audio");
  });

  test("the preview streams pictures, still overlays and the logo; never alpha videos or the voice file", () => {
    assert.ok(api.media("api", "broll_1_0")?.endsWith("b.mp4"));
    assert.ok(api.media("api", "overlay_0_1")?.endsWith("badge.png"));
    assert.ok(api.media("api", "@logo")?.endsWith("logo.png"));
    assert.equal(api.media("api", "overlay_0_2"), null);
    assert.equal(api.media("api", "voice_0"), null);
  });
});
