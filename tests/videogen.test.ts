import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-videogen-"));
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
process.env.LLM_USAGE_FILE = path.join(tmp, "llm_usage.json");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const { fromLegacyTimeline } = await import("../src/domain/timeline.types.js");
const { SPEC_LEXICON } = await import("../src/lib/planner/activeSubject.js");
const { writeTimelineV3 } = await import("../src/lib/compiler/timelineCompiler.js");
const { run } = await import("../src/lib/exec.js");
const { ffmpegPath } = await import("../src/lib/tools.js");
const { ProjectStore } = await import("../src/server/state/projectStore.js");
const { createEditorAPI } = await import("../src/server/routes/editorAPI.js");
const P = await import("../src/lib/videogen/providers.js");
const G = await import("../src/lib/videogen/generate.js");
const SP = await import("../src/lib/videogen/prompt.js");
const E = await import("../src/lib/agents/llm/engine.js");
const { loadLlmSettings } = await import("../src/lib/agents/llm/settings.js");
const { paths } = await import("../src/lib/paths.js");
const ff = ffmpegPath();

async function video(file: string, seconds: number): Promise<string> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = await run(ff!, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc=size=640x360:rate=30:duration=${seconds}`, "-pix_fmt", "yuv420p", file]);
  assert.equal(r.code, 0, r.stderr);
  return file;
}

describe("AI engine switch (local / API / both)", () => {
  test("each choice writes primary / fallback / qwen mode, and reads back the same", () => {
    const f = process.env.LLM_SETTINGS_FILE!;
    E.setEngine("local", f);
    assert.deepEqual([loadLlmSettings(f).primary, loadLlmSettings(f).fallback, loadLlmSettings(f).qwen.mode], ["qwen", "none", "local"]);
    assert.equal(E.currentEngine(loadLlmSettings(f)), "local");
    E.setEngine("both", f);
    assert.deepEqual([loadLlmSettings(f).primary, loadLlmSettings(f).fallback], ["qwen", "claude"]);
    assert.equal(E.currentEngine(loadLlmSettings(f)), "both");
    E.setEngine("api", f);
    assert.equal(loadLlmSettings(f).primary, "claude");
    assert.equal(E.currentEngine(loadLlmSettings(f)), "api");
  });

  test("Ollama check never throws", async () => {
    assert.equal(await E.ollamaRunning("http://x/v1", (async () => new Response("{}")) as unknown as typeof fetch), true);
    assert.equal(await E.ollamaRunning("http://x", (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch), false);
  });
});

describe("scene prompt from the creator's own words", () => {
  const base = { product: "Ruger Security-9", category: "pistol", sceneText: "The trigger breaks clean.", angle: "closeup" as const, seconds: 3, realPhoto: true };
  test("the AI writes the scene; the product lock is added by code, whatever the AI said", async () => {
    const r = await SP.writeScenePrompt({ ...base, wish: "on a wooden bench at night" }, { ask: async () => "A pistol on a wooden bench at night, warm lamp light, slow push in." });
    assert.equal(r.writer, "model");
    assert.match(r.prompt, /wooden bench at night/);
    assert.match(r.prompt, /Ruger Security-9 must stay exactly as in the reference image/);
  });
  test("no AI, or a failing one: the rule-based prompt plus the wish, still locked", async () => {
    const r = await SP.writeScenePrompt({ ...base, wish: "on a wooden bench" }, { ask: async () => { throw new Error("Ollama down"); } });
    assert.equal(r.writer, "rules");
    assert.match(r.prompt, /Macro close-up/);
    assert.match(r.prompt, /Creator's direction: on a wooden bench\./);
    assert.match(r.prompt, /must stay exactly/);
    assert.equal((await SP.writeScenePrompt({ ...base, wish: "" })).writer, "rules");
    assert.equal(SP.productLock(null), "");
  });
});

describe("image-to-video providers (fake SDK clients, no paid call)", { skip: !ff }, () => {
  test("durations: the shortest accepted length that covers the scene", () => {
    const veo = P.VEO_MODELS[0];
    assert.equal(P.pickDuration(veo, 3.2), 4);
    assert.equal(P.pickDuration(veo, 6.5), 8);
    assert.equal(P.pickDuration(veo, 12), 8);
    assert.equal(P.pickDuration(P.RUNWAY_MODELS[0], 3.2), 4);
    assert.equal(P.pickDuration(P.RUNWAY_MODELS[0], 1), 2);
  });

  test("Veo: the reference image is sent as the first frame, the operation is polled, bytes are saved", async () => {
    const img = path.join(tmp, "ref.png");
    await run(ff!, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=1920x1080", "-frames:v", "1", img]);
    const sent: any[] = [];
    let polls = 0;
    const veo = {
      models: { generateVideos: async (p: any) => (sent.push(p), { done: false, name: "operations/1" }) },
      operations: { getVideosOperation: async () => (++polls < 2 ? { done: false } : { done: true, response: { generatedVideos: [{ video: { videoBytes: Buffer.alloc(5000, 1).toString("base64") } }] } }) },
      files: { download: async () => assert.fail("bytes were in the answer") },
    } as any;
    const out = path.join(tmp, "veo.mp4");
    const r = await G.generateClip({ provider: "veo", model: "veo-3.1-fast-generate-preview", prompt: "slow push in", image: img, seconds: 3, outFile: out, veo, sleep: async () => {} });
    assert.equal(r.seconds, 4);
    assert.equal(sent[0].model, "veo-3.1-fast-generate-preview");
    assert.equal(sent[0].source.prompt, "slow push in");
    assert.equal(sent[0].source.image.mimeType, "image/jpeg");
    assert.ok(sent[0].source.image.imageBytes.length > 100);
    assert.equal(sent[0].config.aspectRatio, "16:9");
    assert.equal(sent[0].config.durationSeconds, 4);
    assert.equal(polls, 2);
    assert.equal(fs.statSync(out).size, 5000);
  });

  test("Veo blocked by its filter / Runway: data-URI first frame, model limits, output downloaded", async () => {
    const img = path.join(tmp, "ref.png");
    const blocked = { models: { generateVideos: async () => ({ done: true, response: { generatedVideos: [] } }) }, operations: {}, files: {} } as any;
    await assert.rejects(G.generateClip({ provider: "veo", model: "veo-3.1-generate-preview", prompt: "p", image: img, seconds: 4, outFile: path.join(tmp, "x.mp4"), veo: blocked }), /safety filter/);
    const bodies: any[] = [];
    const runway = { imageToVideo: { create: (b: any) => (bodies.push(b), { waitForTaskOutput: async () => ({ status: "SUCCEEDED", output: ["https://cdn.example/v.mp4"] }) }) } } as any;
    const out = path.join(tmp, "rw.mp4");
    const fetchImpl = (async (u: string) => (assert.equal(u, "https://cdn.example/v.mp4"), new Response(Buffer.alloc(4000, 2)))) as unknown as typeof fetch;
    const r = await G.generateClip({ provider: "runway", model: "veo3.1_fast", prompt: "orbit", image: img, seconds: 5, outFile: out, runway, fetchImpl });
    assert.equal(r.seconds, 6);
    assert.equal(bodies[0].model, "veo3.1_fast");
    assert.equal(bodies[0].ratio, "1280:720");
    assert.equal(bodies[0].duration, 6);
    assert.match(bodies[0].promptImage, /^data:image\/jpeg;base64,/);
    assert.equal(fs.statSync(out).size, 4000);
    await assert.rejects(G.generateClip({ provider: "runway", model: "kling", prompt: "p", image: img, seconds: 4, outFile: out, runway }), /unknown runway model/);
  });
});

describe("Make it with AI, in the editor", { skip: !ff }, () => {
  const dir = path.join(tmp, "ws", "p");
  const channel = "zz-videogen-test";
  const kit = path.join(paths.channels, channel, "presskit", "ruger-security-9");
  let api: ReturnType<typeof createEditorAPI>;
  const generated: any[] = [];
  before(async () => {
    const legacy = {
      version: 2, fps: 30, width: 1920, height: 1080, voice: await video(path.join(tmp, "media", "voice.mp4"), 6), music: { files: [], volumeDb: -18 }, motion: { sfx: false, sfxDb: -14 }, captions: { enabled: false }, logo: null,
      scenes: [
        { id: 0, startFrame: 0, endFrame: 90, motion: "none", transition: "cut", asset: { path: await video(path.join(tmp, "media", "a.mp4"), 4), kind: "video", source: "youtube_exact_model", in: 0 } },
        { id: 1, startFrame: 90, endFrame: 180, motion: "none", transition: "cut", asset: { path: await video(path.join(tmp, "media", "b.mp4"), 4), kind: "video", source: "youtube_exact_model", in: 0.5 } },
      ],
    } as any;
    const tl = fromLegacyTimeline(legacy, { 0: "intro", 1: "the trigger breaks clean" });
    tl.scenes[1].subject = { productKey: "ruger_security-9", product: { manufacturer: "Ruger", model: "Security-9" }, spec: SPEC_LEXICON[0], confidence: 0.9, reason: "named" };
    fs.mkdirSync(dir, { recursive: true });
    writeTimelineV3(dir, tl);
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ channel }));
    fs.mkdirSync(kit, { recursive: true });
    await run(ff!, ["-v", "error", "-y", "-f", "lavfi", "-i", "color=c=blue:s=800x600", "-frames:v", "1", path.join(kit, "official.jpg")]);
    api = createEditorAPI({
      store: new ProjectStore(() => dir), dirOf: () => dir, validProject: () => true, render: () => {}, isBusy: () => false, categoryOf: () => "pistol", musicLibrary: () => [],
      generate: async (o) => (generated.push(o), await video(o.outFile, 4), { file: o.outFile, seconds: 4, model: o.model }),
    });
  });
  after(() => fs.rmSync(path.join(paths.channels, channel), { recursive: true, force: true }));
  const call = async (method: string, params: Record<string, unknown>) => {
    const r = (await api.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { project: "p", ...params } }))) as { result?: any; error?: { message: string } };
    if (r.error) throw new Error(r.error.message);
    return r.result;
  };

  test("options: the scene's product, its real photos, which video APIs are ready and why not", async () => {
    const o = await call("editor.genOptions", { clipId: "broll_1_0" });
    assert.equal(o.product, "Ruger Security-9");
    assert.deepEqual(o.photos.map((p: any) => p.id), ["ruger-security-9/official.jpg"]);
    assert.ok(o.video.some((v: any) => v.id === "flow" && v.ready));
    const veo = o.video.find((v: any) => v.id === "veo");
    assert.equal(veo.ready, !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY));
  });

  test("a real product photo becomes the first frame; paid calls need a yes; the result is swapped in as AI-generated", async () => {
    const pr = await call("editor.genPrompt", { clipId: "broll_1_0", angle: "orbit", wish: "on a workbench", photo: "ruger-security-9/official.jpg" });
    assert.match(pr.frame, /^photo_ruger-security-9_official\.jpg$/);
    assert.match(pr.prompt, /must stay exactly as in the reference image/);
    await assert.rejects(call("editor.genPrompt", { clipId: "broll_1_0", photo: "../../etc/passwd" }), /not in this product's press kit/);
    process.env.RUNWAYML_API_SECRET = "test-key";
    try {
      await assert.rejects(call("editor.generate", { clipId: "broll_1_0", provider: "runway", model: "gen4.5", prompt: pr.prompt, frame: pr.frame }), /paid API call: confirm/);
      await assert.rejects(call("editor.generate", { clipId: "broll_1_0", provider: "runway", model: "sora", prompt: pr.prompt, frame: pr.frame, confirmPaid: true }), /unknown runway model/);
      const { jobId } = await call("editor.generate", { clipId: "broll_1_0", provider: "runway", model: "gen4.5", prompt: pr.prompt, frame: pr.frame, confirmPaid: true });
      let j: any;
      for (let i = 0; i < 100; i++) {
        j = await call("editor.job", { jobId });
        if (j.state !== "running") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.equal(j.state, "done", j.error ?? "");
      assert.equal(generated[0].image, path.join(dir, "flow", pr.frame));
      assert.equal(generated[0].model, "gen4.5");
      const v = await call("editor.open", {});
      const block = v.tracks.flatMap((t: any) => t.blocks).find((b: any) => b.id === "broll_1_0" || b.sceneId === 1);
      assert.ok(block);
      const tl = JSON.parse(fs.readFileSync(path.join(dir, "timeline.v3.json"), "utf8"));
      const clip = tl.tracks.flatMap((t: any) => t.clips).find((c: any) => c.id === "broll_1_0");
      assert.match(clip.media.path, /gen_broll_1_0_\d+\.mp4$/);
    } finally {
      delete process.env.RUNWAYML_API_SECRET;
    }
  });
});
