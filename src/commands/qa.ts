import fs from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { loadProjectNiche } from "../lib/niche.js";
import { paths } from "../lib/paths.js";
import { projectDir, readJson, writeJson } from "../lib/project.js";
import type { Assets } from "../lib/assets/types.js";
import type { Scene, Section } from "../lib/scenes.js";
import { footageSummary } from "../lib/sceneReview.js";
import { loadStyle } from "../lib/style.js";
import { ffmpegPath, ffprobePath } from "../lib/tools.js";
import type { Timeline } from "./timeline.js";
import { checkFrames } from "../lib/agent/frameCheck.js";
import { poolConfig, productRegions, readProductPool } from "../lib/assets/productPool.js";
import { renderedStats, runShotQa, shotQaEnabled } from "../lib/assets/shotQa.js";
import { sourceKey } from "../lib/pacing.js";
import { readFacts } from "../lib/facts.js";
import { readChapters, youtubeChapters } from "../lib/chapters.js";
import { buildPublishPack } from "../lib/publish.js";
import { withoutAvatar } from "../lib/avatar/index.js";
import { checkForcedReuse, checkMusicLicenses, checkRepeatCounts, checkVisualChange, preflightChecks, REPEAT_LIMITS } from "../lib/qaGate.js";
import { trackLicense } from "../lib/music.js";
import { readLedger } from "../lib/assets/licenseLedger.js";
import { musicEnabled } from "./timeline.js";
import { compileTimeline, loadTimeline } from "../lib/compiler/timelineCompiler.js";
import { GENERATED_SOURCE } from "../lib/flowPrompt.js";
import { analysePicture, CAPTION_FLOOR_PX, frameStats, grabCrop, measureText, MIN_CONTRAST } from "../lib/qa/picture.js";
import { captionPreset } from "../lib/render/captionPresets.js";
import { checkSoundEffects, earshotAvailable } from "../lib/audio/earshot.js";
import { loadFeatures } from "../lib/settings/features.js";
import { qaLite } from "./qaLite.js";

export type Status = "pass" | "warn" | "fail";
export interface Check {
  group: string;
  name: string;
  status: Status;
  detail: string;
}

export interface QaReport {
  project: string;
  video: string;
  videoMtime: number;
  createdAt: string;
  summary: { pass: number; warn: number; fail: number };
  checks: Check[];
  aiDisclosure: { required: boolean; reason: string };
  publish: { description: string; pinnedComment: string; chapters: string };
}

const SITE_NAMES: Record<string, string> = { pixabay: "Pixabay", pexels: "Pexels", wikimedia: "Wikimedia Commons", unsplash: "Unsplash", archive: "Internet Archive" };
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** Step 7: automatic checks on the rendered video + the publish package (description, pinned comment). */
export async function qa(opts: { project: string }, log: (m: string) => void = console.log): Promise<number> {
  const dir = projectDir(opts.project);
  const video = path.join(paths.output, `${opts.project}.mp4`);
  const ff = ffmpegPath();
  const fp = ffprobePath();
  if (!fs.existsSync(video) || !ff || !fp) {
    log(`[qa] ${video} missing. Run render first.`);
    return 1;
  }
  // Explainer / tutorial videos (no ClipForge timeline): the checks on the finished file only.
  if (!fs.existsSync(path.join(dir, "timeline.json"))) {
    const cfgFile = path.join(dir, "pipeline.json");
    const kind = fs.existsSync(cfgFile) ? (readJson<{ type?: string }>(cfgFile).type ?? "this") : "this";
    return qaLite(opts.project, dir, video, ff, fp, log, kind);
  }
  const project = readJson<{ name?: string; channel?: string; niche?: string }>(path.join(dir, "project.json"));
  if (!project.name) project.name = opts.project;
  const style = loadStyle(project.channel ?? "default");
  const niche = loadProjectNiche(project, style);
  const tl = readJson<Timeline>(path.join(dir, "timeline.json"));
  const scenes = readJson<Scene[]>(path.join(dir, "scenes.json"));
  const assets = readJson<Assets>(path.join(dir, "assets.json"));
  const sections = fs.existsSync(path.join(dir, "sections.json")) ? readJson<Section[]>(path.join(dir, "sections.json")) : [];
  const checks: Check[] = [];
  const add = (group: string, name: string, status: Status, detail: string) => checks.push({ group, name, status, detail });

  // ---- 1. file ----
  log("[qa] probing file ...");
  const probe = JSON.parse(
    (await run(fp, ["-v", "error", "-show_entries", "stream=codec_type,codec_name,width,height,r_frame_rate,duration:format=duration,size", "-of", "json", video])).stdout,
  );
  const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const a = probe.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  const vDur = Number(v?.duration);
  const aDur = Number(a?.duration);
  add("File", "Resolution", v?.width === 1920 && v?.height === 1080 ? "pass" : "fail", `${v?.width}x${v?.height}`);
  add("File", "Frame rate", v?.r_frame_rate === "30/1" ? "pass" : "warn", v?.r_frame_rate);
  add("File", "Codecs", v?.codec_name === "h264" && a?.codec_name === "aac" ? "pass" : "fail", `${v?.codec_name} / ${a?.codec_name}`);
  add("File", "A/V sync", Math.abs(vDur - aDur) < 0.1 ? "pass" : "fail", `video ${vDur.toFixed(2)} s, audio ${aDur.toFixed(2)} s`);
  add("File", "Length matches voiceover", Math.abs(vDur - tl.duration) < 0.15 ? "pass" : "fail", `${fmt(vDur)} (timeline ${fmt(tl.duration)})`);

  // ---- 2. picture: black and frozen stretches (on a small copy, so it is quick) ----
  log("[qa] scanning picture for black / frozen stretches ...");
  const pic = await run(ff, ["-hide_banner", "-nostats", "-loglevel", "info", "-i", video, "-an", "-vf", "scale=320:-2,blackdetect=d=0.4:pix_th=0.10,freezedetect=n=-55dB:d=3", "-f", "null", "-"], { timeoutMs: 20 * 60_000 });
  const blacks = [...pic.stderr.matchAll(/black_start:([\d.]+) black_end:([\d.]+) black_duration:([\d.]+)/g)].map((m) => ({ start: +m[1], dur: +m[3] }));
  const freezeStarts = [...pic.stderr.matchAll(/freeze_start: ([\d.]+)/g)].map((m) => +m[1]);
  const freezeDurs = [...pic.stderr.matchAll(/freeze_duration: ([\d.]+)/g)].map((m) => +m[1]);
  add("Picture", "Black frames", blacks.length ? "fail" : "pass", blacks.length ? blacks.map((b) => `${fmt(b.start)} (${b.dur.toFixed(1)} s)`).join(", ") : "none longer than 0.4 s");
  // Cards and photos are meant to be still; a frozen stretch only matters on a video clip.
  const frozenClips = freezeStarts
    .map((t, i) => ({ t, d: freezeDurs[i] ?? 0, scene: tl.scenes.find((s) => t >= s.start && t < s.end) }))
    .filter((f) => f.scene && f.scene.asset.kind === "video" && f.d >= 3);
  add("Picture", "Frozen video clips", frozenClips.length ? "warn" : "pass", frozenClips.length ? frozenClips.map((f) => `scene #${f.scene!.id} at ${fmt(f.t)} (${f.d.toFixed(1)} s)`).join(", ") : "no stock/own clip stands still for 3 s+");

  // ---- 2a. what a viewer notices at once (checks and thresholds from video-director, MIT) ----
  if (v?.width && v?.height) {
    log("[qa] first frame, single-frame flashes ...");
    try {
      const [num, den] = String(v.r_frame_rate ?? "30/1").split("/").map(Number);
      const pf = analysePicture(await frameStats(ff, video, v.width, v.height), num / (den || 1) || 30);
      const fadesIn = tl.scenes[0]?.transition === "fade" || tl.scenes[0]?.transition === "flash";
      add("Picture", "First frame (thumbnail / autoplay)", pf.frame0.ok ? "pass" : "fail",
        pf.frame0.ok ? `brightness ${pf.frame0.mean}, contrast ${pf.frame0.contrast}` : `flat or black (brightness ${pf.frame0.mean}, contrast ${pf.frame0.contrast}): muted autoplay and the auto thumbnail show this${fadesIn ? ". The first scene fades in: set its transition to Cut in the editor" : ""}`);
      add("Picture", "Single-frame flashes", pf.flashes.length ? "fail" : "pass", pf.flashes.length ? `at ${pf.flashes.slice(0, 8).map((t) => `${t.toFixed(2)} s`).join(", ")}` : "none");
      add("Picture", "One-frame pops", pf.pops.length ? "warn" : "pass", pf.pops.length ? `at ${pf.pops.slice(0, 8).map((t) => `${t.toFixed(2)} s`).join(", ")}` : "none");
    } catch (err) {
      add("Picture", "First frame / flashes", "warn", `not measured: ${String((err as Error).message).slice(0, 160)}`);
    }
  }

  // ---- 2b. per-shot QA (python/shot_qa.py: PySceneDetect + CLIP + motion) on the finished video ----
  if (shotQaEnabled()) {
    log("[qa] per-shot check (shot cuts, CLIP shot type, motion, repeats) ...");
    const sq = await runShotQa([{ key: "video", path: video }], poolConfig(niche).category, log);
    const q = sq?.video;
    if (q && !q.error && q.shots.length) {
      const cardAt = (t: number) => scenes.some((s) => s.type === "graphic" && t >= s.start && t < s.end);
      const st = renderedStats(q, cardAt);
      add("Shots", "Cut rhythm", "pass", `${st.shots} shots, avg ${st.avgShot.toFixed(2)} s, ${st.cutsPerMin.toFixed(1)} cuts/min`);
      add("Shots", "Close-up share", st.closeupShare >= 0.2 ? "pass" : "warn", `${pct(st.closeupShare)} of footage time is close-ups (aim 20 %+)`);
      // The channel's own avatar (source "own-avatar", avatar_plan.json) is a talking head on purpose.
      const avatarFile = path.join(dir, "avatar_plan.json");
      const avatarRanges = fs.existsSync(avatarFile) ? readJson<{ clips: { start: number; end: number; file?: string }[] }>(avatarFile).clips.filter((c) => c.file) : [];
      const talking = withoutAvatar(st.talking, avatarRanges);
      const exempt = st.talking.length - talking.length;
      add("Shots", "Talking heads on screen", talking.length ? "fail" : "pass",
        (talking.length ? `${talking.length} shot(s): ${talking.slice(0, 8).map((x) => `${fmt(x.start)} (p ${x.p.toFixed(2)})`).join(", ")}` : "none") + (exempt ? ` (${exempt} own-avatar shot(s) not counted)` : ""));
      add("Shots", "Static shots (2 s+ without motion)", st.statics.length > 3 ? "warn" : "pass", st.statics.length ? st.statics.slice(0, 8).map((x) => `${fmt(x.start)}-${fmt(x.end)}`).join(", ") : "none");
      {
        // Identical-scene pairs: fail above 20 (REPEAT_LIMITS), warn below.
        const rc = checkRepeatCounts(st.repeats.length, [], "pair(s) look the same (CLIP > 0.97)");
        add("Shots", "Repeated on-screen segments", rc.status,
          st.repeats.length ? `${rc.detail}: ${st.repeats.slice(0, 8).map((r) => `${fmt(r.a)} = ${fmt(r.b)}`).join("; ")}` : "no repeated shots");
      }
      writeJson(path.join(dir, "shot_qa.json"), { ...st, shotList: q.shots.map(({ emb, ...x }) => x) });
    } else add("Shots", "Per-shot check", "warn", "shot_qa.py failed (see log)");
  } else add("Shots", "Per-shot check", "warn", "skipped (SHOT_QA=off or no .venv)");

  // ---- 3. sound ----
  log("[qa] checking audio ...");
  const snd = await run(ff, ["-hide_banner", "-nostats", "-i", video, "-vn", "-af", "silencedetect=n=-45dB:d=2.5,ebur128=peak=true", "-f", "null", "-"], { timeoutMs: 10 * 60_000 });
  const silences = [...snd.stderr.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_duration: ([\d.]+)/g)].map((m) => ({ start: +m[1], dur: +m[2] }));
  const lufs = Number(snd.stderr.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop()?.match(/-?[\d.]+/)?.[0]);
  const peak = Number(snd.stderr.match(/Peak:\s+(-?[\d.]+) dBFS/g)?.pop()?.match(/-?[\d.]+/)?.[0]);
  const deadAir = silences.filter((s) => s.dur >= 5);
  add("Sound", "Silent gaps", deadAir.length ? "fail" : silences.length ? "warn" : "pass",
    silences.length ? `${silences.map((s) => `${fmt(s.start)} (${s.dur.toFixed(1)} s)`).join(", ")}${deadAir.length ? " - gaps of 5 s+ are dead air" : ""}` : "no gap of 2.5 s+");
  add("Sound", "Loudness (YouTube ~ -14 LUFS)", Math.abs(lufs + 14) <= 2 ? "pass" : "warn", `${lufs.toFixed(1)} LUFS`);
  add("Sound", "Clipping", peak <= -0.5 ? "pass" : "warn", `true peak ${peak.toFixed(1)} dBFS`);
  // The music of the video as rendered: the studio edits the v3 timeline, timeline.json is only the first draft.
  const musicFiles = effectiveMusicFiles(dir, tl.music.files);
  const musicOn = musicEnabled(style, niche);
  add("Sound", "Background music", musicFiles.length || !musicOn ? "pass" : "warn",
    musicFiles.length ? musicFiles.map((f) => path.basename(f)).join(", ") : musicOn ? "none - add tracks in Library > Music" : "off (choose a track when creating the video, or set style.json music.enabled)");
  const musicLicence = checkMusicLicenses(musicFiles.map((f) => ({ name: path.basename(f), license: trackLicense(path.dirname(f), path.basename(f)) })));
  if (musicLicence) add(musicLicence.group, musicLicence.name, musicLicence.status, musicLicence.detail);

  // ---- 3b. sound effects audible and on time (earshot, optional; features.json earshot) ----
  const es = loadFeatures().earshot;
  const cues = tl.motion?.sfx ? tl.scenes.flatMap((s) => (s.sfx ?? []).map((e, i) => ({ t: s.start + e.at, kind: e.kind, id: `${s.id}.${i}` }))).filter((c) => c.t < vDur - 0.2) : [];
  if (es.enabled && es.syncCheck && cues.length) {
    if (await earshotAvailable(es)) {
      log(`[qa] earshot: listening for ${cues.length} sound effect(s) ...`);
      try {
        const r = await checkSoundEffects(video, cues, path.join(dir, "qa"), es);
        const late = r.items.filter((i) => i.offset_ms !== null && Math.abs(i.offset_ms) > 100);
        add("Sound", "Sound effects heard on time (earshot)", r.hit100 >= es.minHit ? "pass" : "warn",
          `${pct(r.hit100)} heard within 100 ms${r.medianOffsetMs !== null ? `, median off by ${r.medianOffsetMs} ms` : ""}` +
            (r.silent.length ? `; not heard (buried under music / voice?) at ${r.silent.slice(0, 8).map((t) => fmt(t)).join(", ")}` : "") +
            (late.length ? `; off by more than 100 ms at ${late.slice(0, 6).map((i) => `${fmt(i.t)} (${i.offset_ms} ms)`).join(", ")}` : ""));
      } catch (err) {
        add("Sound", "Sound effects heard on time (earshot)", "warn", `not measured: ${String((err as Error).message).slice(0, 200)}`);
      }
    } else add("Sound", "Sound effects heard on time (earshot)", "warn", `earshot is switched on but "${es.command} --help" did not run: pip install earshot (see Tools)`);
  }

  // ---- 3b2. script retention beats ----
  // (script_report.json, written by the script step)
  const srFile = path.join(dir, "script_report.json");
  if (fs.existsSync(srFile)) {
    const rr = readJson<{ retention?: { status: "pass" | "warn" | "fail"; problems: string[]; hook: { words: number }; rehooks: { planned: number; found: number }; loops: { paidOff: boolean }[] } }>(srFile).retention;
    if (rr) add("Script", "Retention beats", rr.status, rr.problems.length ? rr.problems.slice(0, 6).join("; ") : `hook ${rr.hook.words} words, promise early, ${rr.rehooks.found}/${rr.rehooks.planned} re-hook(s) on time, ${rr.loops.filter((l) => l.paidOff).length}/${rr.loops.length} loop(s) paid off`);
  }

  if (fs.existsSync(srFile)) {
    const sr = readJson<{ selfRepetition?: { checkedAgainst: number; flagged: number; clean: boolean; sections: { flagged: boolean; against: string; ngram: number; cosine: number | null }[]; title: { flagged: boolean; against: string; score: number } | null } | null }>(srFile).selfRepetition;
    if (sr && sr.checkedAgainst) {
      const bad = sr.sections.filter((x) => x.flagged);
      add("Originality", "Not repeating our own videos", sr.clean ? "pass" : "warn", sr.clean ? `checked against ${sr.checkedAgainst} earlier script(s)` : [...bad.map((b) => `a section is close to "${b.against}" (5-gram ${b.ngram}, cosine ${b.cosine ?? "-"})`), ...(sr.title?.flagged ? [`title close to "${sr.title.against}"`] : [])].slice(0, 5).join("; "));
    }
  }

  // ---- 3c. facts (documentaries: src/lib/factcheck, factcheck.json) ----
  const factFile = path.join(dir, "factcheck.json");

  if (fs.existsSync(factFile)) {
    const fcr = readJson<{ factcheck: { counts: Record<string, number>; claims: { sentence: string; verdict: string }[] } }>(factFile).factcheck;
    const spoken = fs.existsSync(path.join(dir, "script.txt")) ? fs.readFileSync(path.join(dir, "script.txt"), "utf8") : "";
    // Only claims still in the script count (removed ones are not said).
    const left = fcr.claims.filter((c) => spoken.includes(c.sentence));
    const bad = left.filter((c) => c.verdict === "contradicted");
    const open = left.filter((c) => c.verdict === "not_found" || c.verdict === "unchecked");
    add("Facts", "Every claim checked against a source", bad.length ? "fail" : open.length ? "warn" : "pass",
      bad.length ? `${bad.length} claim(s) a source contradicts: ${bad.slice(0, 3).map((c) => `"${c.sentence.slice(0, 80)}"`).join("; ")}`
        : open.length ? `${open.length} claim(s) no source confirms: ${open.slice(0, 3).map((c) => `"${c.sentence.slice(0, 80)}"`).join("; ")}`
        : `${left.length} claim(s), each with a source`);
  }

  // ---- 4. captions ----
  if (tl.captions.enabled) {
    const words = fs.existsSync(path.join(dir, "aligned.json")) ? readJson<{ words: { start: number; end: number }[] }>(path.join(dir, "aligned.json")).words : [];
    const covered = words.length ? (words[words.length - 1].end - words[0].start) / tl.duration : 0;
    add("Captions", "Burned-in captions", words.length && covered > 0.8 ? "pass" : "fail", words.length ? `${words.length} words, cover ${pct(covered)} of the video` : "no aligned words");
    // Readable on a phone, muted: size from the style, contrast measured on frames (video-director's floors).
    const cs = tl.captions as unknown as { fontSize?: number; preset?: string; marginV?: number };
    const preset = captionPreset(cs.preset);
    const px = Math.round((cs.fontSize ?? 54) * preset.sizeScale);
    add("Captions", "Caption size on a phone", px >= CAPTION_FLOOR_PX ? "pass" : "warn",
      `${px} px at 1080p (${preset.label}; at least ${CAPTION_FLOOR_PX} px reads on a phone)${px < CAPTION_FLOOR_PX ? ": pick a bigger preset or raise the font size" : ""}`);
    if (words.length && v?.width && v?.height) {
      const scale = v.height / 1080;
      const lineH = Math.round(px * scale * 1.5);
      const box = { x: Math.round(v.width * 0.2), w: Math.round(v.width * 0.6), y: Math.max(0, Math.round(v.height - (cs.marginV ?? 70) * scale - lineH)), h: lineH };
      const picks = Array.from({ length: Math.min(6, words.length) }, (_, i) => words[Math.floor(((i + 0.5) * words.length) / Math.min(6, words.length))]);
      const measured: number[] = [];
      for (const w of picks) {
        const crop = await grabCrop(ff, video, (w.start + w.end) / 2, box);
        if (crop) measured.push(measureText(crop, box.w, box.h, Math.min(v.width, v.height)).contrast);
      }
      if (measured.length) {
        const sorted = [...measured].sort((a, b) => a - b);
        const mid = sorted[Math.floor(sorted.length / 2)];
        add("Captions", "Caption contrast", mid >= MIN_CONTRAST ? "pass" : "warn",
          `${mid}:1 typical, ${sorted[0]}:1 worst of ${measured.length} moments (at least ${MIN_CONTRAST}:1)${mid < MIN_CONTRAST ? ": use a preset with an outline or a solid box" : ""}`);
      }
    }
  } else add("Captions", "Burned-in captions", "pass", "off for this channel");

  // ---- 5. reused / mass-produced content risk ----
  const footage = tl.scenes.filter((s) => s.asset.source !== "graphic");
  const uses = new Map<string, number>();
  for (const s of footage) for (const p of new Set((s.asset.shots?.length ? s.asset.shots : [s.asset]).map((x) => x.path))) uses.set(p, (uses.get(p) ?? 0) + 1);
  const unique = uses.size / Math.max(1, footage.length);
  const [topPath, topCount] = [...uses.entries()].sort((x, y) => y[1] - x[1])[0] ?? ["", 0];
  const dur = (list: typeof tl.scenes) => list.reduce((t, s) => t + (s.end - s.start), 0);
  const stillShare = dur(tl.scenes.filter((s) => s.asset.kind === "image")) / tl.duration;
  const cardShare = dur(tl.scenes.filter((s) => s.asset.source === "graphic")) / tl.duration;
  let run4 = 0;
  let maxRun = 0;
  for (const s of tl.scenes) {
    run4 = s.asset.kind === "image" ? run4 + 1 : 0;
    maxRun = Math.max(maxRun, run4);
  }
  add("Originality", "Distinct footage", unique >= 0.6 ? "pass" : unique >= 0.4 ? "warn" : "fail", `${uses.size} different clips/photos for ${footage.length} footage scenes (${pct(unique)})`);
  add("Originality", "Most repeated clip", topCount <= 3 ? "pass" : topCount <= 5 ? "warn" : "fail", topCount ? `${path.basename(topPath)} used ${topCount}x` : "-");
  // Repeated footage: every shot actually on screen (sub-shots included) as a source segment.
  {
    const poolByPath = new Map(readProductPool(dir).map((p) => [p.path, p]));
    const segs: { key: string; a: number; b: number; scene: number; at: number; name: string }[] = [];
    for (const s of tl.scenes) {
      if (s.asset.source === "graphic") continue;
      const shots = s.asset.shots?.length ? s.asset.shots : [{ path: s.asset.path, kind: s.asset.kind, in: s.asset.in ?? 0, frames: s.endFrame - s.startFrame }];
      let at = s.start;
      for (const x of shots) {
        const p = poolByPath.get(x.path);
        const key = p ? (p.srcStart === undefined ? sourceKey(x.path) : sourceKey(x.path, p.url)) : sourceKey(x.path);
        const a = x.kind === "image" ? 0 : (p?.srcStart ?? 0) + (x.in ?? 0);
        const b = x.kind === "image" ? 1e6 : a + x.frames / 30;
        segs.push({ key, a, b, scene: s.id, at, name: path.basename(x.path) });
        at += x.frames / 30;
      }
    }
    const reps: string[] = [];
    // Uses per source moment (the first showing of an overlapping window): max 2 (REPEAT_LIMITS).
    const momentUses = new Map<(typeof segs)[number], number>();
    segs.forEach((x, i) => {
      const prev = segs.slice(0, i).find((y) => y.key === x.key && x.a < y.b - 0.05 && x.b > y.a + 0.05);
      if (!prev) return;
      reps.push(`${x.name} #${prev.scene} ${Math.floor(prev.at / 60)}:${String(Math.floor(prev.at % 60)).padStart(2, "0")} -> #${x.scene} ${Math.floor(x.at / 60)}:${String(Math.floor(x.at % 60)).padStart(2, "0")}`);
      momentUses.set(prev, (momentUses.get(prev) ?? 1) + 1);
    });
    const rc = checkRepeatCounts(reps.length, [...momentUses.entries()].map(([s, uses]) => ({ name: `${s.name}@${s.a.toFixed(1)}s`, uses })), "repeat(s)", REPEAT_LIMITS.forcedReuse);
    add("Originality", "Repeated clip segments", rc.status, reps.length ? `${rc.detail}: ${reps.slice(0, 8).join("; ")}` : `${segs.length} shots, no source segment shown twice`);
    const forcedCheck = checkForcedReuse(fs.existsSync(path.join(dir, "pacing_stats.json")) ? readJson<{ forcedReuse: number; forced: string[] }>(path.join(dir, "pacing_stats.json")) : null);
    if (forcedCheck) add(forcedCheck.group, forcedCheck.name, forcedCheck.status, forcedCheck.detail);
    // Edit polish (render/beats.json): a cut or punch-in at least every captions.maxVisualSec seconds.
    const beatsFile = path.join(dir, "render", "beats.json");
    if (fs.existsSync(beatsFile)) {
      const b = readJson<{ longestStill: { sec: number; at: number }; maxVisualSec?: number }>(beatsFile);
      const vc = checkVisualChange(b.longestStill, Math.max(3, Math.min(5, b.maxVisualSec ?? 5)));
      if (vc) add(vc.group, vc.name, vc.status, vc.detail);
    }
    // Product sections must only show their own product's pool shots / photos.
    const leaks: string[] = [];
    const sceneList = readJson<Scene[]>(path.join(dir, "scenes.json"));
    const photoProduct = (f: string) => /presskit[\\/]([^\\/]+)[\\/]/i.exec(f)?.[1];
    for (const [name, region] of productRegions(sceneList)) {
      const slugName = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      for (const sc of region) {
        const t = tl.scenes.find((x) => x.id === sc.id);
        for (const x of t?.asset.shots ?? [{ path: t?.asset.path ?? "" }]) {
          const p = poolByPath.get(x.path);
          if (p && p.product !== name) leaks.push(`#${sc.id} (${name}) shows ${p.product} shot ${path.basename(x.path)}`);
          const ph = photoProduct(x.path);
          if (!p && ph && ph !== slugName) leaks.push(`#${sc.id} (${name}) shows ${ph} photo`);
        }
      }
    }
    add("Originality", "Product sections only show their product", leaks.length ? "fail" : "pass", leaks.length ? leaks.slice(0, 6).join("; ") : "no cross-product shots");
  }
  const stillWarn = niche.qa?.stillWarn ?? 0.5;
  const stillFail = niche.qa?.stillFail ?? 0.65;
  // AI image style: pictures ARE the format; what matters is that they move and change often.
  const aiStyleVideo = fs.existsSync(path.join(dir, "ai_style_plan.json"));
  if (aiStyleVideo) {
    const imgs = tl.scenes.filter((s) => s.asset.kind === "image" && s.asset.source !== "graphic");
    const still = imgs.filter((s) => !s.motion || s.motion === "none").length;
    const lens = imgs.map((s) => s.end - s.start).sort((a, b) => a - b);
    const med = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
    add("Originality", "AI pictures move and change", still ? "warn" : med <= 8 ? "pass" : "warn",
      `${imgs.length} AI picture(s), a new one every ${med.toFixed(1)} s on average (aim 8 s or less)${still ? `; ${still} without a camera move` : "; every one has a camera move"}`);
  } else
    add("Originality", "Still images vs motion", stillShare <= stillWarn ? "pass" : stillShare <= stillFail ? "warn" : "fail",
      `${pct(stillShare)} of the video is still images/cards (warn above ${pct(stillWarn)}, fail above ${pct(stillFail)}; add product video clips to lower it)`);
  add("Originality", "Graphic cards", cardShare <= 0.35 ? "pass" : "warn", `${pct(cardShare)} of the video`);
  add("Originality", "Longest run of stills", maxRun <= 4 ? "pass" : "warn", `${maxRun} still scenes in a row`);

  // ---- 5b. does every picture fit what is being said? (Claude looks at the finished video) ----
  log("[qa] checking each scene's picture against the narration ...");
  const topic = (project as { brief?: string }).brief || niche.label;
  const verdicts = await checkFrames(ff, video, scenes.map((s) => ({ id: s.id, start: s.start, end: s.end, text: s.text })), topic, path.join(dir, "qa_frames"), log);
  if (verdicts) {
    const bad = (v: string) => verdicts.filter((x) => x.verdict === v);
    const list = (xs: typeof verdicts) => xs.map((x) => `#${x.id} ${fmt(scenes[x.id]?.start ?? 0)} ${x.shows}`).join("; ");
    const wrong = [...bad("wrong_product"), ...bad("wrong_meaning")];
    const unrelated = bad("unrelated");
    add("Footage", "Picture matches narration", wrong.length ? "fail" : unrelated.length ? "warn" : "pass",
      wrong.length || unrelated.length
        ? `${wrong.length} wrong product/meaning${wrong.length ? ` (${list(wrong)})` : ""}, ${unrelated.length} unrelated${unrelated.length ? ` (${list(unrelated)})` : ""}`
        : `all ${verdicts.length} scenes fit`);
    const exact = verdicts.filter((x) => x.verdict === "fits" || x.verdict === "card").length;
    add("Footage", "Shows the exact subject", "pass", `${exact}/${verdicts.length} scenes exact, ${bad("generic_ok").length} fitting generic shots`);
    writeJson(path.join(dir, "frame_check.json"), verdicts);
  } else add("Footage", "Picture matches narration", "warn", "skipped (needs ANTHROPIC_API_KEY)");

  // ---- 5c. pre-approval gate: files, reuse, exact product model, licence ledger, discrepancies ----
  for (const c of await preflightChecks(dir, { scenes, assets, timelineScenes: tl.scenes, niche, ledger: readLedger(dir) }, probeReadable(fp))) add(c.group, c.name, c.status, c.detail);

  // ---- 6. licences ----
  const notRecorded = scenes.filter((s) => /not recorded/i.test(assets[String(s.id)]?.license ?? ""));
  const testOnly = scenes.filter((s) => /test only/i.test(assets[String(s.id)]?.license ?? ""));
  const ccBy = scenes.map((s) => assets[String(s.id)]).filter((x) => x && /cc by/i.test(x.license));
  add("Licences", "Every scene logged", fs.existsSync(path.join(dir, "license_log.csv")) ? "pass" : "fail", "license_log.csv");
  add("Licences", "Press-kit licence recorded", notRecorded.length ? "warn" : "pass", notRecorded.length ? `scenes ${notRecorded.map((s) => s.id).join(", ")}: add sources.json / a note` : "ok");
  add("Licences", "Test-only media", testOnly.length ? "fail" : "pass", testOnly.length ? `scenes ${testOnly.map((s) => s.id).join(", ")} use files marked TEST ONLY` : "none");
  // YouTube CC is only as honest as the uploader: re-uploads of someone else's video are sometimes
  // marked CC. A human should glance at each channel before publishing.
  const yt = [...new Map(scenes.map((s) => assets[String(s.id)]).filter((x) => x?.source === "youtube_cc" || x?.source === "web_cc").map((x) => [x.url, x])).values()];
  add("Licences", "CC video uploaders checked", yt.length ? "warn" : "pass",
    yt.length ? `${yt.length} clip(s): open each link and check the channel made the video - ${yt.map((x) => `${x.author ?? "?"} ${x.url}`).join(" | ")}` : "none used");
  // General web crawl (VidRush-style): licence unknown. Warn (not fail) so a human decides.
  const crawled = [...new Map(scenes.map((s) => assets[String(s.id)]).filter((x) => x && (x.source === "web_crawl" || /unknown\/web/i.test(x.license))).map((x) => [x!.url, x!])).values()];
  add("Licences", "Web-crawled footage (copyright risk)", crawled.length ? "warn" : "pass",
    crawled.length ? `${crawled.length} clip(s) with UNKNOWN licence from the open web - you may not have the right to use them (copyright claims/strikes, demonetisation); replace them or get permission: ${crawled.map((x) => `${x.author ?? "?"} ${x.url}`).join(" | ")}` : "none used");
  // Exact-model clips cut from other people's YouTube reviews / walkarounds: not licensed to you.
  const ytExact = [...new Map(scenes.map((s) => assets[String(s.id)]).filter((x) => x?.source === "youtube_exact_model").map((x) => [x!.url.replace(/&t=\d+s$/, ""), x!])).values()];
  add("Licences", "Exact-model YouTube clips (rights)", ytExact.length ? "warn" : "pass",
    ytExact.length ? `${ytExact.length} source video(s) from other channels - transformative commentary helps but Content ID claims are possible; ask the channel / brand for permission or replace: ${ytExact.map((x) => `${x.author ?? "?"} ${x.url}`).join(" | ")}` : "none used");
  add("Licences", "Credits needed (CC BY)", ccBy.length ? "warn" : "pass", ccBy.length ? `${new Set(ccBy.map((x) => x.url)).size} file(s) - credits are in the description below` : "none");

  // ---- 7. products ----
  const products = scenes.filter((s) => s.type === "product");
  const noMedia = products.filter((s) => assets[String(s.id)]?.source === "graphic");
  // Exact-model footage per product chapter (footage_share.json from the timeline).
  for (const ch of footageSummary(dir)) {
    add("Products", `Verified footage: ${ch.product}`, ch.insufficient ? "fail" : ch.verifiedShare >= 0.8 ? "pass" : "warn",
      `${Math.round(ch.verifiedShare * 100)}% verified exact-model footage, ${Math.round(ch.stockShare * 100)}% stock/unverified; pool ${ch.poolVerified} verified clip(s)${ch.poolTarget ? ` of target ${ch.poolTarget}` : ""}${ch.insufficient ? " - INSUFFICIENT FOOTAGE: add own clips or press-kit media for this product" : ""}`);
  }
  add("Products", "Product shots with real media", !products.length || noMedia.length === 0 ? "pass" : noMedia.length / products.length <= 0.3 ? "warn" : "fail",
    products.length ? `${products.length - noMedia.length}/${products.length} (missing: ${[...new Set(noMedia.map((s) => s.product_name))].join(", ") || "-"})` : "no product scenes");

  // ---- publish package ----
  const items = sections.filter((s) => s.kind === "item");
  const chapterList = sections.map((s) => ({ t: s.start, label: s.kind === "item" ? `#${s.rank} ${s.product_name ?? ""}`.trim() : s.kind === "intro" ? "Intro" : s.kind === "outro" ? "Final thoughts" : s.label || "Start" }));
  if (chapterList.length && chapterList[0].t > 0) chapterList[0].t = 0;
  const ytCh = youtubeChapters(readChapters(dir));
  const chapters = ytCh ? ytCh : chapterList.length >= 3 ? chapterList.map((c) => `${fmt(c.t)} ${c.label}`).join("\n") : "";
  const credits = [...new Map(scenes.map((s) => assets[String(s.id)]).filter((x) => x && x.source !== "graphic" && x.source !== "local").map((x) => [x.url || x.path, x])).values()]
    .filter((x) => /cc by|unsplash|archive/i.test(x.license))
    .map((x) => `- ${x.author ? `${x.author} - ` : ""}${x.license.split(" (")[0]}: ${x.url}`);
  const usedSites = [...new Set(scenes.map((s) => assets[String(s.id)]?.source).filter((x) => x && !["graphic", "local", "presskit"].includes(x!)))];

  const description = [
    "[ONE-LINE HOOK ABOUT THE VIDEO]",
    "",
    ...(items.length ? ["Products in this video:", ...[...items].reverse().map((s) => `#${s.rank} ${s.product_name ?? ""} - [AFFILIATE LINK]`), ""] : []),
    ...(chapters ? ["Chapters:", chapters, ""] : []),
    "As an Amazon Associate I earn from qualifying purchases. Some links above are affiliate links: if you buy through them I may earn a small commission at no extra cost to you.",
    ...(niche.disclaimer ? ["", niche.disclaimer] : []),
    "",
    ...(usedSites.length ? [`Stock footage and photos: ${usedSites.map((x) => SITE_NAMES[x!] ?? x).join(", ")}.`] : []),
    ...(credits.length ? ["Credits:", ...credits] : []),
    "",
    "#[HASHTAG1] #[HASHTAG2] #[HASHTAG3]",
  ].join("\n");
  const pinnedComment = items.length
    ? `Which one would you pick? Here are the links to every product in the video (affiliate links):\n${[...items].reverse().map((s) => `#${s.rank} ${s.product_name ?? ""}: [AFFILIATE LINK]`).join("\n")}`
    : "What did you think of this video? Let me know in the comments.";

  // ---- script facts vs cards ----
  const facts = readFacts(dir);
  if (facts) {
    const cards = tl.scenes.flatMap((t) => (t.overlays ?? []).filter((l) => l.card).map((l) => ({ ...l.card!, at: t.start + l.delay })));
    const factOf = (n: unknown) => facts.products.find((p) => p.name.toLowerCase() === String(n ?? "").toLowerCase());
    const priceCards = cards.filter((c) => c.comp === "PriceCard" || c.comp === "PriceTag");
    const wrong = priceCards.filter((c) => {
      const f = factOf(c.props.name);
      return f?.price && String(c.props.price) !== f.price;
    });
    add("Cards", "Prices match the script", wrong.length ? "fail" : "pass", wrong.length ? wrong.map((c) => `${fmt(c.at)} ${c.props.name}: card ${c.props.price}, script ${factOf(c.props.name)?.price}`).join("; ") : `${priceCards.length} price card(s) checked against the script (${facts.source})`);
    const perProduct = new Map<string, number>();
    for (const c of priceCards) perProduct.set(String(c.props.name), (perProduct.get(String(c.props.name)) ?? 0) + 1);
    const dup = [...perProduct.entries()].filter(([, n]) => n > 1);
    add("Cards", "One price card per product", dup.length ? "warn" : "pass", dup.length ? dup.map(([n, k]) => `${n}: ${k} price cards`).join("; ") : "no duplicates");
    const thin = cards.filter((c) => c.comp === "SpecCard" && Array.isArray(c.props.rows) && (c.props.rows as string[][]).some((r) => !r[1]));
    add("Cards", "Spec rows have label + value", thin.length ? "warn" : "pass", thin.length ? `${thin.length} spec card(s) with one-line rows: ${thin.map((c) => `${fmt(c.at)} ${c.props.title}`).join(", ")}` : "all spec rows are label/value pairs");
    const noFacts = facts.products.filter((p) => !p.specs.length && !p.price);
    add("Cards", "Facts found for every product", noFacts.length ? "warn" : "pass", noFacts.length ? `no price/specs in the script for: ${noFacts.map((p) => p.name).join(", ")}` : `${facts.products.length} product(s): ${facts.products.map((p) => `${p.name}${p.price ? " " + p.price : ""}`).join(", ")}`);
  }

  // AI disclosure: YouTube asks for it for realistic altered/synthetic media (AI voices, AI-made
  // realistic visuals). Stock footage, own voice and code-made cards do not need it.
  // Clips regenerated in Google Flow (Veo) from the studio are realistic AI video.
  const generated = (loadTimeline(dir)?.tl.tracks ?? []).flatMap((t) => t.clips).filter((c) => c.kind === "video" && c.provenance.source === GENERATED_SOURCE);
  // A generated talking avatar (Phase 7) is a realistic synthetic person: YouTube wants the label.
  const avatarPlanFile = path.join(dir, "avatar_plan.json");
  const avatarClips = fs.existsSync(avatarPlanFile) ? readJson<{ clips: { file?: string }[] }>(avatarPlanFile).clips.filter((c) => c.file).length : 0;
  // AI pictures (ComfyUI / Gemini, source "imagegen") count too: they were missing before.
  const aiPictures = tl.scenes.filter((s) => s.asset.source === "imagegen").length;
  const aiVisuals = generated.length > 0 || avatarClips > 0 || aiPictures > 0;
  const aiVoice = false; // the voiceover is the creator's own
  const forced = style.aiDisclosure === "always";
  const aiDisclosure = {
    required: aiVisuals || aiVoice || forced,
    reason: forced ? "channel setting aiDisclosure = \"always\"" : aiVisuals ? (avatarClips ? `${avatarClips} AI avatar clip(s) (lip-synced presenter) are used` : generated.length ? `${generated.length} AI-generated clip(s) (Google Flow / Veo) are used` : `${aiPictures} AI-generated picture(s) are used (YouTube asks for the label on realistic ones; a clearly unreal style such as a cartoon may not need it: check YouTube's current rule)`) : aiVoice ? "AI-generated realistic voice is used" : "not required: own voiceover, stock/own footage, code-made graphics (AI only planned the edit)",
  };
  add("Publish", "YouTube \"altered or synthetic content\" label", "pass", aiDisclosure.required ? "TURN ON when uploading" : aiDisclosure.reason);
  add("Publish", "Human review", "warn", "watch the video and press Approve in the QA tab before uploading");

  const summary = { pass: checks.filter((c) => c.status === "pass").length, warn: checks.filter((c) => c.status === "warn").length, fail: checks.filter((c) => c.status === "fail").length };
  const report: QaReport = {
    project: opts.project,
    video,
    videoMtime: fs.statSync(video).mtimeMs,
    createdAt: new Date().toISOString(),
    summary,
    checks,
    aiDisclosure,
    publish: { description, pinnedComment, chapters },
  };
  writeJson(path.join(dir, "qa_report.json"), report);
  const pub = path.join(dir, "publish");
  fs.mkdirSync(pub, { recursive: true });
  fs.writeFileSync(path.join(pub, "description.txt"), description + "\n");
  fs.writeFileSync(path.join(pub, "pinned_comment.txt"), pinnedComment + "\n");
  if (chapters) fs.writeFileSync(path.join(pub, "chapters.txt"), chapters + "\n");
  // Publish pack: title, SEO description with chapters, thumbnails (overwrites description.txt).
  try {
    await buildPublishPack(dir, opts.project, log);
  } catch (err) {
    log(`[publish] failed: ${String((err as Error).message ?? err).slice(0, 200)}`);
  }
  const icon = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const md = [`# QA report - ${opts.project}`, "", `${summary.pass} pass, ${summary.warn} warnings, ${summary.fail} failures`, "", "| | Check | Result |", "|---|---|---|", ...checks.map((c) => `| ${icon[c.status]} | ${c.group}: ${c.name} | ${c.detail.replace(/\|/g, "/")} |`), "", "## Description", "", "```", description, "```", "", "## Pinned comment", "", "```", pinnedComment, "```", ""].join("\n");
  fs.writeFileSync(path.join(dir, "report.md"), md);

  for (const c of checks) log(`[qa] ${icon[c.status]} ${c.group}: ${c.name} - ${c.detail}`);
  log(`[qa] ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail -> ${path.join(dir, "report.md")}`);
  // Problems are for the reviewer (the approval button stays blocked while there are failures);
  // they do not mark the pipeline step as failed, so a batch shows "done, N QA issues".
  return 0;
}

/** A file ffprobe can open and that has a video stream (photos count). */
function probeReadable(fp: string): (file: string) => Promise<boolean> {
  return async (file) => {
    const r = await run(fp, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file], { timeoutMs: 30_000 });
    return r.code === 0 && r.stdout.includes("video");
  };
}

/**
 * Pre-render gate (`qa --preflight`): the checks that need no rendered video. Writes preflight.json;
 * exit code 1 when anything fails, so a script can stop before spending a render on it.
 */
export async function qaPreflight(opts: { project: string }, log: (m: string) => void = console.log): Promise<number> {
  const dir = projectDir(opts.project);
  for (const f of ["project.json", "scenes.json", "assets.json", "timeline.json"]) {
    if (!fs.existsSync(path.join(dir, f))) {
      log(`[qa] ${f} missing - run the pipeline through the timeline step first`);
      return 1;
    }
  }
  const project = readJson<{ name?: string; channel?: string; niche?: string; footage?: string }>(path.join(dir, "project.json"));
  if (!project.name) project.name = opts.project;
  const niche = loadProjectNiche(project, loadStyle(project.channel ?? "default"));
  const fp = ffprobePath();
  const checks = await preflightChecks(
    dir,
    { scenes: readJson<Scene[]>(path.join(dir, "scenes.json")), assets: readJson<Assets>(path.join(dir, "assets.json")), timelineScenes: readJson<Timeline>(path.join(dir, "timeline.json")).scenes, niche, ledger: readLedger(dir) },
    fp ? probeReadable(fp) : undefined,
  );
  const summary = { pass: checks.filter((c) => c.status === "pass").length, warn: checks.filter((c) => c.status === "warn").length, fail: checks.filter((c) => c.status === "fail").length };
  writeJson(path.join(dir, "preflight.json"), { createdAt: new Date().toISOString(), summary, checks });
  for (const c of checks) log(`[qa] ${c.status.toUpperCase()} ${c.group}: ${c.name} - ${c.detail}`);
  log(`[qa] preflight: ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail`);
  return summary.fail ? 1 : 0;
}

/** Music files of the timeline that is rendered (v3 when present), else the files of the v2 draft. */
function effectiveMusicFiles(dir: string, draft: string[]): string[] {
  try {
    const loaded = loadTimeline(dir);
    return loaded ? compileTimeline(loaded.tl).audio.music.files : draft;
  } catch {
    return draft;
  }
}
