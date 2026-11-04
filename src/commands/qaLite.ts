import fs from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { paths } from "../lib/paths.js";
import { writeJson } from "../lib/project.js";
import { analysePicture, frameStats } from "../lib/qa/picture.js";
import type { Check, QaReport, Status } from "./qa.js";

/**
 * QA for videos that ClipForge did not cut itself (explainer / tutorial: explainroo or argo made the
 * picture, so there is no timeline.json): the checks that need only the finished file.
 * File, picture (black, first frame, flashes, pops), sound (silence, loudness, clipping), subtitles,
 * the YouTube AI label (the voice is a TTS voice) and the human review.
 */
export async function qaLite(project: string, dir: string, video: string, ff: string, fp: string, log: (m: string) => void, kind: string): Promise<number> {
  const checks: Check[] = [];
  const add = (group: string, name: string, status: Status, detail: string) => checks.push({ group, name, status, detail });
  const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  log(`[qa] ${kind} video: checks on the finished file`);

  const probe = JSON.parse((await run(fp, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,duration:format=duration", "-of", "json", video])).stdout || "{}");
  const v = probe.streams?.find((s: { codec_type: string }) => s.codec_type === "video");
  const a = probe.streams?.find((s: { codec_type: string }) => s.codec_type === "audio");
  const vDur = Number(v?.duration ?? probe.format?.duration);
  const aDur = Number(a?.duration);
  add("File", "Resolution", Math.min(v?.width ?? 0, v?.height ?? 0) >= 720 ? "pass" : "fail", `${v?.width}x${v?.height}`);
  add("File", "Codecs", v?.codec_name === "h264" && a?.codec_name === "aac" ? "pass" : "warn", `${v?.codec_name} / ${a?.codec_name ?? "no audio"}`);
  add("File", "A/V sync", a && Math.abs(vDur - aDur) < 0.15 ? "pass" : "fail", a ? `video ${vDur.toFixed(2)} s, audio ${aDur.toFixed(2)} s` : "no audio track");

  const pic = await run(ff, ["-hide_banner", "-nostats", "-i", video, "-an", "-vf", "scale=320:-2,blackdetect=d=0.4:pix_th=0.10", "-f", "null", "-"], { timeoutMs: 20 * 60_000 });
  const blacks = [...pic.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map((m) => ({ start: +m[1], dur: +m[3] }));
  add("Picture", "Black frames", blacks.length ? "fail" : "pass", blacks.length ? blacks.map((b) => `${fmt(b.start)} (${b.dur.toFixed(1)} s)`).join(", ") : "none longer than 0.4 s");
  if (v?.width && v?.height) {
    try {
      const [num, den] = String(v.r_frame_rate ?? "30/1").split("/").map(Number);
      const pf = analysePicture(await frameStats(ff, video, v.width, v.height), num / (den || 1) || 30);
      add("Picture", "First frame (thumbnail / autoplay)", pf.frame0.ok ? "pass" : "fail", `brightness ${pf.frame0.mean}, contrast ${pf.frame0.contrast}`);
      add("Picture", "Single-frame flashes", pf.flashes.length ? "fail" : "pass", pf.flashes.length ? `at ${pf.flashes.slice(0, 8).map((t) => `${t.toFixed(2)} s`).join(", ")}` : "none");
      add("Picture", "One-frame pops", pf.pops.length ? "warn" : "pass", pf.pops.length ? `at ${pf.pops.slice(0, 8).map((t) => `${t.toFixed(2)} s`).join(", ")}` : "none");
    } catch (err) {
      add("Picture", "First frame / flashes", "warn", `not measured: ${String((err as Error).message).slice(0, 160)}`);
    }
  }

  if (a) {
    const snd = await run(ff, ["-hide_banner", "-nostats", "-i", video, "-vn", "-af", "silencedetect=n=-45dB:d=2.5,ebur128=peak=true", "-f", "null", "-"], { timeoutMs: 10 * 60_000 });
    const silences = [...snd.stderr.matchAll(/silence_start: ([\d.]+)/g)].map((m) => +m[1]);
    const sum = snd.stderr.slice(snd.stderr.lastIndexOf("Summary:"));
    const lufs = Number(sum.match(/I:\s+(-?[\d.]+) LUFS/)?.[1] ?? NaN);
    const peak = Number(sum.match(/Peak:\s+(-?[\d.]+) dBFS/)?.[1] ?? NaN);
    add("Sound", "Silent gaps", silences.length ? "warn" : "pass", silences.length ? silences.slice(0, 8).map((t) => fmt(t)).join(", ") : "none longer than 2.5 s");
    add("Sound", "Loudness (YouTube ~ -14 LUFS)", Math.abs(lufs + 14) <= 2 ? "pass" : "warn", Number.isFinite(lufs) ? `${lufs.toFixed(1)} LUFS` : "not measured");
    add("Sound", "Clipping", peak <= -0.5 ? "pass" : "warn", Number.isFinite(peak) ? `true peak ${peak.toFixed(1)} dBFS` : "not measured");
  }

  const srt = [path.join(paths.output, `${project}.srt`), video.replace(/\.mp4$/i, ".srt")].find((f) => fs.existsSync(f));
  add("Captions", "Subtitle file", srt ? "pass" : "warn", srt ? `${path.basename(srt)}: upload it to YouTube with the video` : "no .srt next to the video");
  const chaptersFile = video.replace(/\.mp4$/i, ".chapters.txt");
  const chapters = fs.existsSync(chaptersFile) ? fs.readFileSync(chaptersFile, "utf8").trim() : "";
  const aiDisclosure = { required: true, reason: "AI-generated (text-to-speech) voice is used" };
  add("Publish", "YouTube \"altered or synthetic content\" label", "pass", "TURN ON when uploading (the voice is AI-generated)");
  add("Publish", "Human review", "warn", "watch the video and press Approve before uploading");

  const summary = { pass: checks.filter((c) => c.status === "pass").length, warn: checks.filter((c) => c.status === "warn").length, fail: checks.filter((c) => c.status === "fail").length };
  const report: QaReport = { project, video, videoMtime: fs.statSync(video).mtimeMs, createdAt: new Date().toISOString(), summary, checks, aiDisclosure, publish: { description: "", pinnedComment: "", chapters } };
  writeJson(path.join(dir, "qa_report.json"), report);
  for (const c of checks) log(`[qa] ${c.status.toUpperCase().padEnd(4)} ${c.group} / ${c.name}: ${c.detail}`);
  log(`[qa] ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  return summary.fail ? 2 : 0;
}
