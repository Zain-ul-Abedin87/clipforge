import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-stills-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
const S = await import("../src/lib/assets/stillPolish.js");
const { FEATURE_DEFAULTS } = await import("../src/lib/settings/features.js");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const photo = path.join(tmp, "p.jpg");
fs.writeFileSync(photo, "jpeg bytes");
const on = { ...FEATURE_DEFAULTS.stills, cutout: true, upscale: true, realesrgan: path.join(tmp, "realesrgan"), pythonCmd: "py" };
fs.writeFileSync(on.realesrgan, "");

/** Fake tools: realesrgan writes -o, still_polish.py writes its output and prints a JSON line. */
const tools = (cut: { ok: boolean; cover: number; reason?: string } | "crash") => {
  const calls: string[][] = [];
  const runner: import("../src/lib/assets/stillPolish.js").Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === on.realesrgan) {
      fs.writeFileSync(args[args.indexOf("-o") + 1], "up");
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cut === "crash") return { code: 3, stdout: '{"ok": false, "reason": "rembg is not installed"}', stderr: "" };
    if (cut.ok) fs.writeFileSync(args[2], "cut");
    return { code: 0, stdout: JSON.stringify(cut) + "\n", stderr: "" };
  };
  return { calls, runner };
};

describe("product photo polish", () => {
  test("upscale only small photos: x2 when that is enough, else x4", () => {
    assert.equal(S.upscaleFactor(2000, 1500, 1280), 0);
    assert.equal(S.upscaleFactor(800, 600, 1280), 2);
    assert.equal(S.upscaleFactor(500, 400, 1280), 4);
    assert.equal(S.upscaleFactor(0, 0, 1280), 0);
  });

  test("small photo: upscaled, then cut out (the cut runs on the upscaled file); cached after", async () => {
    const t = tools({ ok: true, cover: 0.4 });
    const dir = path.join(tmp, "c1");
    const r = await S.polishStill(photo, { w: 600, h: 600, alpha: false }, { settings: on, runner: t.runner, cacheDir: dir });
    assert.equal(r.upscaled, 4);
    assert.equal(r.cutout, true);
    assert.match(r.path, /_cut\.png$/);
    assert.match(t.calls[1][2], /_x4\.png$/);
    assert.equal(t.calls[1][4], "u2net");
    const again = tools({ ok: true, cover: 0.4 });
    assert.equal((await S.polishStill(photo, { w: 600, h: 600, alpha: false }, { settings: on, runner: again.runner, cacheDir: dir })).path, r.path);
    assert.equal(again.calls.length, 0);
  });

  test("a doubtful cut keeps the photo and is not retried; a missing rembg is retried next time", async () => {
    const dir = path.join(tmp, "c2");
    const s = { ...on, upscale: false };
    const bad = tools({ ok: false, cover: 0.97, reason: "cut kept 97% of the picture" });
    const r = await S.polishStill(photo, { w: 2000, h: 2000, alpha: false }, { settings: s, runner: bad.runner, cacheDir: dir });
    assert.equal(r.path, photo);
    assert.equal(r.cutout, false);
    assert.match(r.notes[0], /97%/);
    const next = tools({ ok: true, cover: 0.4 });
    assert.equal((await S.polishStill(photo, { w: 2000, h: 2000, alpha: false }, { settings: s, runner: next.runner, cacheDir: dir })).path, photo);
    assert.equal(next.calls.length, 0);

    const dir3 = path.join(tmp, "c3");
    const crash = tools("crash");
    assert.match((await S.polishStill(photo, { w: 2000, h: 2000, alpha: false }, { settings: s, runner: crash.runner, cacheDir: dir3 })).notes[0], /not installed/);
    const fixed = tools({ ok: true, cover: 0.5 });
    assert.equal((await S.polishStill(photo, { w: 2000, h: 2000, alpha: false }, { settings: s, runner: fixed.runner, cacheDir: dir3 })).cutout, true);
  });

  test("a photo that already has transparency is not cut; off by default; no upscaler = a note", async () => {
    const t = tools({ ok: true, cover: 0.4 });
    const r = await S.polishStill(photo, { w: 2000, h: 2000, alpha: true }, { settings: { ...on, upscale: false }, runner: t.runner, cacheDir: path.join(tmp, "c4") });
    assert.equal(r.path, photo);
    assert.equal(t.calls.length, 0);
    assert.equal(FEATURE_DEFAULTS.stills.cutout, false);
    assert.equal(FEATURE_DEFAULTS.stills.upscale, false);
    assert.notEqual(FEATURE_DEFAULTS.stills.cutoutModel, "bria-rmbg");
    const n = await S.polishStill(photo, { w: 300, h: 300, alpha: true }, { settings: { ...on, realesrgan: path.join(tmp, "nope") }, runner: async () => ({ code: 127, stdout: "", stderr: "not found" }), cacheDir: path.join(tmp, "c5") });
    assert.match(n.notes[0], /upscale failed/);
  });

  test("the worker's answer is read from its last line", () => {
    assert.deepEqual(S.parseCut('warning\n{"ok": true, "cover": 0.3}\n'), { ok: true, cover: 0.3 });
    assert.equal(S.parseCut("Traceback ..."), null);
  });
});

const D = await import("../src/lib/assets/decisions.js");
describe("decision log (decisions.json)", () => {
  const cand = (id: string, match: number, pen: Partial<{ still: number; vision: number; model: number; reuse: number }> = {}) => {
    const parts = { match, matchFrom: "clip" as const, still: 0, vision: 0, model: 0, reuse: 0, ...pen };
    return { id, source: "pexels", kind: "video", url: `https://x/${id}`, query: "q", total: match + parts.still + parts.vision + parts.model + parts.reuse, parts };
  };
  test("winner + next best, each with the reason it lost", () => {
    const d = D.decideScene(7, "a", [cand("a", 0.31), cand("b", 0.33, { vision: -1 }), cand("c", 0.3), cand("d", 0.32, { reuse: -0.05 }), cand("e", 0.1)], 3);
    assert.equal(d.chosen.id, "a");
    assert.deepEqual(d.alternatives.map((x) => x.id), ["c", "d", "e"]);
    assert.match(d.alternatives[0].lostBecause, /lower CLIP match \(0\.300 vs 0\.310\)/);
    assert.match(d.alternatives[1].lostBecause, /already used/);
    const all = D.decideScene(7, "a", [cand("a", 0.31), cand("b", 0.33, { vision: -1 })], 5);
    assert.match(all.alternatives[0].lostBecause, /vision check/);
  });
});
