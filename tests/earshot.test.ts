import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-earshot-"));
process.env.FEATURE_SETTINGS_FILE = path.join(tmp, "features.json");
const E = await import("../src/lib/audio/earshot.js");
const { FEATURE_DEFAULTS } = await import("../src/lib/settings/features.js");
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const on = { ...FEATURE_DEFAULTS.earshot, enabled: true };
type Call = { cmd: string; args: string[] };

describe("earshot (optional, fake runs; JSON shape from earshot's timeline.py sync())", () => {
  test("off by default; when on, --help decides if it is there", async () => {
    assert.equal(FEATURE_DEFAULTS.earshot.enabled, false);
    assert.equal(await E.earshotAvailable(FEATURE_DEFAULTS.earshot, async () => assert.fail("not called when off")), false);
    assert.equal(await E.earshotAvailable(on, async () => ({ code: 0, stdout: "usage", stderr: "" })), true);
    assert.equal(await E.earshotAvailable(on, async () => ({ code: -1, stdout: "", stderr: "ENOENT" })), false);
  });

  test("bank sound: earshot sfx render <id> -o file, cached", async () => {
    const calls: Call[] = [];
    const x = async (cmd: string, args: string[]) => {
      calls.push({ cmd, args });
      fs.writeFileSync(args[args.indexOf("-o") + 1], "RIFF");
      return { code: 0, stdout: "", stderr: "" };
    };
    const f = path.join(tmp, "sfx", "w.wav");
    await E.renderBankSound("whoosh_fast/crisp", f, on, x);
    await E.renderBankSound("whoosh_fast/crisp", f, on, x);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ["sfx", "render", "whoosh_fast/crisp", "-o", f, "--sr", "48000", "--peak", "-1"]);
    await assert.rejects(E.renderBankSound("nope/x", path.join(tmp, "sfx", "n.wav"), on, async () => ({ code: 1, stdout: "", stderr: "unknown sound id" })), /unknown sound id/);
  });

  test("sound effects check: cues written as {events:[{t, kind, id}]}, result read from sync.cues", async () => {
    let cueFile = "";
    const x = async (_cmd: string, args: string[]) => {
      assert.deepEqual(args.slice(0, 2), ["timeline", "/v.mp4"]);
      assert.ok(args.includes("--json") && args.includes("--detail") && args[args.indexOf("--detail") + 1] === "low");
      cueFile = args[args.indexOf("--cues") + 1];
      const result = {
        sync: {
          cues: {
            items: [
              { t: 1.2, kind: "whoosh", id: "0.0", offset_ms: 4.5, status: "OK" },
              { t: 5.0, kind: "pop", id: "1.0", offset_ms: null, status: "no sound" },
              { t: 9.1, kind: "whoosh", id: "2.0", offset_ms: 180, status: "late" },
            ],
            stats: { n: 3, hit_within_40ms: 0.333, hit_within_100ms: 0.333, median_abs_offset_ms: 92.3, no_sound: [5.0] },
          },
        },
      };
      fs.writeFileSync(args[args.indexOf("--out") + 1], JSON.stringify(result));
      return { code: 0, stdout: "", stderr: "" };
    };
    const r = await E.checkSoundEffects("/v.mp4", [{ t: 1.2, kind: "whoosh", id: "0.0" }, { t: 5, kind: "pop", id: "1.0" }, { t: 9.1, kind: "whoosh", id: "2.0" }], path.join(tmp, "qa"), on, x);
    assert.deepEqual(JSON.parse(fs.readFileSync(cueFile, "utf8")).events[1], { t: 5, kind: "pop", id: "1.0" });
    assert.equal(r.hit100, 0.333);
    assert.deepEqual(r.silent, [5]);
    assert.equal(r.medianOffsetMs, 92.3);
    assert.equal(r.items[2].offset_ms, 180);
    assert.equal(E.parseSync({ sync: {} }), null);
    await assert.rejects(E.checkSoundEffects("/v.mp4", [], path.join(tmp, "qa2"), on, async () => ({ code: 2, stdout: "", stderr: "models not downloaded" })), /models not downloaded/);
  });
});
