import { Command } from "commander";
import { align } from "./commands/align.js";
import { assets } from "./commands/assets.js";
import { render } from "./commands/render.js";
import { timeline } from "./commands/timeline.js";
import { qa, qaPreflight } from "./commands/qa.js";
import { evalDrift, makeTestAudio } from "./commands/devTools.js";
import { doctor } from "./commands/doctor.js";
import { fetchModel } from "./commands/fetchModel.js";
import { plan } from "./commands/plan.js";
import { runWorkers, serve } from "./server/server.js";
import { workerStages } from "./server/pipelineQueue.js";
import { testNvenc } from "./commands/testNvenc.js";
import { transcribe } from "./commands/transcribe.js";
import { tts } from "./commands/tts.js";
import { harvestKeyword, harvestModel, rescoreVault } from "./lib/agents/youtube/ytExtractor.js";
import { closeRedis } from "./lib/redis.js";
import { activeLoader, setDefaultStage, stageForCommand } from "./lib/models/loader.js";
import { loadLlmSettings } from "./lib/agents/llm/settings.js";

// Per-project run log: every step run with -p/--project appends its console output (with time and
// step name) to workspace/<project>/run.log, so a video's whole history is in one file.
{
  const argv = process.argv.slice(2);
  const i = argv.findIndex((x) => x === "-p" || x === "--project");
  const name = i >= 0 ? argv[i + 1] : argv.find((x) => x.startsWith("--project="))?.slice(10);
  if (name && /^[\w.\- ]+$/.test(name)) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { paths } = await import("./lib/paths.js");
    const dir = path.join(paths.workspace, name);
    if (fs.existsSync(dir)) {
      const file = path.join(dir, "run.log");
      const step = argv[0] ?? "?";
      const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
      const write = (lvl: string, args: unknown[]) => {
        try {
          const text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))).join(" ");
          fs.appendFileSync(file, text.split(/\r?\n/).map((l) => `${stamp()} [${step}]${lvl} ${l}`).join("\n") + "\n");
        } catch { /* logging must never break a step */ }
      };
      write("", [`=== ${argv.join(" ")} (pid ${process.pid}) ===`]);
      for (const [k, lvl] of [["log", ""], ["info", ""], ["warn", " WARN"], ["error", " ERROR"]] as const) {
        const orig = console[k].bind(console);
        console[k] = (...args: unknown[]) => (write(lvl, args), orig(...args));
      }
      process.on("exit", (code) => write("", [`=== exit ${code ?? process.exitCode ?? 0} ===`]));
    }
  }
}

const program = new Command();

program.name("clipforge").description("Voiceover -> faceless YouTube video pipeline").version("0.0.1");

// Model loader (src/lib/models/loader.ts): each command is a stage with its own local model; the
// stage's model is unloaded when the command ends so the next step (Whisper, TTS, render) has the VRAM.
program.hook("preAction", (_root, cmd) => {
  setDefaultStage(stageForCommand(cmd.name()));
});
program.hook("postAction", async () => {
  const loader = activeLoader();
  if (loader && loadLlmSettings().models.unloadAfterStage) await loader.release();
});

program
  .command("research")
  .description("Niche / outlier finder: top outliers + growing new faceless channels (YouTube Data API, YOUTUBE_API_KEY)")
  .option("-s, --seeds <list>", "comma-separated seed searches (default: features.json research.seeds)")
  .action(async (o) => {
    const { runResearch } = await import("./lib/research/index.js");
    const r = await runResearch({ seeds: o.seeds ? String(o.seeds).split(",") : undefined });
    for (const x of r.outliers.slice(0, 15)) console.log(`${x.flag.padEnd(4)} ${x.score.toFixed(1).padStart(6)}x  ${x.video.views.toLocaleString().padStart(12)}  ${x.channel.title} - ${x.video.title}`);
    for (const c of r.channels.slice(0, 10)) console.log(`new  ${c.ageDays}d  ~${c.views28.toLocaleString()} views/28d (${c.views28Source})  RPM est $${c.rpm[0]}-${c.rpm[1]}  ${c.channel.title}`);
    for (const w of r.warnings) console.warn(w);
  });

program
  .command("titles")
  .description("10 original title options for a topic (patterns from outliers, Google News hooks, similarity check)")
  .requiredOption("-t, --topic <topic>", "video topic, e.g. \"best budget 9mm pistols\"")
  .option("--channel <id>", "channel whose brief (voice, banned phrases) the titles follow")
  .action(async (o) => {
    const { runTitles } = await import("./lib/research/index.js");
    const r = await runTitles(String(o.topic), { channel: o.channel ? String(o.channel) : undefined });
    r.titles.forEach((t, i) => console.log(`${String(i + 1).padStart(2)}. ${t.title}  [${t.pattern}; closest competitor ${Math.round(t.similarity.score * 100)}%]`));
  });

program
  .command("visuals")
  .description("Visual plan: a unique visual per segment (product footage > product photo > stock > generated), source + licence logged")
  .requiredOption("-p, --project <name>", "project name")
  .option("--apply", "download stock / generate pictures and fill scenes that have no real picture")
  .action(async (o) => {
    const { projectDir } = await import("./lib/project.js");
    const { runVisualPlan } = await import("./lib/assets/visualPlan.js");
    const plan = await runVisualPlan(projectDir(String(o.project)), { apply: !!o.apply });
    if (plan.summary.forcedReuse > 0) console.warn(`[visuals] ${plan.summary.forcedReuse} forced reuse(s): add footage or enable stock / image generation`);
  });

program
  .command("explainer")
  .description("Explainer video (explainroo): --write = AI script + drawing code + check/fix loop; --render = voice, render, verify -> output/<project>.mp4")
  .requiredOption("-p, --project <name>", "project name")
  .option("--write", "write script.md + scenes.js and run explainroo check")
  .option("--keep-script", "with --write: keep the creator's edited script.md, redo only the pictures")
  .option("--render", "voice + render + verify")
  .action(async (o) => {
    const { writeExplainer, renderExplainer } = await import("./lib/formats/explainer.js");
    try {
      if (o.write) {
        const r = await writeExplainer(String(o.project), { keepScript: !!o.keepScript });
        process.exitCode = r.open.some((i) => i.level === "error") ? 2 : 0;
      }
      if (o.render) await renderExplainer(String(o.project));
    } catch (err) {
      console.error(`[explainer] ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("aistyle")
  .description("AI image style: one picture per footage scene, in the channel's fixed look (channels/<ch>/ai_style) -> assets.json")
  .requiredOption("-p, --project <name>", "project name")
  .option("--channel <name>", "channel whose style is used", "default")
  .action(async (o) => {
    const { runAiStyle } = await import("./lib/assets/aiStyle.js");
    const { projectDir } = await import("./lib/project.js");
    try {
      await runAiStyle(projectDir(String(o.project)), { channel: String(o.channel) });
    } catch (err) {
      console.error(`[aistyle] ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("documentary")
  .description("Documentary: research (your links, notes, Wikipedia) -> chapters -> narration -> fact check -> script.txt + factcheck.json")
  .requiredOption("-p, --project <name>", "project name")
  .option("--write", "research, write and fact-check the script")
  .action(async (o) => {
    const { writeDocumentary } = await import("./lib/formats/documentary.js");
    try {
      if (o.write) {
        const r = await writeDocumentary(String(o.project));
        // 2 = written, with claims that are not confirmed (shown to the creator).
        process.exitCode = r.factcheck.counts.not_found + r.factcheck.counts.unchecked > 0 ? 2 : 0;
      }
    } catch (err) {
      console.error(`[documentary] ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

const channelCmd = program.command("channel").description("Channel brief: who the channel is for and how it sounds (channels/<id>/brief.json + brief.md)");
channelCmd
  .command("init <id>")
  .description("Create or update a channel's brief. Missing answers are asked in the terminal (or kept / defaulted with --yes)")
  .option("--name <text>", "channel name")
  .option("--niche <text>", "niche, one line")
  .option("--audience <text>", "who watches")
  .option("--tone <text>", 'tone, e.g. "calm expert, no hype"')
  .option("--pillars <list>", "content pillars, separated by ;")
  .option("--banned <list>", "banned phrases, separated by ;")
  .option("--cta <text>", "call-to-action style")
  .option("--minutes <n>", "target length in minutes")
  .option("--wpm <n>", "reading speed, words per minute (default 150)")
  .option("--language <code>", "spoken language (en, de, ...)")
  .option("--rules <list>", "content rules, separated by ;")
  .option("-y, --yes", "do not ask; keep the saved / default value for anything not given")
  .action(async (id: string, o) => {
    const { createChannel } = await import("./lib/channels.js");
    const { listChannels } = await import("./lib/style.js");
    const { loadBrief, saveBrief, defaultBrief, targetWords } = await import("./lib/channelBrief.js");
    try {
      if (!listChannels().includes(id)) id = createChannel(id);
      const cur = loadBrief(id) ?? defaultBrief(id);
      const given: Record<string, unknown> = { name: o.name, niche: o.niche, audience: o.audience, tone: o.tone, pillars: o.pillars, bannedPhrases: o.banned, ctaStyle: o.cta, targetMinutes: o.minutes, wpm: o.wpm, language: o.language, rules: o.rules };
      const questions: [string, string, unknown][] = [
        ["name", "Channel name", cur.name],
        ["niche", "Niche (one line)", cur.niche],
        ["audience", "Who watches", cur.audience],
        ["tone", 'Tone (e.g. "calm expert, no hype")', cur.tone],
        ["pillars", "Content pillars (separate with ;)", cur.pillars.join("; ")],
        ["bannedPhrases", "Banned phrases (separate with ;)", cur.bannedPhrases.join("; ")],
        ["ctaStyle", "Call-to-action style", cur.ctaStyle],
        ["targetMinutes", "Target length in minutes", cur.targetMinutes],
        ["wpm", "Reading speed (words per minute)", cur.wpm],
        ["language", "Language (en, de, ...)", cur.language],
        ["rules", "Content rules (separate with ;)", cur.rules.join("; ")],
      ];
      if (!o.yes && process.stdin.isTTY) {
        const rl = (await import("node:readline/promises")).createInterface({ input: process.stdin, output: process.stdout });
        for (const [k, q, d] of questions) {
          if (given[k] !== undefined) continue;
          const a = (await rl.question(`${q} [${String(d ?? "")}]: `)).trim();
          if (a) given[k] = a;
        }
        rl.close();
      }
      const b = saveBrief(id, Object.fromEntries(Object.entries(given).filter(([, v]) => v !== undefined)));
      console.log(`[channel] ${id}: brief saved (channels/${id}/brief.json + brief.md), ${targetWords(b)} words per video at ${b.wpm} wpm`);
    } catch (err) {
      console.error(`[channel] ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });
channelCmd
  .command("show <id>")
  .description("Print a channel's brief (brief.md)")
  .action(async (id: string) => {
    const { loadBrief, briefToMd } = await import("./lib/channelBrief.js");
    const b = loadBrief(id);
    if (!b) {
      console.error(`[channel] "${id}" has no brief. Make one with: channel init ${id}`);
      process.exitCode = 1;
      return;
    }
    console.log(briefToMd(b));
  });

program
  .command("ideas")
  .description("Idea multiplier: why an outlier video went viral -> 15 new ideas for our channel (deduped against our past titles and competitor titles)")
  .requiredOption("--channel <id>", "our channel (its brief shapes the ideas)")
  .requiredOption("--from <videoId>", "the outlier video (from the last research scan, or any video with YOUTUBE_API_KEY / --title)")
  .option("--title <text>", "the video's title, when it is not in the research scan and there is no API key")
  .option("--no-transcript", "do not fetch the transcript")
  .action(async (o) => {
    const { ideaSource } = await import("./lib/agents/ideasSource.js");
    const { multiplyIdeas } = await import("./lib/agents/ideas.js");
    const { loadBrief } = await import("./lib/channelBrief.js");
    try {
      const { source, competitorTitles } = await ideaSource(String(o.from), { title: o.title, transcript: o.transcript !== false, log: console.log });
      const r = await multiplyIdeas(source, { channel: String(o.channel), brief: loadBrief(String(o.channel)), competitorTitles, log: console.log });
      console.log(`Why it worked (${r.why.triggers.join(", ")}): ${r.why.explanation}`);
      r.ideas.forEach((i, k) => console.log(`${String(k + 1).padStart(2)}. [${i.format}, ${i.trigger}, copy risk ${i.copyRisk}] ${i.workingTitle}\n    ${i.idea}`));
      if (r.dropped.length) console.log(`Dropped as too similar: ${r.dropped.map((d) => `"${d.workingTitle}" (${d.reason})`).join("; ")}`);
    } catch (err) {
      console.error(`[ideas] ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("thumbnails")
  .description("3 thumbnail concepts (subject, on-image text <= 4 words, emotion, contrast) from the title and the competitors' outlier thumbnails -> <project>/thumbnail_concepts.json")
  .requiredOption("-p, --project <name>", "project name")
  .option("--title <text>", "the title (default: the project's title)")
  .action(async (o) => {
    const { projectThumbnails } = await import("./lib/agents/thumbnailsRun.js");
    try {
      const r = await projectThumbnails(String(o.project), { title: o.title, log: console.log });
      r.concepts.forEach((c, i) => console.log(`${i + 1}. "${c.text}" | ${c.mainSubject} | ${c.emotion} | ${c.contrast}\n   ${c.why}`));
    } catch (err) {
      console.error(`[thumbnails] ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

const sopCmd = program.command("sop").description("Competitor SOP: learn a competitor's structure (hook, beats, rules) from 5-10 transcripts, never their wording");
sopCmd
  .command("build")
  .description("Build channels/<channel>/sop/<competitor>.json from transcripts")
  .requiredOption("--channel <id>", "our channel (the SOP is saved under it)")
  .requiredOption("--competitor <spec>", "a folder of .txt transcripts, a project with competitors/*.txt, or a YouTube channel id (UC..., needs YOUTUBE_API_KEY)")
  .option("--videos <n>", "how many transcripts (5-10 recommended)", "8")
  .action(async (o) => {
    const { competitorTranscripts } = await import("./lib/agents/sop/sources.js");
    const { buildSop, sopText } = await import("./lib/agents/sop/extract.js");
    try {
      const src = await competitorTranscripts(String(o.competitor), String(o.channel), Math.max(1, Math.min(20, Number(o.videos) || 8)));
      const sop = await buildSop({ channel: String(o.channel), competitor: src.competitor, transcripts: src.transcripts });
      console.log(sopText(sop));
    } catch (err) {
      console.error(`[sop] ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });
sopCmd
  .command("show")
  .description("Print a channel's SOP (the newest, or --competitor)")
  .requiredOption("--channel <id>", "our channel")
  .option("--competitor <id>", "which SOP (default: the newest)")
  .action(async (o) => {
    const { listSops, loadSop, sopText } = await import("./lib/agents/sop/extract.js");
    const s = loadSop(String(o.channel), o.competitor ? String(o.competitor) : undefined);
    if (!s) {
      console.error(`[sop] no SOP for ${o.channel}${o.competitor ? ` / ${o.competitor}` : ""}. Saved: ${listSops(String(o.channel)).join(", ") || "none"}`);
      process.exitCode = 1;
      return;
    }
    console.log(sopText(s));
  });

program
  .command("clips")
  .description("Shorts from a long video (workspace/<project>/clips/): --find = the best moments, ranked; --render = cut, reframe, caption -> output/<project>_clip_<rank>.mp4")
  .requiredOption("-p, --project <name>", "project name (made on /make > Shorts from a long video)")
  .option("--find", "find the moments (needs aligned.json: transcribe + align first)")
  .option("--render", "render the found Shorts")
  .option("--ranks <list>", "with --render: only these ranks, e.g. 1,3")
  .action(async (o) => {
    const { findClips, renderClips } = await import("./lib/shorts/longform.js");
    try {
      if (o.find) await findClips(String(o.project));
      if (o.render) {
        const ranks = o.ranks ? String(o.ranks).split(",").map(Number).filter((n) => n > 0) : undefined;
        const r = await renderClips(String(o.project), { ranks });
        // 2 = some Shorts failed (the others are kept).
        process.exitCode = r.some((c) => c.error && (!ranks || ranks.includes(c.rank))) ? 2 : 0;
      }
    } catch (err) {
      console.error(`[clips] ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("tutorial")
  .description("Tutorial from a screen recording (argo): --write = scenes + AI voice-over; --render = argo import, tts, export -> output/<project>.mp4")
  .requiredOption("-p, --project <name>", "project name")
  .option("--write", "find the scenes and write the voice-over")
  .option("--render", "make the video with argo")
  .action(async (o) => {
    const { writeTutorial, renderTutorial } = await import("./lib/formats/tutorial.js");
    try {
      if (o.write) await writeTutorial(String(o.project));
      if (o.render) await renderTutorial(String(o.project));
    } catch (err) {
      console.error(`[tutorial] ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("translate")
  .description("Language version: translate <project>/script_source.txt into the version's language (product names and numbers kept) -> script.txt + translation_report.json")
  .option("-p, --project <name>", "the language version project (made from the original in the wizard, or with --from)")
  .option("--from <project>", "make (or refresh) the language version of this original video first")
  .option("-l, --language <code>", "with --from: the language (de, es, fr, it, pt, hi, ur)")
  .action(async (o) => {
    const { createLanguageVersion, translateProject } = await import("./lib/localize/versions.js");
    if (!o.project && !o.from) {
      console.error("Pass -p <language version> or --from <original> -l <language>.");
      process.exitCode = 1;
      return;
    }
    const project = o.from ? createLanguageVersion(String(o.from), String(o.language ?? "")).project : String(o.project);
    process.exitCode = await translateProject(project);
  });

program
  .command("script")
  .description("Script writer: outline -> one call per product -> +-3% word count, sourced facts only, originality check")
  .requiredOption("-p, --project <name>", "project name (writes workspace/<name>/script.txt + script_report.json)")
  .requiredOption("-t, --topic <topic>", "video topic")
  .requiredOption("--products <list>", "comma-separated products, countdown order (last = #1)")
  .option("-w, --words <n>", "target words (default features.json script.targetWords)")
  .option("--sources <file>", "JSON {product: [page urls]} to read sourced facts from (default <project>/sources.json)")
  .option("--facts <file>", "JSON [{product,label,value,url,title}] (default <project>/facts_sources.json)")
  .option("--competitors <ids>", "comma-separated YouTube video ids whose transcripts the script must not copy")
  .option("--channel <id>", "channel whose brief (voice, audience, length) is used (default: the project's channel)")
  .option("--format <id>", "countdown (default), versus, myth-vs-reality, history-of, every-x-explained (--products = the items)")
  .option("--sop <competitor>", "follow this competitor SOP of the channel (default: the channel's newest SOP; \"none\" = no SOP)")
  .action(async (o) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { projectDir } = await import("./lib/project.js");
    const { writeScript } = await import("./lib/agents/script/index.js");
    const dir = projectDir(String(o.project));
    fs.mkdirSync(dir, { recursive: true });
    const readJ = (f: string) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : undefined);
    const competitors: string[] = [];
    const cdir = path.join(dir, "competitors");
    if (fs.existsSync(cdir)) for (const f of fs.readdirSync(cdir).filter((x) => x.endsWith(".txt"))) competitors.push(fs.readFileSync(path.join(cdir, f), "utf8"));
    if (o.competitors) {
      const { quickTranscript } = await import("./lib/agents/youtube/ytExtractor.js");
      for (const id of String(o.competitors).split(",").map((x) => x.trim()).filter(Boolean)) {
        const t = await quickTranscript(`https://www.youtube.com/watch?v=${id}`).catch(() => null);
        if (t?.words.length) {
          const text = t.words.map((w) => w.text).join(" ");
          competitors.push(text);
          fs.mkdirSync(cdir, { recursive: true });
          fs.writeFileSync(path.join(cdir, `${id}.txt`), text);
        } else console.warn(`[script] no transcript for ${id}`);
      }
    }
    const { loadBrief } = await import("./lib/channelBrief.js");
    const pj = path.join(dir, "project.json");
    const proj = fs.existsSync(pj) ? (JSON.parse(fs.readFileSync(pj, "utf8")) as Record<string, unknown>) : {};
    const channel = o.channel ? String(o.channel) : typeof proj.channel === "string" ? proj.channel : undefined;
    if (o.channel) fs.writeFileSync(pj, JSON.stringify({ ...proj, channel }, null, 2));
    const brief = loadBrief(channel);
    if (channel && !brief) console.warn(`[script] channel "${channel}" has no brief (channels/${channel}/brief.json): writing without one. Make it with: channel init ${channel}`);
    const { loadSop } = await import("./lib/agents/sop/extract.js");
    const sop = channel && o.sop !== "none" ? loadSop(channel, o.sop ? String(o.sop) : undefined) : null;
    if (o.sop && o.sop !== "none" && !sop) console.warn(`[script] no SOP "${o.sop}" for channel ${channel}: writing without one`);
    if (sop) console.log(`[script] following the SOP learned from ${sop.competitor} (${sop.stats.videos} videos)`);
    const { isFormat, itemsProblem } = await import("./lib/agents/script/formats.js");
    const format = isFormat(o.format) ? o.format : isFormat(proj.format) ? (proj.format as typeof o.format) : "countdown";
    if (o.format && !isFormat(o.format)) console.warn(`[script] unknown format "${o.format}": countdown`);
    const items = String(o.products).split(",").map((x: string) => x.trim()).filter(Boolean);
    const bad = itemsProblem(format, items);
    if (bad) {
      console.error(`[script] ${bad}`);
      process.exitCode = 1;
      return;
    }
    const { report } = await writeScript(dir, {
      brief,
      sop,
      format,
      topic: String(o.topic),
      products: String(o.products).split(",").map((x) => x.trim()).filter(Boolean),
      targetWords: o.words ? Number(o.words) : undefined,
      sources: readJ(o.sources ?? path.join(dir, "sources.json")),
      factsFile: o.facts ?? path.join(dir, "facts_sources.json"),
      competitors,
    });
    process.exitCode = report.withinTolerance && !report.claims.unsourced.length && (report.originality?.clean ?? true) ? 0 : 2;
  });

program
  .command("avatar")
  .description("AI avatar clips (intro / outro / bridges) from channels/<id>/avatar.png into timeline.json (features.json avatar)")
  .requiredOption("-p, --project <name>", "project name")
  .option("--force", "run even when features.json avatar.enabled is false")
  .action(async (o) => {
    const { avatar } = await import("./commands/avatar.js");
    process.exitCode = await avatar({ project: String(o.project), force: !!o.force });
  });

program
  .command("shorts")
  .description("Cut 3 vertical Shorts (30-58 s, captions) from the rendered video at the strongest hooks")
  .requiredOption("-p, --project <name>", "project name")
  .option("--video <file>", "source video (default output/<project>.mp4)")
  .action(async (o) => {
    const { shorts } = await import("./commands/shorts.js");
    process.exitCode = await shorts({ project: String(o.project), video: o.video });
  });

program
  .command("doctor")
  .description("Check Python, FFmpeg, NVENC, GPU, RAM, disk and .env")
  .action(async () => {
    process.exitCode = await doctor();
  });

program
  .command("test-nvenc")
  .description("Render a 5-second 1080p NVENC test clip to output/")
  .action(async () => {
    process.exitCode = await testNvenc();
  });

program
  .command("tts")
  .description("[0] Mode B (script only): narrate the script with TTS_PROVIDER (elevenlabs | openai | piper)")
  .requiredOption("-p, --project <name>", "project name")
  .option("-s, --script <file>", "script text (default workspace/<project>/script.txt)")
  .option("-g, --glossary <file>", "glossary with 'Name = spoken form' pronunciations (default inputs/glossary.txt)")
  .option("-f, --force", "ignore cache and redo")
  .action(async (o) => {
    process.exitCode = await tts(o);
  });

program
  .command("transcribe")
  .description("[1] Whisper word timestamps -> workspace/<project>/words.json")
  .option("-a, --audio <file>", "voiceover file (default inputs/voiceover.mp3)")
  .option("-p, --project <name>", "project name (default: audio file name)")
  .option("-g, --glossary <file>", "product-name glossary (default inputs/glossary.txt)")
  .option("-m, --model <name>", "whisper model (default WHISPER_MODEL or large-v3-turbo)")
  .option("-l, --language <code>", "spoken language (default: the project's language, else en)")
  .option("-f, --force", "ignore cache and redo")
  .action(async (o) => {
    process.exitCode = await transcribe(o);
  });

program
  .command("align")
  .description("[2] Align script to words (or clean transcript with glossary) -> aligned.json")
  .requiredOption("-p, --project <name>", "project name")
  .option("-s, --script <file>", "script text (default inputs/script.txt if present)")
  .option("--no-script-mode", "voice-only mode even if a script exists")
  .option("-g, --glossary <file>", "product-name glossary (default inputs/glossary.txt)")
  .option("-f, --force", "ignore cache and redo")
  .action(async (o) => {
    process.exitCode = await align({ ...o, noScript: o.scriptMode === false });
  });

program
  .command("plan")
  .description("[3] Scene planner: 6-12s scenes, listicle sections, types + queries -> scenes.json")
  .requiredOption("-p, --project <name>", "project name")
  .option("-c, --channel <name>", "channel style profile (default from project or 'default')")
  .option("--no-llm", "heuristic labels only (no API call)")
  .option("-f, --force", "ignore cache and redo")
  .action(async (o) => {
    process.exitCode = await plan({ ...o, noLlm: o.llm === false });
  });

program
  .command("assets")
  .description("[4] Footage per scene: own footage -> press kit -> Pexels/Pixabay -> graphic; writes license_log.csv")
  .requiredOption("-p, --project <name>", "project name")
  .option("-f, --force", "ignore cache and redo")
  .action(async (o) => {
    process.exitCode = await assets(o);
  });

program
  .command("timeline")
  .description("[5] scenes + assets + style -> timeline.json (hand-editable)")
  .requiredOption("-p, --project <name>", "project name")
  .option("-f, --force", "ignore cache and redo")
  .action(async (o) => {
    process.exitCode = await timeline(o);
  });

program
  .command("render")
  .description("[6] Render output/<project>.mp4: per-scene segments (NVENC, x264 fallback), captions, ducked music")
  .requiredOption("-p, --project <name>", "project name")
  .option("--limit <seconds>", "render only the first N seconds (quick preview)")
  .option("-f, --force", "re-render every segment")
  .option("--scene <ids>", "re-render only these scene ids (comma separated), reuse every other cached segment")
  .action(async (o) => {
    const scenes = o.scene ? String(o.scene).split(",").map((x: string) => Number(x.trim())).filter((x: number) => Number.isInteger(x) && x >= 0) : undefined;
    process.exitCode = await render({ project: o.project, force: o.force, limitSeconds: o.limit ? Number(o.limit) : undefined, scenes });
  });

program
  .command("qa")
  .description("[7] Automatic checks on output/<project>.mp4 + description / pinned comment -> report.md")
  .requiredOption("-p, --project <name>", "project name")
  .option("--preflight", "only the pre-render gate (assets, licences, product matches, discrepancies) -> preflight.json")
  .action(async (o) => {
    process.exitCode = o.preflight ? await qaPreflight(o) : await qa(o);
  });

program
  .command("harvest-model")
  .description("Exact-model vault: real B-roll clips + stills of one model from YouTube (talking heads removed) -> workspace/models/<brand>_<model>/")
  .requiredOption("--brand <name>", "manufacturer, e.g. \"Scag\"")
  .requiredOption("--model <name>", "exact model, e.g. \"Turf Tiger II\" (video titles must contain it)")
  .option("--features <list>", "comma-separated features to look for, e.g. \"deck,engine,zero turn,blades\"")
  .option("--category <words>", "kind of machine for the CLIP prompt", "lawn mower")
  .option("--exclude <list>", "other models to keep out (comparison videos), comma-separated")
  .option("--max-videos <n>", "videos to cut from (default HARVEST_MAX_VIDEOS or 6)")
  .option("--windows <n>", "windows downloaded per video (default 4)")
  .option("-f, --force", "re-process videos that were already harvested")
  .option("--rescore", "only re-check the clips already in the vault with the current filter (no downloads)")
  .option("--keyword <spec>", "caption mode: only 3-5 s clips around where this spec is spoken, e.g. \"brushless motor\"")
  .option("--aliases <list>", "other ways the keyword is said (caption mode), comma-separated")
  .action(async (o) => {
    const list = (v?: string) => (v ? String(v).split(",").map((x) => x.trim()).filter(Boolean) : undefined);
    try {
      if (o.rescore) {
        await rescoreVault(o.brand, o.model, console.log);
        return;
      }
      if (o.keyword) {
        const r = await harvestKeyword({
          brand: o.brand, model: o.model, keyword: o.keyword, aliases: list(o.aliases), category: o.category, otherModels: list(o.exclude),
          maxVideos: o.maxVideos ? Number(o.maxVideos) : undefined, force: o.force, log: console.log,
        });
        process.exitCode = r.added ? 0 : 1;
        return;
      }
      const r = await harvestModel({
        brand: o.brand, model: o.model, features: list(o.features), category: o.category, otherModels: list(o.exclude),
        maxVideos: o.maxVideos ? Number(o.maxVideos) : undefined, windowsPerVideo: o.windows ? Number(o.windows) : undefined, force: o.force, log: console.log,
      });
      const clips = r.manifest.items.filter((i) => i.kind === "video").length;
      console.log(`[harvest] vault: ${clips} clip(s), ${r.manifest.items.length - clips} still(s) -> ${r.dir}`);
      process.exitCode = clips ? 0 : 1;
    } catch (err) {
      console.error(`[harvest] FAILED: ${String((err as Error).message ?? err)}`);
      process.exitCode = 1;
    }
  });

program
  .command("fetch-model")
  .description("Download the Whisper model with resume + retry (one time)")
  .argument("[name]", "model name (default WHISPER_MODEL or large-v3-turbo)")
  .action(async (name) => {
    process.exitCode = await fetchModel(name);
  });

program
  .command("serve")
  .description("Open the local web app (upload voiceover, run pipeline, review scenes)")
  .option("--port <n>", "port", "4173")
  .action(async (o) => {
    await serve(Number(o.port));
  });

program
  .command("worker")
  .description("Run pipeline stage workers without the web app (needs REDIS_URL; machines must share the workspace folder)")
  .option("--stages <list>", "plan,sourcing,render (default: all)", "all")
  .action(async (o) => {
    await runWorkers(workerStages(o.stages));
  });

program
  .command("make-test-audio", { hidden: false })
  .description("[dev] Synthetic voiceover + truth timings in inputs/test/ (Windows TTS)")
  .option("--minutes <n>", "target length", "25")
  .option("--out-dir <dir>", "output folder (default inputs/test)")
  .action(async (o) => {
    process.exitCode = await makeTestAudio(o);
  });

program
  .command("eval-drift")
  .description("[dev] Compare aligned.json timings with truth.json")
  .requiredOption("-p, --project <name>", "project name")
  .requiredOption("-t, --truth <file>", "truth.json from make-test-audio")
  .action(async (o) => {
    process.exitCode = await evalDrift(o);
  });

await program.parseAsync();
// A finished step must exit: the shared Redis connection (rate limiter / job state) would keep it alive.
await closeRedis();
