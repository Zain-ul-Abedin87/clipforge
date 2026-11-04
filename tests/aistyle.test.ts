import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-aistyle-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");
const { paths } = await import("../src/lib/paths.js");
const A = await import("../src/lib/assets/aiStyle.js");
const P = await import("../src/lib/orchestrator/pipeline.js");
const M = await import("../src/server/routes/make.js");
const CH = "zz-aistyle-test";
const made: string[] = [];
after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(path.join(paths.channels, CH), { recursive: true, force: true });
  for (const p of made) fs.rmSync(path.join(paths.workspace, p), { recursive: true, force: true });
});
fs.mkdirSync(A.styleDir(CH), { recursive: true });
const ref = A.saveRef(CH, "harbour.png", Buffer.from("png-bytes"));
const capRef = A.saveRef(CH, "captain.jpg", Buffer.from("jpg-bytes"));

describe("AI picture style: the look is added by code", () => {
  const style = A.cleanStyle({ name: "Oil", look: "classical oil painting, warm light", avoid: "text, watermark", refs: [ref, "missing.png"], characters: [{ name: "Captain Reyes", aliases: ["the captain"], look: "old sea captain, grey beard, blue coat", ref: capRef }, { name: "", look: "dropped" }] }, CH);

  test("a style keeps only real reference files and named characters", () => {
    assert.deepEqual(style.refs, [ref]);
    assert.equal(style.characters.length, 1);
    assert.equal(style.characters[0].ref, capRef);
    assert.throws(() => A.saveAiStyle(CH, { look: "" }), /Describe the look/);
  });

  test("named characters (or their alias) get their fixed look; everyone gets the style", () => {
    assert.deepEqual(A.charactersIn("At dawn the captain looked at the sea.", style.characters).map((c) => c.name), ["Captain Reyes"]);
    assert.equal(A.charactersIn("The captainship was lost.", style.characters).length, 0, "whole words only");
    const p = A.composePrompt("A wide shot of a stormy harbour, ships pulling at their ropes.", style, style.characters);
    assert.equal(p, "A wide shot of a stormy harbour, ships pulling at their ropes. Characters: Captain Reyes: old sea captain, grey beard, blue coat. Style: classical oil painting, warm light. 16:9 composition, no text, no captions, no watermark.");
  });

  test("ComfyUI: IP-Adapter 'style transfer' only with a reference on SDXL; Flux has none", () => {
    const wf = A.comfyWorkflow("p", "text", "sd_xl_turbo_1.0_fp16.safetensors", 7, "clipforge_ref_harbour.png", { preset: "PLUS (high strength)", weight: 0.8 }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    const by = (t: string) => Object.values(wf).find((n) => n.class_type === t)!;
    assert.equal(by("LoadImage").inputs.image, "clipforge_ref_harbour.png");
    assert.equal(by("IPAdapterUnifiedLoader").inputs.preset, "PLUS (high strength)");
    assert.deepEqual(by("IPAdapter").inputs, { model: ["11", 0], ipadapter: ["11", 1], image: ["10", 0], weight: 0.8, start_at: 0, end_at: 1, weight_type: "style transfer" });
    assert.deepEqual(by("KSampler").inputs.model, ["12", 0]);
    assert.equal(by("CLIPTextEncode") && Object.values(wf).filter((n) => n.class_type === "CLIPTextEncode")[1].inputs.text, "text", "the avoid-list is the negative prompt");
    const noRef = A.comfyWorkflow("p", "", "sd_xl_turbo_1.0_fp16.safetensors", 7, null, { preset: "x", weight: 1 }) as Record<string, { class_type: string }>;
    assert.ok(!Object.values(noRef).some((n) => n.class_type.startsWith("IPAdapter")));
    const flux = A.comfyWorkflow("p", "", "flux1-schnell-Q4_K_S.gguf", 7, "x.png", { preset: "x", weight: 1 }) as Record<string, { class_type: string }>;
    assert.ok(!Object.values(flux).some((n) => n.class_type.startsWith("IPAdapter")));
  });

  test("ComfyUI generator: the reference is uploaded once, then prompt -> history -> view", async () => {
    const calls: string[] = [];
    const fake = (async (u: string, init?: RequestInit) => {
      const url = String(u);
      calls.push(`${init?.method ?? "GET"} ${url.replace("http://comfy", "")}`);
      if (url.endsWith("/upload/image")) {
        assert.ok(init?.body instanceof FormData);
        return Response.json({ name: "clipforge_ref_up.png", subfolder: "", type: "input" });
      }
      if (url.endsWith("/prompt")) {
        const wf = JSON.parse(String(init!.body)).prompt;
        assert.ok(Object.values(wf).some((n: any) => n.class_type === "LoadImage" && n.inputs.image === "clipforge_ref_up.png"));
        return Response.json({ prompt_id: "p1" });
      }
      if (url.includes("/history/")) return Response.json({ p1: { outputs: { "7": { images: [{ filename: "a.png", subfolder: "", type: "output" }] } } } });
      return new Response(Buffer.from("PNGDATA"));
    }) as unknown as typeof fetch;
    const gen = A.comfyGenerator({ url: "http://comfy", ckpt: "sd_xl_turbo_1.0_fp16.safetensors", ipadapter: true, preset: "PLUS (high strength)", weight: 0.8, fetchImpl: fake, pollMs: 1 });
    const refFile = path.join(A.styleDir(CH), ref);
    await gen("one", { refs: [refFile], seed: 1, outFile: path.join(tmp, "1.png"), avoid: "text" });
    await gen("two", { refs: [refFile], seed: 2, outFile: path.join(tmp, "2.png"), avoid: "text" });
    assert.equal(calls.filter((c) => c.includes("/upload/image")).length, 1);
    assert.equal(fs.readFileSync(path.join(tmp, "2.png"), "utf8"), "PNGDATA");
  });

  test("Gemini generator: the reference pictures go with the prompt; no picture back is an error", async () => {
    let sent: any = null;
    const client = { models: { generateContent: async (p: any) => ((sent = p), { candidates: [{ content: { parts: [{ text: "here" }, { inlineData: { data: Buffer.from("IMG").toString("base64"), mimeType: "image/png" } }] } }] }) } } as any;
    const out = path.join(tmp, "g.png");
    await A.geminiGenerator({ model: "gemini-2.5-flash-image", client })("A harbour.", { refs: [path.join(A.styleDir(CH), ref)], seed: 1, outFile: out, avoid: "text" });
    assert.equal(sent.model, "gemini-2.5-flash-image");
    assert.equal(sent.contents[0].parts[0].inlineData.mimeType, "image/png");
    assert.match(sent.contents[0].parts[1].text, /reference for the art style.*A harbour\..*Avoid: text/);
    assert.equal(fs.readFileSync(out, "utf8"), "IMG");
    const none = { models: { generateContent: async () => ({ candidates: [{ content: { parts: [{ text: "no" }] } }] }) } } as any;
    await assert.rejects(A.geminiGenerator({ model: "m", client: none })("x", { refs: [], seed: 1, outFile: path.join(tmp, "n.png"), avoid: "" }), /no picture/);
  });

  test("learning the look from the references drops artist names", async () => {
    A.saveAiStyle(CH, style);
    const r = await A.learnStyle(CH, { see: async (imgs) => (assert.equal(imgs.length, 1), { look: "thick impasto oil paint, in the style of Rembrandt van, amber light", avoid: "text" }) });
    assert.doesNotMatch(r.look, /Rembrandt/);
    assert.match(r.look, /impasto oil paint/);
  });
});

describe("AI picture style in a documentary", () => {
  test("every footage scene gets a picture in the style; assets + licence ledger written; second run reuses", async () => {
    const { project } = M.createMade({ type: "documentary", topic: "zz aistyle harbour story", minutes: 3, notes: "x", visuals: "ai", channel: CH } as never);
    made.push(project);
    const dir = path.join(paths.workspace, project);
    A.saveAiStyle(CH, { name: "Oil", look: "oil painting", avoid: "text", refs: [ref], characters: [{ name: "Captain Reyes", look: "grey beard, blue coat", ref: capRef }] });
    fs.writeFileSync(path.join(dir, "scenes.json"), JSON.stringify([
      { id: 0, start: 0, end: 4, text: "Captain Reyes reached the harbour at dawn.", type: "footage" },
      { id: 1, start: 4, end: 8, text: "Number one", type: "graphic", graphic: { kind: "title_card", title: "Chapter one", lines: [] } },
      { id: 2, start: 8, end: 13, text: "The storm came that night.", type: "footage" },
    ]));
    const gens: { prompt: string; refs: string[] }[] = [];
    const generator: import("../src/lib/assets/aiStyle.js").Generator = async (prompt, g) => (gens.push({ prompt, refs: g.refs.map((r) => path.basename(r)) }), fs.writeFileSync(g.outFile, "png"), { file: g.outFile, engine: "fake", model: "fake" });
    const ask: import("../src/lib/assets/aiStyle.js").Ask = async () => ({ scenes: [{ id: 0, shows: "A ship's captain steps onto a misty pier at dawn, wide shot" }] });
    const card = async () => { const f = path.join(dir, "card1.png"); fs.writeFileSync(f, "card"); return f; };
    const r = await A.runAiStyle(dir, { channel: CH, ask, generator, card, log: () => {} });
    assert.deepEqual([r.scenes, r.made, r.failed.length], [2, 2, 0]);
    assert.match(gens[0].prompt, /^A ship's captain steps onto a misty pier at dawn, wide shot\. Characters: Captain Reyes: grey beard, blue coat\. Style: oil painting\./);
    assert.deepEqual(gens[0].refs, [capRef, ref], "the character's own picture first");
    assert.match(gens[1].prompt, /^A scene showing: The storm came that night/, "a scene the AI skipped falls back to the narration");
    const assets = JSON.parse(fs.readFileSync(path.join(dir, "assets.json"), "utf8"));
    assert.deepEqual(Object.keys(assets).sort(), ["0", "1", "2"]);
    assert.equal(assets["1"].source, "graphic", "the card scene keeps its card");
    assert.equal(assets["0"].source, "imagegen");
    assert.equal(assets["0"].kind, "image");
    assert.match(assets["0"].license, /AI-generated picture/);
    assert.ok(fs.existsSync(path.join(dir, "licenses.json")) || fs.existsSync(path.join(dir, "license_log.csv")));
    const again = await A.runAiStyle(dir, { channel: CH, ask, generator, card, log: () => {} });
    assert.equal(again.reused, 2);
    assert.equal(gens.length, 2);
    // The pipeline: plan, then the AI pictures instead of the stock search.
    const cfg = P.readConfig(project);
    assert.deepEqual(P.stageSteps("visuals", project, cfg), [["plan", "-p", project, "--channel", CH], ["aistyle", "-p", project, "--channel", CH]]);
  });
});
