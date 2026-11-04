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
  .action(async (o) => {
    const { runTitles } = await import("./lib/research/index.js");
    const r = await runTitles(String(o.topic));
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
  .command("script")
  .description("Script writer: outline -> one call per product -> +-3% word count, sourced facts only, originality check")
  .requiredOption("-p, --project <name>", "project name (writes workspace/<name>/script.txt + script_report.json)")
  .requiredOption("-t, --topic <topic>", "video topic")
  .requiredOption("--products <list>", "comma-separated products, countdown order (last = #1)")
  .option("-w, --words <n>", "target words (default features.json script.targetWords)")
  .option("--sources <file>", "JSON {product: [page urls]} to read sourced facts from (default <project>/sources.json)")
  .option("--facts <file>", "JSON [{product,label,value,url,title}] (default <project>/facts_sources.json)")
  .option("--competitors <ids>", "comma-separated YouTube video ids whose transcripts the script must not copy")
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
    const { report } = await writeScript(dir, {
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
