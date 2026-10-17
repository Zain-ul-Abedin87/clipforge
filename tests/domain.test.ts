import { describe, test } from "node:test";
import assert from "node:assert/strict";
import * as R from "../src/domain/rational.math.js";
import { clipFrames, clipsAt, fromLegacyTimeline, LegacyTimeline, MultiTrackTimeline, NO_SUBJECT, timelineFromJson, timelineToJson, validateTimeline } from "../src/domain/timeline.types.js";
import { identityText, productKey } from "../src/domain/product.types.js";

const r = (s: string | number) => R.parseRational(s);

describe("rational math", () => {
  test("normalised, exact arithmetic", () => {
    assert.deepEqual(R.rat(6, -4), R.rat(-3, 2));
    assert.equal(R.toRationalString(R.add(r("1/3"), r("1/6"))), "1/2");
    assert.equal(R.toRationalString(R.mul(r("2/3"), r("9/4"))), "3/2");
    assert.equal(R.toRationalString(R.div(r(1), r("1/30"))), "30");
    assert.throws(() => R.rat(1, 0), RangeError);
    assert.throws(() => R.div(r(1), R.ZERO), RangeError);
    assert.throws(() => R.rat(0.5), /decimal/);
  });

  test("decimals are exact (0.1 + 0.2 = 0.3)", () => {
    assert.ok(R.eq(R.add(R.fromDecimal(0.1), R.fromDecimal(0.2)), R.fromDecimal("0.3")));
    assert.equal(R.toRationalString(R.fromDecimal("-2.035")), "-407/200");
    assert.equal(R.toRationalString(R.fromDecimal("1e-3")), "1/1000");
    assert.equal(R.toRationalString(R.fromDecimal(12)), "12");
    assert.throws(() => R.fromDecimal("abc"), RangeError);
  });

  test("floor / ceil / round incl. negatives and halves", () => {
    assert.equal(R.floor(r("7/2")), 3n);
    assert.equal(R.floor(r("-7/2")), -4n);
    assert.equal(R.ceil(r("-7/2")), -3n);
    assert.equal(R.round(r("5/2")), 3n);
    assert.equal(R.round(r("-5/2")), -2n);
    assert.equal(R.toFixed(r("1/3"), 6), "0.333333");
    assert.equal(R.toFixed(r("-2/3"), 3), "-0.667");
  });

  test("frames: 29.97 fps round-trips exactly", () => {
    const fps = R.FPS_2997;
    const t = R.frameToSeconds(1798n, fps); // one minute of NTSC video
    assert.equal(R.toRationalString(t), "899899/15000");
    assert.equal(R.secondsToFrame(t, fps), 1798n);
    assert.ok(R.isFrameAligned(t, fps));
    assert.equal(R.toTimebase(R.frameToSeconds(1n, R.FPS_30), R.rat(1, 15360)), 512n);
  });

  test("no drift: 10,000 scenes of 1/3 s sum to exactly 3333 1/3 s", () => {
    let t = R.ZERO;
    for (let i = 0; i < 10_000; i++) t = R.add(t, r("1/3"));
    assert.equal(R.toRationalString(t), "10000/3");
    // The float version drifts: 1/3 added 10,000 times is not 3333.333...
    let f = 0;
    for (let i = 0; i < 10_000; i++) f += 1 / 3;
    assert.notEqual(f, 10000 / 3);
  });

  test("boundaries snap with cumulative rounding and stay strictly increasing", () => {
    const fps = R.FPS_30;
    const cuts = ["0", "2.51", "5.02", "5.03", "7.5"].map(r);
    const frames = R.boundariesToFrames(cuts, fps);
    assert.deepEqual(frames, [0n, 75n, 151n, 152n, 225n]);
    assert.equal(R.frameSpan(r("2.51"), r("5.02"), fps), 76n);
  });
});

const fps = R.FPS_30;
const f = (n: number) => R.frameToSeconds(BigInt(n), fps);

function tiny(): MultiTrackTimeline {
  return {
    version: 3, fps, width: 1920, height: 1080, duration: f(90),
    scenes: [
      { id: 0, start: f(0), duration: f(45), text: "a", subject: NO_SUBJECT },
      { id: 1, start: f(45), duration: f(45), text: "b", subject: NO_SUBJECT },
    ],
    tracks: [
      { id: "voice", kind: "voiceover", name: "Voice", exclusive: true, clips: [{ id: "v", trackId: "voice", kind: "audio", start: R.ZERO, duration: r("2.9871"), media: { path: "v.wav", kind: "audio", sourceIn: R.ZERO }, gainDb: 0 }] },
      {
        id: "broll", kind: "broll", name: "B-roll", exclusive: true, clips: [
          { id: "b0", trackId: "broll", kind: "video", sceneId: 0, start: f(0), duration: f(45), media: { path: "a.mp4", kind: "video", sourceIn: r("1.5") }, fit: "cover", motion: "none", transitionIn: "cut", provenance: { source: "local" } },
          { id: "b1", trackId: "broll", kind: "video", sceneId: 1, start: f(45), duration: f(45), media: { path: "b.mp4", kind: "video", sourceIn: R.ZERO }, fit: "blur_pad", motion: "zoom_in", transitionIn: "fade", provenance: { source: "youtube_exact_model", keyword: "blades", verified: true } },
        ],
      },
    ],
  };
}

describe("multi-track timeline", () => {
  test("a well-formed timeline validates", () => assert.deepEqual(validateTimeline(tiny()), []));

  test("overlaps on an exclusive track, gaps between scenes and off-grid clips are errors", () => {
    const tl = tiny();
    const b1 = tl.tracks[1].clips[1];
    b1.start = f(40);
    b1.duration = r("1.51"); // 45.3 frames: not on the 30 fps grid
    tl.scenes[1].start = f(46);
    const errs = validateTimeline(tl).join("\n");
    assert.match(errs, /b1: not frame-aligned/);
    assert.match(errs, /b1: overlaps b0/);
    assert.match(errs, /scene 1: starts at 23\/15/);
  });

  test("clipsAt and clipFrames", () => {
    const tl = tiny();
    assert.deepEqual(clipsAt(tl, r("1.6")).map((c) => c.id).sort(), ["b1", "v"]);
    assert.deepEqual(clipFrames(tl.tracks[1].clips[1], fps), { startFrame: 45n, frames: 45n });
  });

  test("JSON round-trip keeps exact rationals", () => {
    const text = timelineToJson(tiny());
    assert.match(text, /"\$r": "2\.9871"|"\$r": "29871\/10000"/);
    const back = timelineFromJson(text);
    assert.ok(R.eq(back.tracks[0].clips[0].duration, r("2.9871")));
    assert.ok(R.eq(back.fps, fps));
    assert.deepEqual(validateTimeline(back), []);
    assert.throws(() => timelineFromJson(JSON.stringify({ version: 2 })), /not a v3/);
  });

  test("v2 timeline.json migrates frame-exact (scenes, sub-shots, overlays, sfx, music)", () => {
    const legacy: LegacyTimeline = {
      version: 2, fps: 30, width: 1920, height: 1080, voice: "voice.wav",
      music: { files: ["bed.mp3"], volumeDb: -18 }, motion: { sfxDb: -12 },
      scenes: [
        { id: 0, startFrame: 0, endFrame: 76, asset: { path: "a.mp4", kind: "video", source: "local", in: 0.5 }, motion: "none", transition: "cut", overlays: [{ path: "t.png", delay: 0.1, anim: "slide_up", out: 2.0 }], sfx: [{ kind: "whoosh", at: 0 }] },
        {
          id: 1, startFrame: 76, endFrame: 151, motion: "zoom_in", transition: "fade",
          asset: { path: "x.mp4", kind: "video", source: "youtube_exact_model", shots: [{ path: "p1.mp4", kind: "video", in: 1.25, frames: 40, verified: true }, { path: "p2.jpg", kind: "image", frames: 35, variant: "mirror" }] },
        },
      ],
    };
    const tl = fromLegacyTimeline(legacy, { 0: "first", 1: "second" });
    assert.deepEqual(validateTimeline(tl), []);
    assert.equal(R.toRationalString(tl.duration), "151/30");
    assert.equal(tl.scenes[1].text, "second");
    const broll = tl.tracks.find((t) => t.kind === "broll")!.clips;
    assert.deepEqual(broll.map((c) => clipFrames(c, fps)), [{ startFrame: 0n, frames: 76n }, { startFrame: 76n, frames: 40n }, { startFrame: 116n, frames: 35n }]);
    const p1 = broll[1];
    assert.ok(p1.kind === "video" && R.eq(p1.media.sourceIn, r("1.25")) && p1.provenance.verified && p1.transitionIn === "fade");
    assert.ok(broll[2].kind === "video" && broll[2].variant === "mirror" && broll[2].transitionIn === "cut");
    const ov = tl.tracks.find((t) => t.kind === "overlay")!.clips[0];
    assert.deepEqual(clipFrames(ov, fps), { startFrame: 3n, frames: 57n });
    assert.equal(tl.tracks.find((t) => t.kind === "sfx")!.clips.length, 1);
    assert.equal(tl.tracks.find((t) => t.kind === "music")!.clips.length, 1);
  });
});

describe("product identity", () => {
  test("stable keys and display text", () => {
    assert.equal(productKey({ manufacturer: "Ryobi", model: "RY401150", variant: "HP" }), "ryobi_ry401150-hp");
    assert.equal(productKey({ manufacturer: "Apple", model: "AirPods Pro", variant: "Pro" }), "apple_airpods-pro");
    assert.equal(identityText({ manufacturer: "Holosun", model: "MOS", generation: "3" }), "Holosun MOS gen 3");
  });
});
