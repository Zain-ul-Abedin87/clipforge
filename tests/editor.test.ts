import { after, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as R from "../src/domain/rational.math.js";
import { clipEnd, fromLegacyTimeline, LegacyTimeline } from "../src/domain/timeline.types.js";
import { SPEC_LEXICON } from "../src/lib/planner/activeSubject.js";
import { compileTimeline, writeTimelineV3, V3_FILE } from "../src/lib/compiler/timelineCompiler.js";
import { remapWords } from "../src/commands/render.js";
import { EditError, ProjectStore } from "../src/server/state/projectStore.js";
import { createEditorAPI, RPC, RpcResponse } from "../src/server/routes/editorAPI.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-editor-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const touch = (f: string) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, "x"), f);

const media = (n: string) => touch(path.join(tmp, "media", n));
function makeProject(name: string): string {
  const dir = path.join(tmp, "ws", name);
  fs.mkdirSync(dir, { recursive: true });
  const legacy: LegacyTimeline = {
    version: 2, fps: 30, width: 1920, height: 1080, voice: media("voice.wav"), music: { files: [], volumeDb: -18 }, motion: { sfx: true, sfxDb: -14 }, captions: { enabled: false }, logo: null,
    scenes: [
      { id: 0, startFrame: 0, endFrame: 90, motion: "zoom_in", transition: "cut", asset: { path: media("a.png"), kind: "image", source: "local" }, overlays: [{ path: media("t.png"), delay: 0.5, anim: "slide_up", out: 2 }], sfx: [{ kind: "whoosh", at: 0 }] },
      {
        id: 1, startFrame: 90, endFrame: 180, motion: "none", transition: "cut",
        asset: { path: media("v1.mp4"), kind: "video", source: "youtube_exact_model", shots: [{ path: media("v1.mp4"), kind: "video", in: 2, frames: 45 }, { path: media("v2.mp4"), kind: "video", in: 1, frames: 45 }] },
      },
    ],
  };
  const tl = fromLegacyTimeline(legacy, { 0: "intro", 1: "the steel deck is welded" });
  const deck = SPEC_LEXICON.find((s) => s.spec === "deck")!;
  tl.scenes[1].subject = { productKey: "scag_turf-tiger-ii", product: { manufacturer: "Scag", model: "Turf Tiger II" }, spec: deck, confidence: 0.95, reason: "named" };
  writeTimelineV3(dir, tl);
  return dir;
}

const fr = (r: R.Rational) => Number(R.secondsToFrame(r, R.FPS_30));
const broll = (store: ProjectStore, p: string) => store.get(p).tl.tracks.find((t) => t.kind === "broll")!.clips;

describe("project store: frame-exact, validated, atomic edits", () => {
  let store: ProjectStore;
  beforeEach(() => {
    makeProject("p");
    store = new ProjectStore((n) => path.join(tmp, "ws", n));
  });

  test("moving the cut between two pictures shifts the next picture's in-point with it", () => {
    const r0 = store.get("p").revision;
    const r = store.apply("p", r0, [{ op: "trimEnd", clipId: "broll_1_0", endFrame: 150 }]);
    assert.equal(r.revision, r0 + 1);
    assert.deepEqual(r.touched, [1]);
    const [, a, b] = broll(store, "p");
    assert.deepEqual([fr(a.start), fr(a.duration), fr(b.start), fr(b.duration)], [90, 60, 150, 30]);
    assert.ok(b.kind === "video" && R.eq(b.media.sourceIn, R.parseRational("1.5")), "next clip starts 15 frames later in its source");
    assert.deepEqual(store.get("p").dirty, [1]);
  });

  test("a rejected edit changes nothing (state and file)", () => {
    const file = path.join(tmp, "ws", "p", V3_FILE);
    const before = fs.readFileSync(file, "utf8");
    const rev = store.get("p").revision;
    assert.throws(() => store.apply("p", rev, [{ op: "trimEnd", clipId: "broll_1_0", endFrame: 178 }]), /edge must stay between/);
    assert.throws(() => store.apply("p", rev, [{ op: "trimEnd", clipId: "broll_1_1", endFrame: 170 }]), /last picture of a scene/);
    assert.throws(() => store.apply("p", rev, [{ op: "moveClip", clipId: "broll_0_0", startFrame: 10 }]), /cannot be moved/);
    assert.throws(() => store.apply("p", rev, [{ op: "deleteClip", clipId: "broll_0_0" }]), /needs a picture/);
    assert.throws(() => store.apply("p", rev, [{ op: "bogus", clipId: "broll_0_0" } as never]), /unknown edit/);
    // All-or-nothing: a valid edit followed by an invalid one is not half-applied.
    assert.throws(() => store.apply("p", rev, [{ op: "trimEnd", clipId: "broll_1_0", endFrame: 150 }, { op: "deleteClip", clipId: "voice_0" }]));
    assert.equal(store.get("p").revision, rev);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  });

  test("split, delete (neighbour takes the time), overlays move and trim", () => {
    let rev = store.get("p").revision;
    rev = store.apply("p", rev, [{ op: "splitClip", clipId: "broll_0_0", atFrame: 40 }]).revision;
    let [a, b] = broll(store, "p");
    assert.deepEqual([a.id, fr(a.duration), b.id, fr(b.start), fr(b.duration)], ["broll_0_0", 40, "broll_0_0_s1", 40, 50]);
    rev = store.apply("p", rev, [{ op: "deleteClip", clipId: "broll_0_0_s1" }]).revision;
    [a] = broll(store, "p");
    assert.equal(fr(a.duration), 90, "previous picture covers the deleted one's time");
    rev = store.apply("p", rev, [{ op: "moveClip", clipId: "overlay_0_0", startFrame: 100 }, { op: "trimEnd", clipId: "overlay_0_0", endFrame: 130 }]).revision;
    const ov = store.get("p").tl.tracks.find((t) => t.kind === "overlay")!.clips[0];
    assert.deepEqual([fr(ov.start), fr(ov.duration), ov.sceneId], [100, 30, 1], "overlay moved into scene 1");
  });

  test("stale revisions conflict; undo / redo; locks", () => {
    const rev = store.get("p").revision;
    store.apply("p", rev, [{ op: "trimEnd", clipId: "broll_1_0", endFrame: 120 }]);
    assert.throws(() => store.apply("p", rev, [{ op: "trimEnd", clipId: "broll_1_0", endFrame: 140 }]), (e: EditError) => e.code === "conflict");
    const r2 = store.undo("p", null);
    assert.equal(fr(broll(store, "p")[1].duration), 45);
    store.redo("p", r2);
    assert.equal(fr(broll(store, "p")[1].duration), 30);
    const r3 = store.get("p").revision;
    store.apply("p", r3, [{ op: "setLocked", clipId: "broll_1_1", locked: true }]);
    assert.throws(() => store.apply("p", null, [{ op: "trimEnd", clipId: "broll_1_0", endFrame: 140 }]), /locked/);
  });

  test("an outside change to timeline.v3.json is picked up", () => {
    const r = store.get("p").revision;
    const file = path.join(tmp, "ws", "p", V3_FILE);
    const tl = JSON.parse(fs.readFileSync(file, "utf8"));
    tl.scenes[0].text = "changed elsewhere";
    fs.writeFileSync(file, JSON.stringify(tl));
    const t = new Date(Date.now() + 3000);
    fs.utimesSync(file, t, t);
    const g = store.get("p");
    assert.equal(g.tl.scenes[0].text, "changed elsewhere");
    assert.ok(g.revision > r);
  });

  test("cut out a part (ripple): voice, pictures, cards and scenes close the gap; render plays the kept voice", () => {
    const rev = store.get("p").revision;
    const r = store.apply("p", rev, [{ op: "cutRange", fromFrame: 60, toFrame: 120 }]);
    assert.deepEqual(r.touched.sort(), [0, 1]);
    const { tl } = store.get("p");
    assert.equal(fr(tl.duration), 120);
    assert.deepEqual(tl.scenes.map((s) => [s.id, fr(s.start), fr(s.duration)]), [[0, 0, 60], [1, 60, 60]]);
    const pics = broll(store, "p").map((c) => [c.id, fr(c.start), fr(c.duration), c.kind === "video" ? R.toNumber(c.media.sourceIn) : -1]);
    assert.deepEqual(pics, [["broll_0_0", 0, 60, 0], ["broll_1_0", 60, 15, 3], ["broll_1_1", 75, 45, 1]]);
    const voice = tl.tracks.find((t) => t.kind === "voiceover")!.clips.map((c) => [fr(c.start), fr(c.duration), c.kind === "audio" ? R.toNumber(c.media.sourceIn) : -1]);
    assert.deepEqual(voice, [[0, 60, 0], [60, 60, 4]]);
    const card = tl.tracks.find((t) => t.kind === "overlay")!.clips[0];
    assert.deepEqual([fr(card.start), fr(clipEnd(card))], [15, 60]);
    const c = compileTimeline(tl);
    assert.equal(c.totalFrames, 120);
    assert.deepEqual(c.audio.voiceParts, [{ in: 0, dur: 2 }, { in: 4, dur: 2 }]);
    // Captions follow: a word at 4.5 s in the voice file is now at 2.5 s; one inside the cut is gone.
    assert.deepEqual(remapWords([{ start: 1, end: 1.4 }, { start: 3, end: 3.3 }, { start: 4.5, end: 4.9 }], c.audio.voiceParts), [{ start: 1, end: 1.4 }, { start: 2.5, end: 2.9 }]);
    assert.throws(() => store.apply("p", store.get("p").revision, [{ op: "cutRange", fromFrame: 0, toFrame: 110 }]), /at least 1 second/);
    store.undo("p", store.get("p").revision);
    assert.equal(fr(store.get("p").tl.duration), 180);
    assert.equal(compileTimeline(store.get("p").tl).audio.voiceParts, undefined);
  });

  test("transitions live on the scene's first picture; the previous scene re-renders too (fade out)", () => {
    const r = store.apply("p", store.get("p").revision, [{ op: "setTransition", clipId: "broll_1_1", transition: "fade" }]);
    assert.deepEqual(r.touched.sort(), [0, 1]);
    const first = broll(store, "p").find((c) => c.id === "broll_1_0")!;
    assert.ok(first.kind === "video" && first.transitionIn === "fade");
    assert.equal(compileTimeline(store.get("p").tl).scenes[1].transition, "fade");
    assert.throws(() => store.apply("p", store.get("p").revision, [{ op: "setTransition", clipId: "broll_1_0", transition: "spin" as never }]), /must be one of/);
  });
});

describe("editor JSON-RPC API", () => {
  const vaultRoot = path.join(tmp, "vaults");
  const vdir = path.join(vaultRoot, "scag_turf-tiger-ii");
  const item = (id: string, keyword?: string) => {
    touch(path.join(vdir, "clips", `${id}.mp4`));
    return { id: `${id}_v`, kind: "video", file: `clips/${id}.mp4`, url: `https://www.youtube.com/watch?v=${id}`, videoId: id, title: "Scag Turf Tiger II", channel: "Scag Power", start: 0, end: 4, clipPositive: 0.3, clipNegative: 0.1, feature: keyword ?? null, width: 1920, height: 1080, duration: 4, ...(keyword ? { keyword } : {}), addedAt: "t" };
  };
  const writeVault = (items: unknown[]) =>
    fs.writeFileSync(path.join(vdir, "manifest.json"), JSON.stringify({ brand: "Scag", model: "Turf Tiger II", category: "lawn mower", features: [], updatedAt: "", items, processed: {}, rejectedVideos: [], stats: { shotsScored: 0, talkingHeads: 0, offTopic: 0, kept: 0 } }));

  let busy = false;
  let rendered: string[] = [];
  const mk = () => {
    makeProject("q");
    fs.mkdirSync(vdir, { recursive: true });
    writeVault([item("aaa"), item("bbb", "deck")]);
    rendered = [];
    return createEditorAPI({
      store: new ProjectStore((n) => path.join(tmp, "ws", n)),
      dirOf: (n) => path.join(tmp, "ws", n),
      validProject: (n) => /^[\w-]+$/.test(n),
      render: (n) => rendered.push(n),
      isBusy: () => busy,
      categoryOf: () => "lawn mower",
      vaultRoot,
      harvestModel: async () => ({ added: 0 }),
      harvestKeyword: async (o) => {
        // A real harvest would download; here a new deck clip appears in the vault.
        const m = JSON.parse(fs.readFileSync(path.join(vdir, "manifest.json"), "utf8"));
        writeVault([...m.items, item("ccc", o.keyword)]);
        o.log?.("[harvest] +1 shot(s)");
        return { added: 1 };
      },
    });
  };
  const call = async (api: ReturnType<typeof createEditorAPI>, method: string, params: Record<string, unknown> = {}, id: number | undefined = 1) =>
    (await api.handle(JSON.stringify({ jsonrpc: "2.0", method, params: { project: "q", ...params }, ...(id === undefined ? {} : { id }) }))) as RpcResponse;

  test("protocol: parse errors, invalid requests, unknown methods, batches, notifications", async () => {
    const api = mk();
    assert.equal(((await api.handle("{oops")) as RpcResponse).error?.code, RPC.PARSE);
    assert.equal(((await api.handle(JSON.stringify({ method: "editor.open" }))) as RpcResponse).error?.code, RPC.INVALID_REQUEST);
    assert.equal((await call(api, "editor.nope")).error?.code, RPC.NOT_FOUND_METHOD);
    assert.equal((await call(api, "editor.open", { project: "../etc" })).error?.code, RPC.INVALID_PARAMS);
    const batch = (await api.handle(JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "editor.open", params: { project: "q" } }, { jsonrpc: "2.0", method: "editor.open", params: { project: "q" } }]))) as RpcResponse[];
    assert.equal(batch.length, 1, "the notification gets no response");
    const v = batch[0].result as { tracks: { kind: string; blocks: { startFrame: number; frames: number; thumb?: string }[] }[]; scenes: { subject: { product: string; spec: string } }[]; totalFrames: number };
    assert.equal(v.totalFrames, 180);
    assert.deepEqual(v.scenes[1].subject, { product: "Scag Turf Tiger II", spec: "deck", reason: "named" });
    assert.deepEqual(v.tracks.find((t) => t.kind === "broll")!.blocks.map((b) => [b.startFrame, b.frames]), [[0, 90], [90, 45], [135, 45]]);
    assert.ok(v.tracks.find((t) => t.kind === "broll")!.blocks[0].thumb!.startsWith("/api/editor/thumb?project=q"));
  });

  test("edits: conflict and busy codes; media can never be set to a client path", async () => {
    const api = mk();
    const open = (await call(api, "editor.open")).result as { revision: number };
    const ok = await call(api, "editor.edit", { baseRevision: open.revision, ops: [{ op: "trimEnd", clipId: "broll_1_0", endFrame: 120 }] });
    assert.ok(ok.result);
    assert.equal((await call(api, "editor.edit", { baseRevision: open.revision, ops: [] })).error?.code, RPC.CONFLICT);
    const evil = await call(api, "editor.edit", { ops: [{ op: "replaceMedia", clipId: "broll_1_0", media: { path: "C:/Windows/win.ini", kind: "image" }, provenance: { source: "x" } }] });
    assert.equal(evil.error?.code, RPC.INVALID_PARAMS);
    assert.equal((await call(api, "editor.edit", { ops: [{ op: "deleteClip", clipId: "broll_0_0" }] })).error?.code, RPC.EDIT_REJECTED);
    busy = true;
    assert.equal((await call(api, "editor.edit", { ops: [] })).error?.code, RPC.BUSY);
    busy = false;
  });

  test("candidates for the scene's product, spec first; replace by candidate id only", async () => {
    const api = mk();
    const c = (await call(api, "editor.candidates", { clipId: "broll_1_0" })).result as { product: string; keyword: string; items: { id: string; keyword?: string; used: boolean }[] };
    assert.deepEqual([c.product, c.keyword], ["Scag Turf Tiger II", "deck"]);
    assert.equal(c.items[0].id, "bbb_v", "the clip cut around the spoken spec ranks first");
    assert.equal((await call(api, "editor.candidates", { clipId: "broll_0_0" })).result && ((await call(api, "editor.candidates", { clipId: "broll_0_0" })).result as { items: unknown[] }).items.length, 0, "scene without a product subject");
    assert.equal((await call(api, "editor.replace", { clipId: "broll_1_0", candidateId: "nope" })).error?.code, RPC.NOT_FOUND);
    const r = (await call(api, "editor.replace", { clipId: "broll_1_0", candidateId: "bbb_v" })).result as { touched: number[]; view: { tracks: { kind: string; blocks: { keyword?: string; verified?: boolean }[] }[]; dirty: number[] } };
    assert.deepEqual(r.touched, [1]);
    const b = r.view.tracks.find((t) => t.kind === "broll")!.blocks[1];
    assert.deepEqual([b.keyword, b.verified], ["deck", true]);
    assert.deepEqual(r.view.dirty, [1]);
    const again = (await call(api, "editor.candidates", { clipId: "broll_1_1" })).result as { items: { id: string; used: boolean }[] };
    assert.equal(again.items.find((i) => i.id === "bbb_v")!.used, true);
  });

  test("Fetch New Clip: harvest, then the new unused clip is hot-swapped in; render request clears edited scenes", async () => {
    const api = mk();
    const { jobId } = (await call(api, "editor.fetchNewClip", { clipId: "broll_1_1" })).result as { jobId: string };
    let job: { state: string; result: { candidateId: string; added: number } | null; log: string[] };
    for (let i = 0; i < 50; i++) {
      job = (await call(api, "editor.job", { jobId })).result as typeof job;
      if (job.state !== "running") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(job!.state, "done", job!.log.join("\n"));
    assert.equal(job!.result!.candidateId, "ccc_v", "the clip the harvest just added wins");
    assert.equal(job!.result!.added, 1);
    const v = (await call(api, "editor.open")).result as { tracks: { kind: string; blocks: { label: string }[] }[]; dirty: number[] };
    assert.equal(v.tracks.find((t) => t.kind === "broll")!.blocks[2].label, "deck");
    const r = (await call(api, "editor.render")).result as { editedScenes: number[] };
    assert.deepEqual(r.editedScenes, [1]);
    assert.deepEqual(rendered, ["q"]);
    assert.deepEqual(((await call(api, "editor.open")).result as { dirty: number[] }).dirty, []);
  });

  test("Fetch New Clip refuses scenes without a product subject", async () => {
    const api = mk();
    const { jobId } = (await call(api, "editor.fetchNewClip", { clipId: "broll_0_0" })).result as { jobId: string };
    await new Promise((r) => setTimeout(r, 50));
    const job = (await call(api, "editor.job", { jobId })).result as { state: string; error: string };
    assert.equal(job.state, "failed");
    assert.match(job.error, /no product subject/);
  });
});
