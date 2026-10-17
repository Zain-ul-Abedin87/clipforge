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
import { preflightChecks } from "../lib/qaGate.js";
import { readLedger } from "../lib/assets/licenseLedger.js";
import { musicEnabled } from "./timeline.js";

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
      add("Shots", "Talking heads on screen", st.talking.length ? "fail" : "pass",
        st.talking.length ? `${st.talking.length} shot(s): ${st.talking.slice(0, 8).map((x) => `${fmt(x.start)} (p ${x.p.toFixed(2)})`).join(", ")}` : "none");
      add("Shots", "Static shots (2 s+ without motion)", st.statics.length > 3 ? "warn" : "pass", st.statics.length ? st.statics.slice(0, 8).map((x) => `${fmt(x.start)}-${fmt(x.end)}`).join(", ") : "none");
      add("Shots", "Repeated on-screen segments", st.repeats.length ? "fail" : "pass",
        st.repeats.length ? `${st.repeats.length} pair(s) look the same (CLIP > 0.97): ${st.repeats.slice(0, 8).map((r) => `${fmt(r.a)} = ${fmt(r.b)}`).join("; ")}` : "no repeated shots");
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
  const musicOn = musicEnabled(style, niche);
  add("Sound", "Background music", tl.music.files.length || !musicOn ? "pass" : "warn",
    tl.music.files.length ? tl.music.files.map((f) => path.basename(f)).join(", ") : musicOn ? "none - add tracks to channels/<channel>/music" : "off (default; style.json music.enabled)");

  // ---- 4. captions ----
  if (tl.captions.enabled) {
    const words = fs.existsSync(path.join(dir, "aligned.json")) ? readJson<{ words: { start: number; end: number }[] }>(path.join(dir, "aligned.json")).words : [];
    const covered = words.length ? (words[words.length - 1].end - words[0].start) / tl.duration : 0;
    add("Captions", "Burned-in captions", words.length && covered > 0.8 ? "pass" : "fail", words.length ? `${words.length} words, cover ${pct(covered)} of the video` : "no aligned words");
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
    segs.forEach((x, i) => {
      const prev = segs.slice(0, i).find((y) => y.key === x.key && x.a < y.b - 0.05 && x.b > y.a + 0.05);
      if (prev) reps.push(`${x.name} #${prev.scene} ${Math.floor(prev.at / 60)}:${String(Math.floor(prev.at % 60)).padStart(2, "0")} -> #${x.scene} ${Math.floor(x.at / 60)}:${String(Math.floor(x.at % 60)).padStart(2, "0")}`);
    });
    add("Originality", "Repeated clip segments", reps.length ? "fail" : "pass", reps.length ? `${reps.length} repeat(s): ${reps.slice(0, 8).join("; ")}` : `${segs.length} shots, no source segment shown twice`);
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
  const chapterList = sections.map((s) => ({ t: s.start, label: s.kind === "item" ? `#${s.rank} ${s.product_name ?? ""}`.trim() : s.kind === "intro" ? "Intro" : s.kind === "outro" ? "Final thoughts" : "Start" }));
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
