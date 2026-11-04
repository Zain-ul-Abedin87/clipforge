import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-avatar-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
process.env.LLM_SETTINGS_FILE = path.join(tmp, "llm_settings.json");

const { paths } = await import("../src/lib/paths.js");
const { ffmpegPath } = await import("../src/lib/tools.js");
const { run } = await import("../src/lib/exec.js");
const { buildArgv, ENGINES, museTalkYaml } = await import("../src/lib/avatar/engines.js");
const { planClips, withoutAvatar, channelAvatar } = await import("../src/lib/avatar/index.js");
const { avatar } = await import("../src/commands/avatar.js");
const F = await import("../src/lib/settings/features.js");
const { ledgerCategory } = await import("../src/lib/assets/licenseLedger.js");

const PROJECT = "zz_avatar_test";
const CHANNEL = "zz_avatar_test_ch";
const projDir = path.join(paths.workspace, PROJECT);
const chDir = path.join(paths.channels, CHANNEL);
after(() => {
  for (const d of [tmp, projDir, chDir]) fs.rmSync(d, { recursive: true, force: true });
});

// 20 s video: hook 0-2, intro 2-8 (scenes 2-5, 5-8), products A (8-11, 11-12) and B (12-16), outro 16-20.
const SCENES = [
  { id: 0, start: 0, end: 2, type: "broll", text: "hook" },
  { id: 1, start: 2, end: 5, type: "broll", text: "intro one" },
  { id: 2, start: 5, end: 8, type: "broll", text: "intro two" },
  { id: 3, start: 8, end: 11, type: "product", product_name: "A", text: "number two is A" },
  { id: 4, start: 11, end: 12, type: "graphic", text: "card" },
  { id: 5, start: 12, end: 16, type: "product", product_name: "B", text: "number one is B" },
  { id: 6, start: 16, end: 20, type: "broll", text: "outro" },
];
const SECTIONS = [
  { id: 0, kind: "intro", start: 0, end: 8, hookEnd: 2 },
  { id: 1, kind: "item", start: 8, end: 12, rank: 2, product_name: "A" },
  { id: 2, kind: "item", start: 12, end: 16, rank: 1, product_name: "B" },
  { id: 3, kind: "outro", start: 16, end: 20 },
];

describe("avatar planning", () => {
  test("intro after the hook, a bridge per product, the outro; whole scenes, max clip length", () => {
    const clips = planClips(SCENES, SECTIONS, ["intro", "outro", "bridge"], 15);
    assert.deepEqual(clips.map((c) => [c.kind, c.start, c.end, c.sceneIds]), [
      ["intro", 2, 8, [1, 2]],
      ["bridge", 8, 11, [3]],
      ["bridge", 12, 16, [5]],
      ["outro", 16, 20, [6]],
    ]);
    assert.deepEqual(planClips(SCENES, SECTIONS, ["intro"], 4).map((c) => c.sceneIds), [[1]], "max length cuts the run of scenes");
  });

  test("engine templates, MuseTalk task yaml, own-avatar is 'own' in the licence ledger, QA exemption", () => {
    assert.deepEqual(buildArgv(ENGINES.wav2lip.command, { python: "py", image: "C:/a b/avatar.png", audio: "x.wav", out: "o.mp4" }).slice(0, 3), ["py", "inference.py", "--checkpoint_path"]);
    assert.ok(buildArgv(ENGINES.wav2lip.command, { python: "py", image: "C:/a b/avatar.png", audio: "x.wav", out: "o.mp4" }).includes("C:/a b/avatar.png"), "a path with spaces stays one argument");
    assert.match(museTalkYaml("C:\\x\\a.png", "C:\\x\\a.wav"), /video_path: "C:\/x\/a.png"/);
    assert.equal(ledgerCategory("own-avatar"), "own");
    const talking = [{ start: 2.2, end: 4, p: 0.9 }, { start: 30, end: 32, p: 0.8 }];
    assert.deepEqual(withoutAvatar(talking, [{ start: 2, end: 8 }]), [talking[1]]);
    assert.equal(ENGINES.hallo2.slow, true);
  });
});

/**
 * End to end with FFmpeg standing in for the lip-sync engine (avatar.command): the photo + the clip
 * audio -> a talking clip. Proves the plan, one-clip-at-a-time rendering, PiP layers and the
 * timeline update without a GPU model.
 */
describe("avatar step (FFmpeg as a stand-in engine)", { skip: !ffmpegPath() }, () => {
  const ff = ffmpegPath()!;
  const setup = async (layout: "pip" | "full") => {
    fs.rmSync(projDir, { recursive: true, force: true });
    fs.mkdirSync(projDir, { recursive: true });
    fs.mkdirSync(chDir, { recursive: true });
    await run(ff, ["-y", "-f", "lavfi", "-i", "color=c=orange:s=512x512", "-frames:v", "1", path.join(chDir, "avatar.png")]);
    const voice = path.join(projDir, "voice.wav");
    await run(ff, ["-y", "-f", "lavfi", "-i", "sine=frequency=200:duration=20", "-ar", "44100", voice]);
    fs.writeFileSync(path.join(projDir, "project.json"), JSON.stringify({ name: PROJECT, audio: voice, channel: CHANNEL }));
    fs.writeFileSync(path.join(projDir, "scenes.json"), JSON.stringify(SCENES.map((s) => ({ ...s, queries: [], section: 0, labeledBy: "heuristic" }))));
    fs.writeFileSync(path.join(projDir, "sections.json"), JSON.stringify(SECTIONS));
    const tl = { version: 2, fps: 30, width: 1920, height: 1080, duration: 20, voice, music: { files: [], volumeDb: -18, duckDb: -10 }, motion: { graphics: true, sfx: false, sfxDb: -14 }, captions: { enabled: false }, scenes: SCENES.map((s) => ({ id: s.id, start: s.start, end: s.end, startFrame: s.start * 30, endFrame: s.end * 30, asset: { path: "x.mp4", kind: "video", source: "pexels" }, motion: "none", transition: "cut" })) };
    fs.writeFileSync(path.join(projDir, "timeline.json"), JSON.stringify(tl));
    F.saveFeatures({ avatar: { enabled: true, layout, placements: ["intro", "outro", "bridge"], maxClipSec: 15, command: `{ffmpeg} -hide_banner -loglevel error -y -loop 1 -i {image} -i {audio} -shortest -vf scale=256:256 -r 25 -c:v libx264 -pix_fmt yuv420p -c:a aac {out}` } });
  };

  test("picture-in-picture: 4 clips rendered one at a time, a transparent layer per covered scene", async () => {
    await setup("pip");
    assert.ok(channelAvatar(CHANNEL));
    const logs: string[] = [];
    assert.equal(await avatar({ project: PROJECT }, (m) => logs.push(m)), 0, logs.join("\n"));
    const plan = JSON.parse(fs.readFileSync(path.join(projDir, "avatar_plan.json"), "utf8"));
    assert.equal(plan.clips.length, 4);
    assert.ok(plan.clips.every((c: { file?: string }) => c.file && fs.existsSync(c.file)));
    assert.equal(plan.source, "own-avatar");
    const tl = JSON.parse(fs.readFileSync(path.join(projDir, "timeline.json"), "utf8"));
    for (const id of [1, 2, 3, 5, 6]) {
      const layer = tl.scenes.find((s: { id: number }) => s.id === id).overlays?.[0];
      assert.ok(layer?.video && fs.existsSync(layer.path), `scene ${id}`);
    }
    assert.equal(tl.scenes.find((s: { id: number }) => s.id === 0).overlays, undefined, "the hook teaser stays clean");
    // Clip ordering: one process at a time, each logged as done before the next starts.
    const order = logs.filter((l) => /clip \d\/4 \(|clip \d done/.test(l)).map((l) => (/done/.test(l) ? "done" : "start"));
    assert.deepEqual(order, ["start", "done", "start", "done", "start", "done", "start", "done"]);
    // The intro clip is the 6 s clip: its length matches the scenes.
    const probe = await run(ff.replace(/ffmpeg(\.exe)?$/i, "ffprobe$1"), ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", plan.clips[0].file]);
    assert.ok(Math.abs(Number(probe.stdout.trim()) - 6) < 0.15, probe.stdout);
  });

  test("full frame: the covered scenes show the avatar clip, tagged own-avatar", async () => {
    await setup("full");
    assert.equal(await avatar({ project: PROJECT }, () => {}), 0);
    const tl = JSON.parse(fs.readFileSync(path.join(projDir, "timeline.json"), "utf8"));
    const s2 = tl.scenes.find((s: { id: number }) => s.id === 2);
    assert.equal(s2.asset.source, "own-avatar");
    assert.equal(s2.asset.in, 3, "second intro scene starts 3 s into the intro clip");
    assert.equal(tl.scenes.find((s: { id: number }) => s.id === 0).asset.source, "pexels");
  });

  test("off by default", async () => {
    F.saveFeatures({ avatar: { enabled: false } });
    const logs: string[] = [];
    assert.equal(await avatar({ project: PROJECT }, (m) => logs.push(m)), 0);
    assert.match(logs[0], /off/);
  });
});
