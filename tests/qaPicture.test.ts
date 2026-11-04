import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { run } from "../src/lib/exec.js";
import { ffmpegPath } from "../src/lib/tools.js";
import { analysePicture, contrastRatio, frameStats, grabCrop, luminance, measureText } from "../src/lib/qa/picture.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clipforge-qapic-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const ff = ffmpegPath();

async function make(name: string, filter: string, seconds = 3): Promise<string> {
  const f = path.join(tmp, name);
  const r = await run(ff!, ["-v", "error", "-y", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${seconds}`, "-vf", filter, "-pix_fmt", "yuv420p", f]);
  assert.equal(r.code, 0, r.stderr);
  return f;
}

describe("picture checks a viewer notices at once", { skip: !ff }, () => {
  test("a clean clip: frame 0 fine, no flashes", async () => {
    const f = await make("clean.mp4", "null");
    const p = analysePicture(await frameStats(ff!, f, 640, 360), 30);
    assert.equal(p.frame0.ok, true);
    assert.deepEqual(p.flashes, []);
  });

  test("a fade in from black: frame 0 fails (autoplay and the auto thumbnail show it)", async () => {
    const f = await make("fade.mp4", "fade=t=in:st=0:d=1");
    const p = analysePicture(await frameStats(ff!, f, 640, 360), 30);
    assert.equal(p.frame0.ok, false);
    assert.ok(p.frame0.mean < 8);
  });

  test("one white frame slipped in: a single-frame flash at its time", async () => {
    const f = await make("flash.mp4", "drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='eq(n,45)'");
    const p = analysePicture(await frameStats(ff!, f, 640, 360), 30);
    assert.deepEqual(p.flashes, [1.5]);
  });

  test("caption crop: text size and contrast are measured (white on a black box vs grey on grey)", async () => {
    // A 400x120 patch: a 300x50 "glyph" block (cap height 50 px on a 1080 short side) on a background.
    const patch = (fg: number, bg: number) => {
      const w = 400, h = 120, a = new Uint8Array(w * h * 3).fill(bg);
      for (let y = 30; y < 80; y++) for (let x = 50; x < 350; x += 2) for (let c = 0; c < 3; c++) a[(y * w + x) * 3 + c] = fg;
      return a;
    };
    const good = measureText(patch(255, 0), 400, 120, 1080);
    assert.equal(good.contrast, 21);
    assert.ok(Math.abs(good.fontPx - 50 / 0.72) < 1.5, String(good.fontPx));
    const weak = measureText(patch(170, 120), 400, 120, 1080);
    assert.ok(weak.contrast < 7, String(weak.contrast));
    assert.equal(Math.round(contrastRatio(luminance(255, 255, 255), luminance(0, 0, 0))), 21);
  });

  test("a crop of a real frame comes back as RGB bytes", async () => {
    const f = await make("crop.mp4", "null", 1);
    const c = await grabCrop(ff!, f, 0.5, { x: 10, y: 20, w: 64, h: 32 });
    assert.equal(c?.length, 64 * 32 * 3);
    assert.equal(await grabCrop(ff!, path.join(tmp, "missing.mp4"), 0, { x: 0, y: 0, w: 8, h: 8 }), null);
  });
});
