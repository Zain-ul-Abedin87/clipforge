import fs from "node:fs";
import path from "node:path";
import { run } from "../lib/exec.js";
import { loadNiche, projectNicheName } from "../lib/niche.js";
import { paths } from "../lib/paths.js";
import { projectDir, readJson, writeJson } from "../lib/project.js";
import type { Assets } from "../lib/assets/types.js";
import type { Scene, Section } from "../lib/scenes.js";
import { loadStyle } from "../lib/style.js";
import { ffmpegPath, ffprobePath } from "../lib/tools.js";
import type { Timeline } from "./timeline.js";

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
  const project = readJson<{ channel?: string; niche?: string }>(path.join(dir, "project.json"));
  const style = loadStyle(project.channel ?? "default");
  const niche = loadNiche(projectNicheName(project, style));
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

  // ---- 3. sound ----
  log("[qa] checking audio ...");
  const snd = await run(ff, ["-hide_banner", "-nostats", "-i", video, "-vn", "-af", "silencedetect=n=-45dB:d=2.5,ebur128=peak=true", "-f", "null", "-"], { timeoutMs: 10 * 60_000 });
  const silences = [...snd.stderr.matchAll(/silence_start: ([\d.]+)[\s\S]*?silence_duration: ([\d.]+)/g)].map((m) => ({ start: +m[1], dur: +m[2] }));
  const lufs = Number(snd.stderr.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop()?.match(/-?[\d.]+/)?.[0]);
  const peak = Number(snd.stderr.match(/Peak:\s+(-?[\d.]+) dBFS/g)?.pop()?.match(/-?[\d.]+/)?.[0]);
  add("Sound", "Long silences", silences.length ? "warn" : "pass", silences.length ? silences.map((s) => `${fmt(s.start)} (${s.dur.toFixed(1)} s)`).join(", ") : "no gap of 2.5 s+");
  add("Sound", "Loudness (YouTube ~ -14 LUFS)", Math.abs(lufs + 14) <= 2 ? "pass" : "warn", `${lufs.toFixed(1)} LUFS`);
  add("Sound", "Clipping", peak <= -0.5 ? "pass" : "warn", `true peak ${peak.toFixed(1)} dBFS`);
  add("Sound", "Background music", tl.music.files.length ? "pass" : "warn", tl.music.files.length ? tl.music.files.map((f) => path.basename(f)).join(", ") : "none - add tracks to channels/<channel>/music");

  // ---- 4. captions ----
  if (tl.captions.enabled) {
    const words = fs.existsSync(path.join(dir, "aligned.json")) ? readJson<{ words: { start: number; end: number }[] }>(path.join(dir, "aligned.json")).words : [];
    const covered = words.length ? (words[words.length - 1].end - words[0].start) / tl.duration : 0;
    add("Captions", "Burned-in captions", words.length && covered > 0.8 ? "pass" : "fail", words.length ? `${words.length} words, cover ${pct(covered)} of the video` : "no aligned words");
  } else add("Captions", "Burned-in captions", "pass", "off for this channel");

  // ---- 5. reused / mass-produced content risk ----
  const footage = tl.scenes.filter((s) => s.asset.source !== "graphic");
  const uses = new Map<string, number>();
  for (const s of footage) uses.set(s.asset.path, (uses.get(s.asset.path) ?? 0) + 1);
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
  const stillWarn = niche.qa?.stillWarn ?? 0.5;
  const stillFail = niche.qa?.stillFail ?? 0.65;
  add("Originality", "Still images vs motion", stillShare <= stillWarn ? "pass" : stillShare <= stillFail ? "warn" : "fail",
    `${pct(stillShare)} of the video is still images/cards (warn above ${pct(stillWarn)}, fail above ${pct(stillFail)}; add product video clips to lower it)`);
  add("Originality", "Graphic cards", cardShare <= 0.35 ? "pass" : "warn", `${pct(cardShare)} of the video`);
  add("Originality", "Longest run of stills", maxRun <= 4 ? "pass" : "warn", `${maxRun} still scenes in a row`);

  // ---- 6. licences ----
  const notRecorded = scenes.filter((s) => /not recorded/i.test(assets[String(s.id)]?.license ?? ""));
  const testOnly = scenes.filter((s) => /test only/i.test(assets[String(s.id)]?.license ?? ""));
  const ccBy = scenes.map((s) => assets[String(s.id)]).filter((x) => x && /cc by/i.test(x.license));
  add("Licences", "Every scene logged", fs.existsSync(path.join(dir, "license_log.csv")) ? "pass" : "fail", "license_log.csv");
  add("Licences", "Press-kit licence recorded", notRecorded.length ? "warn" : "pass", notRecorded.length ? `scenes ${notRecorded.map((s) => s.id).join(", ")}: add sources.json / a note` : "ok");
  add("Licences", "Test-only media", testOnly.length ? "fail" : "pass", testOnly.length ? `scenes ${testOnly.map((s) => s.id).join(", ")} use files marked TEST ONLY` : "none");
  add("Licences", "Credits needed (CC BY)", ccBy.length ? "warn" : "pass", ccBy.length ? `${new Set(ccBy.map((x) => x.url)).size} file(s) - credits are in the description below` : "none");

  // ---- 7. products ----
  const products = scenes.filter((s) => s.type === "product");
  const noMedia = products.filter((s) => assets[String(s.id)]?.source === "graphic");
  add("Products", "Product shots with real media", !products.length || noMedia.length === 0 ? "pass" : noMedia.length / products.length <= 0.3 ? "warn" : "fail",
    products.length ? `${products.length - noMedia.length}/${products.length} (missing: ${[...new Set(noMedia.map((s) => s.product_name))].join(", ") || "-"})` : "no product scenes");

  // ---- publish package ----
  const items = sections.filter((s) => s.kind === "item");
  const chapterList = sections.map((s) => ({ t: s.start, label: s.kind === "item" ? `#${s.rank} ${s.product_name ?? ""}`.trim() : s.kind === "intro" ? "Intro" : s.kind === "outro" ? "Final thoughts" : "Start" }));
  if (chapterList.length && chapterList[0].t > 0) chapterList[0].t = 0;
  const chapters = chapterList.length >= 3 ? chapterList.map((c) => `${fmt(c.t)} ${c.label}`).join("\n") : "";
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

  // AI disclosure: YouTube asks for it for realistic altered/synthetic media (AI voices, AI-made
  // realistic visuals). Stock footage, own voice and code-made cards do not need it.
  const aiVisuals = false; // no AI image/video generation is wired in yet
  const aiVoice = false; // the voiceover is the creator's own
  const forced = style.aiDisclosure === "always";
  const aiDisclosure = {
    required: aiVisuals || aiVoice || forced,
    reason: forced ? "channel setting aiDisclosure = \"always\"" : aiVisuals || aiVoice ? "AI-generated realistic voice or visuals are used" : "not required: own voiceover, stock/own footage, code-made graphics (AI only planned the edit)",
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
  const icon = { pass: "PASS", warn: "WARN", fail: "FAIL" };
  const md = [`# QA report - ${opts.project}`, "", `${summary.pass} pass, ${summary.warn} warnings, ${summary.fail} failures`, "", "| | Check | Result |", "|---|---|---|", ...checks.map((c) => `| ${icon[c.status]} | ${c.group}: ${c.name} | ${c.detail.replace(/\|/g, "/")} |`), "", "## Description", "", "```", description, "```", "", "## Pinned comment", "", "```", pinnedComment, "```", ""].join("\n");
  fs.writeFileSync(path.join(dir, "report.md"), md);

  for (const c of checks) log(`[qa] ${icon[c.status]} ${c.group}: ${c.name} - ${c.detail}`);
  log(`[qa] ${summary.pass} pass, ${summary.warn} warn, ${summary.fail} fail -> ${path.join(dir, "report.md")}`);
  // Problems are for the reviewer (the approval button stays blocked while there are failures);
  // they do not mark the pipeline step as failed, so a batch shows "done, N QA issues".
  return 0;
}
