import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fromLegacyTimeline, LegacyTimeline } from "../src/domain/timeline.types.js";
import { SPEC_LEXICON } from "../src/lib/planner/activeSubject.js";
import { writeTimelineV3 } from "../src/lib/compiler/timelineCompiler.js";
import { buildFlowPrompt, GENERATED_SOURCE } from "../src/lib/flowPrompt.js";
import { run } from "../src/lib/exec.js";
import { ffmpegPath } from "../src/lib/tools.js";
import { ProjectStore } from "../src/server/state/projectStore.js";
import { createEditorAPI } from "../src/server/routes/editorAPI.js";
import { recentDownloads, takeFromDownloads } from "../src/server/routes/flowBridge.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-flow-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ff = ffmpegPath();

/** A real 3 s test video (FFmpeg testsrc). */
async function video(file: string, seconds: number): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = await run(ff!, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=640x360:rate=30:duration=${seconds}`, "-pix_fmt", "yuv420p", file]);
  assert.equal(r.code, 0, r.stderr);
  return file;
}

describe("Flow prompt", () => {
  test("keeps the exact product, sets the camera, never asks for text or faces", () => {
    const p = buildFlowPrompt({ product: "Ruger Security-9", spec: "trigger", category: "pistol", sceneText: "The trigger breaks clean at about five pounds.", angle: "closeup", seconds: 3.2 });
    assert.match(p, /Ruger Security-9 pistol, exactly as in the reference image/);
    assert.match(p, /Macro close-up/);
    assert.match(p, /Focus on the trigger\./);
    assert.match(p, /about 4 seconds/, "Veo clips are 4-8 s");
    assert.match(p, /No on-screen text.*no people's faces/);
    assert.doesNotMatch(p, /\n/);
  });
});

describe("Flow round trip in the editor (reference frame -> imported video -> scene)", { skip: !ff }, () => {
  let api: ReturnType<typeof createEditorAPI>;
  const dir = path.join(tmp, "ws", "p");
  const dl = path.join(tmp, "Downloads");
  before(async () => {
    const legacy: LegacyTimeline = {
      version: 2, fps: 30, width: 1920, height: 1080, voice: await video(path.join(tmp, "media", "voice.mp4"), 6), music: { files: [], volumeDb: -18 }, motion: { sfx: false, sfxDb: -14 }, captions: { enabled: false }, logo: null,
      scenes: [
        { id: 0, startFrame: 0, endFrame: 90, motion: "none", transition: "cut", asset: { path: await video(path.join(tmp, "media", "a.mp4"), 4), kind: "video", source: "youtube_exact_model", in: 0 } },
        { id: 1, startFrame: 90, endFrame: 180, motion: "none", transition: "cut", asset: { path: await video(path.join(tmp, "media", "b.mp4"), 4), kind: "video", source: "youtube_exact_model", in: 0.5 } },
      ],
    };
    const tl = fromLegacyTimeline(legacy, { 0: "intro", 1: "the trigger breaks clean" });
    tl.scenes[1].subject = { productKey: "ruger_security-9", product: { manufacturer: "Ruger", model: "Security-9" }, spec: SPEC_LEXICON[0], confidence: 0.9, reason: "named" };
    fs.mkdirSync(dir, { recursive: true });
    writeTimelineV3(dir, tl);
    process.env.FLOW_DOWNLOADS_DIR = dl;
    api = createEditorAPI({ store: new ProjectStore(() => dir), dirOf: () => dir, validProject: () => true, render: () => {}, isBusy: () => false, categoryOf: () => "pistol" });
  });
  after(() => delete process.env.FLOW_DOWNLOADS_DIR);
  const call = async (method: string, params: Record<string, unknown>) => {
    const r = (await api.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { project: "p", ...params } }))) as { result?: any; error?: { message: string } };
    if (r.error) throw new Error(r.error.message);
    return r.result;
  };

  test("prompt + reference frame from the playhead moment of the clip", async () => {
    const r = await call("editor.flowPrompt", { clipId: "broll_1_0", angle: "orbit", atFrame: 120 });
    assert.match(r.prompt, /Ruger Security-9 pistol/);
    assert.match(r.prompt, /90-degree orbit/);
    assert.equal(r.seconds, 3);
    assert.ok(fs.existsSync(path.join(dir, "flow", r.frame)), "frame saved in flow/");
    assert.equal(api.flowAsset("p", r.frame), path.join(dir, "flow", r.frame));
    assert.equal(api.flowAsset("p", "../timeline.v3.json"), null, "no path traversal");
  });

  test("a downloaded Flow video replaces the clip, marked AI-generated; short videos get a note", async () => {
    await video(path.join(dl, "flow_ruger.mp4"), 2);
    fs.writeFileSync(path.join(dl, "notes.txt"), "x");
    assert.deepEqual(recentDownloads(12, dl).map((d) => d.name), ["flow_ruger.mp4"]);
    assert.throws(() => takeFromDownloads(dir, "..\\secret.mp4", dl), /not a video file name/);
    const rev = (await call("editor.open", {})).revision;
    const r = await call("editor.flowImport", { baseRevision: rev, clipId: "broll_1_0", from: "downloads", name: "flow_ruger.mp4", prompt: "orbit" });
    assert.match(r.note, /will loop/);
    const block = r.view.tracks.find((t: { kind: string }) => t.kind === "broll").blocks.find((b: { id: string }) => b.id === "broll_1_0");
    assert.equal(block.source, GENERATED_SOURCE);
    assert.equal(block.sourceIn, 0);
    assert.deepEqual(r.view.dirty, [1]);
  });
});
