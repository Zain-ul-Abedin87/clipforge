import { Command } from "commander";
import { align } from "./commands/align.js";
import { assets } from "./commands/assets.js";
import { render } from "./commands/render.js";
import { timeline } from "./commands/timeline.js";
import { qa } from "./commands/qa.js";
import { evalDrift, makeTestAudio } from "./commands/devTools.js";
import { doctor } from "./commands/doctor.js";
import { fetchModel } from "./commands/fetchModel.js";
import { plan } from "./commands/plan.js";
import { serve } from "./server/server.js";
import { testNvenc } from "./commands/testNvenc.js";
import { transcribe } from "./commands/transcribe.js";

const program = new Command();

program.name("clipforge").description("Voiceover -> faceless YouTube video pipeline").version("0.0.1");

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
  .action(async (o) => {
    process.exitCode = await render({ project: o.project, force: o.force, limitSeconds: o.limit ? Number(o.limit) : undefined });
  });

program
  .command("qa")
  .description("[7] Automatic checks on output/<project>.mp4 + description / pinned comment -> report.md")
  .requiredOption("-p, --project <name>", "project name")
  .action(async (o) => {
    process.exitCode = await qa(o);
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
