import fs from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { paths } from "../lib/paths.js";
import { ffmpegPath, ffprobePath } from "../lib/tools.js";

/** M0 gate: renders a 5-second 1920x1080 clip with h264_nvenc and verifies it with ffprobe. */
export async function testNvenc(): Promise<number> {
  const ff = ffmpegPath();
  const fp = ffprobePath();
  if (!ff || !fp) {
    console.error("FFmpeg/FFprobe not found. Run `clipforge doctor`.");
    return 1;
  }

  fs.mkdirSync(paths.output, { recursive: true });
  const out = path.join(paths.output, "m0_nvenc_test.mp4");

  const args = [
    "-hide_banner", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=30:duration=5",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5",
    // Windows FFmpeg has no fontconfig default, so the font file must be explicit (colon escaped for the filter parser).
    "-vf", "drawtext=fontfile='C\\:/Windows/Fonts/arial.ttf':text='ClipForge NVENC test':fontcolor=white:fontsize=72:x=(w-tw)/2:y=h-160:box=1:boxcolor=black@0.5",
    "-c:v", "h264_nvenc", "-preset", "p5", "-rc", "vbr", "-cq", "21", "-b:v", "0",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    out,
  ];

  console.log(`Rendering ${out} with h264_nvenc ...`);
  const t0 = Date.now();
  const r = await run(ff, args);
  const secs = ((Date.now() - t0) / 1000).toFixed(2);
  if (r.code !== 0) {
    console.error(r.stderr.split(/\r?\n/).slice(-15).join("\n"));
    console.error("\nNVENC render FAILED.");
    if (r.stderr.includes("nvenc API version")) {
      console.error("Hint: this FFmpeg build needs a newer NVIDIA driver. Use FFmpeg 8.1.x (pinned) or update the driver.");
    }
    return 1;
  }

  const probe = await run(fp, [
    "-v", "error",
    "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate:format=duration,size",
    "-of", "json",
    out,
  ]);
  const info = JSON.parse(probe.stdout);
  const video = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const audio = info.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  const duration = Number(info.format.duration);

  const pass =
    video?.codec_name === "h264" && video.width === 1920 && video.height === 1080 &&
    audio?.codec_name === "aac" && Math.abs(duration - 5) < 0.1;

  console.log(`Render time : ${secs}s`);
  console.log(`Video       : ${video?.codec_name} ${video?.width}x${video?.height} @ ${video?.r_frame_rate}`);
  console.log(`Audio       : ${audio?.codec_name}`);
  console.log(`Duration    : ${duration.toFixed(3)}s`);
  console.log(`File size   : ${(Number(info.format.size) / 1024).toFixed(0)} KB`);
  console.log(pass ? "\nM0 NVENC test: PASS" : "\nM0 NVENC test: FAIL");
  return pass ? 0 : 1;
}
