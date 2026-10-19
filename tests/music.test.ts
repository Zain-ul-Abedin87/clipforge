import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { duckGraph } from "../src/audio/duck.js";
import { fromLegacyTimeline, LegacyTimeline } from "../src/domain/timeline.types.js";
import { compileTimeline, writeTimelineV3 } from "../src/lib/compiler/timelineCompiler.js";
import { libraryTracks, parseMusicChoice, resolveMusic, trackLicense, trackPath } from "../src/lib/music.js";
import { checkMusicLicenses } from "../src/lib/qaGate.js";
import { ProjectStore } from "../src/server/state/projectStore.js";
import { createEditorAPI } from "../src/server/routes/editorAPI.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-music-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const touch = (f: string) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, "x"), f);

describe("per-video music choice", () => {
  const channelDir = path.join(tmp, "channel");
  const lib = path.join(channelDir, "music");
  const style = { music: { enabled: false, volumeDb: -22 } };
  beforeEach(() => {
    fs.rmSync(channelDir, { recursive: true, force: true });
    touch(path.join(lib, "b-calm.mp3"));
    touch(path.join(lib, "a-drive.wav"));
    touch(path.join(lib, "notes.txt"));
    fs.writeFileSync(path.join(lib, "sources.json"), JSON.stringify({ "a-drive.wav": { license: "CC0 - freemusicarchive" } }));
  });

  test("a client's choice is validated: unknown modes, path tricks and out-of-range levels are dropped", () => {
    assert.deepEqual(parseMusicChoice(undefined), { mode: "default" });
    assert.deepEqual(parseMusicChoice({ mode: "off" }), { mode: "off" });
    assert.deepEqual(parseMusicChoice({ mode: "track", track: "a-drive.wav", volumeDb: -20, duck: false }), { mode: "track", track: "a-drive.wav", volumeDb: -20, duck: false });
    assert.deepEqual(parseMusicChoice({ mode: "track", track: "../secret.mp3" }), { mode: "default" });
    assert.deepEqual(parseMusicChoice({ mode: "track", track: "notes.txt" }), { mode: "default" });
    assert.deepEqual(parseMusicChoice({ mode: "bogus", volumeDb: 12 }), { mode: "default" });
  });

  test("default follows the channel; off and a chosen track override it", () => {
    const base = { style, channelDir };
    const dflt = resolveMusic({ ...base, defaultEnabled: false, choice: { mode: "default" } });
    assert.deepEqual([dflt.files, dflt.volumeDb, dflt.duck], [[], -22, true]);
    const playlist = resolveMusic({ ...base, defaultEnabled: true, choice: { mode: "default" } });
    assert.deepEqual(playlist.files.map((f) => path.basename(f)), ["a-drive.wav", "b-calm.mp3"]);
    assert.deepEqual(resolveMusic({ ...base, defaultEnabled: true, choice: { mode: "off" } }).files, []);
    const one = resolveMusic({ ...base, defaultEnabled: false, choice: { mode: "track", track: "b-calm.mp3", volumeDb: -15, duck: false } });
    assert.deepEqual([one.files.map((f) => path.basename(f)), one.volumeDb, one.duck], [["b-calm.mp3"], -15, false]);
    const gone = resolveMusic({ ...base, defaultEnabled: true, choice: { mode: "track", track: "deleted.mp3" } });
    assert.deepEqual(gone.files, []);
    assert.match(gone.note, /not in the channel library/);
  });

  test("library helpers: audio files only, licence notes, no path traversal", () => {
    assert.deepEqual(libraryTracks(lib), ["a-drive.wav", "b-calm.mp3"]);
    assert.equal(trackPath(lib, "a-drive.wav"), path.join(lib, "a-drive.wav"));
    assert.equal(trackPath(lib, "../channel/music/a-drive.wav"), null);
    assert.equal(trackLicense(lib, "a-drive.wav"), "CC0 - freemusicarchive");
    assert.equal(trackLicense(lib, "b-calm.mp3"), "");
  });

  test("QA: a track without a licence note warns; no music means no check", () => {
    assert.equal(checkMusicLicenses([]), null);
    assert.equal(checkMusicLicenses([{ name: "a.wav", license: "CC0" }])?.status, "pass");
    const w = checkMusicLicenses([{ name: "a.wav", license: "CC0" }, { name: "b.mp3", license: "  " }]);
    assert.equal(w?.status, "warn");
    assert.match(w!.detail, /b\.mp3/);
  });
});

describe("music mix graph", () => {
  const o = { voiceChain: "[1:a]aresample=48000", musicIn: "[2:a]", duration: 60, volumeDb: -20, out: "pre" };

  test("default: ducked under the voice with a 2 s fade in and 3 s fade out", () => {
    const g = duckGraph(o);
    assert.match(g, /sidechaincompress/);
    assert.match(g, /volume=-20dB/);
    assert.match(g, /afade=t=in:d=2,afade=t=out:st=57\.000:d=3/);
  });

  test("duck off: plain mix; fade 0 leaves the fade out of the chain; fades never exceed the video", () => {
    const g = duckGraph({ ...o, duck: false, fadeInSec: 0, fadeOutSec: 5 });
    assert.doesNotMatch(g, /sidechaincompress/);
    assert.doesNotMatch(g, /afade=t=in/);
    assert.match(g, /afade=t=out:st=55\.000:d=5/);
    assert.match(g, /amix=inputs=2/);
    assert.match(duckGraph({ ...o, duration: 2, fadeOutSec: 9 }), /afade=t=out:st=0\.000:d=2/);
  });
});

describe("music on the studio timeline", () => {
  const dir = path.join(tmp, "ws", "p");
  let store: ProjectStore;
  const bed = (name: string) => touch(path.join(tmp, "lib", name));
  const music = (s: ProjectStore) => s.get("p").tl.tracks.find((t) => t.kind === "music")!.clips;

  beforeEach(() => {
    const legacy: LegacyTimeline = {
      version: 2, fps: 30, width: 1920, height: 1080, voice: touch(path.join(tmp, "media", "voice.wav")), music: { files: [], volumeDb: -18 }, motion: { sfx: false, sfxDb: -14 }, captions: { enabled: false }, logo: null,
      scenes: [{ id: 0, startFrame: 0, endFrame: 90, motion: "none", transition: "cut", asset: { path: touch(path.join(tmp, "media", "a.png")), kind: "image", source: "local" } }],
    };
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    writeTimelineV3(dir, fromLegacyTimeline(legacy, { 0: "intro" }));
    store = new ProjectStore(() => dir);
  });

  test("add, edit and remove the bed; compile carries level, ducking and fades", () => {
    assert.equal(compileTimeline(store.get("p").tl).audio.music.files.length, 0);
    store.apply("p", null, [{ op: "setMusic", path: bed("calm.mp3") }]);
    assert.equal(music(store).length, 1);
    let m = compileTimeline(store.get("p").tl).audio.music;
    assert.deepEqual([m.volumeDb, m.duck, m.fadeInSec, m.fadeOutSec], [-18, true, 2, 3]);

    store.apply("p", null, [{ op: "setAudio", clipId: music(store)[0].id, gainDb: -26, duck: false, fadeInSec: 0, fadeOutSec: 6 }]);
    m = compileTimeline(store.get("p").tl).audio.music;
    assert.deepEqual([m.volumeDb, m.duck, m.fadeInSec, m.fadeOutSec], [-26, false, 0, 6]);

    // Another track keeps the adjusted settings.
    store.apply("p", null, [{ op: "setMusic", path: bed("drive.mp3") }]);
    assert.equal(music(store).length, 1);
    m = compileTimeline(store.get("p").tl).audio.music;
    assert.deepEqual([m.files.map((f) => path.basename(f)), m.volumeDb, m.duck], [["drive.mp3"], -26, false]);

    store.apply("p", null, [{ op: "setMusic", path: null }]);
    assert.equal(music(store).length, 0);
  });

  test("invalid levels and non-music clips are rejected without changing anything", () => {
    store.apply("p", null, [{ op: "setMusic", path: bed("calm.mp3") }]);
    const id = music(store)[0].id;
    const rev = store.get("p").revision;
    assert.throws(() => store.apply("p", rev, [{ op: "setAudio", clipId: id, gainDb: 6 }]), /level \(dB\) must be between/);
    assert.throws(() => store.apply("p", rev, [{ op: "setAudio", clipId: id, fadeOutSec: 60 }]), /fade out/);
    assert.throws(() => store.apply("p", rev, [{ op: "setAudio", clipId: "voice_0", gainDb: -10 }]), /only music clips/);
    store.apply("p", rev, [{ op: "setLocked", clipId: id, locked: true }]);
    assert.throws(() => store.apply("p", null, [{ op: "setAudio", clipId: id, gainDb: -30 }]), /locked/);
    assert.equal(store.get("p").tl.tracks.find((t) => t.kind === "music")!.clips[0].kind === "audio" && (music(store)[0] as { gainDb: number }).gainDb, -18);
  });

  test("music edits mark the render as pending (no scene is dirty); undo restores the state", () => {
    assert.equal(store.get("p").audioDirty, false);
    store.apply("p", null, [{ op: "setMusic", path: bed("calm.mp3") }]);
    assert.deepEqual([store.get("p").audioDirty, store.get("p").dirty], [true, []]);
    assert.equal(store.takeDirty("p").length, 0);
    assert.equal(store.get("p").audioDirty, false, "a render request clears it");
    store.undo("p", null);
    assert.equal(store.get("p").audioDirty, true, "undoing the music is an edit too");
    assert.equal(music(store).length, 0);
  });

  test("RPC: the library comes from the server; a client can only name a track", async () => {
    const lib = [{ name: "calm.mp3", path: bed("calm.mp3"), license: "CC0", bytes: 1 }];
    const api = createEditorAPI({ store, dirOf: () => dir, validProject: () => true, render: () => {}, isBusy: () => false, categoryOf: () => "pistol", musicLibrary: () => lib });
    const call = async (method: string, params: Record<string, unknown>) => (await api.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { project: "p", ...params } }))) as { result?: any; error?: { message: string } };
    assert.deepEqual((await call("editor.musicList", {})).result.tracks, [{ name: "calm.mp3", license: "CC0", bytes: 1 }]);
    const rev = (await call("editor.open", {})).result.revision;
    const set = await call("editor.musicSet", { baseRevision: rev, track: "calm.mp3" });
    const block = set.result.view.tracks.find((t: { kind: string }) => t.kind === "music").blocks[0];
    assert.deepEqual([block.label, block.gainDb, block.duck], ["calm.mp3", -18, true]);
    assert.match(block.media, /\/api\/editor\/media\?project=p&clip=music_0/);
    assert.equal(set.result.view.audioDirty, true);
    assert.equal(api.media("p", "music_0"), lib[0].path);
    assert.equal(api.media("p", "voice_0"), null, "only the music bed is streamed, not the voice file");
    assert.match((await call("editor.musicSet", { baseRevision: set.result.revision, track: "../x.mp3" })).error!.message, /not in this channel's music library/);
    const none = await call("editor.musicSet", { baseRevision: set.result.revision, track: null });
    assert.equal(none.result.view.tracks.find((t: { kind: string }) => t.kind === "music").blocks.length, 0);
  });
});
