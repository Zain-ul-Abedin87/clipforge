# ClipForge

Local pipeline: English voiceover -> finished 1920x1080 faceless YouTube video.

## Status

- [x] M0 Setup (Python 3.11, FFmpeg + NVENC, scaffold, `.env` template)
- [x] M1 Transcribe + align: 25-min audio, p95 sentence-start error 0.032s (script and voice-only modes)
- [x] M2 Scene planner (6-12s scenes, listicle sections, schema validation)
- [x] Web app: upload voiceover, run pipeline, review scenes/transcript
- [x] M3 Asset resolver + license log: own footage -> press kit -> Pexels/Pixabay -> graphic; one license_log.csv row per scene
- [x] M4 Renderer: per-scene segments (NVENC, x264 fallback, cached), burned captions, ducked music, -14 LUFS; 5-min test A/V diff 0.00 s
- [~] M4.5 Editor quality: CLIP thumbnail ranking (local, free), weak-match reuse of nearby clips, Wikimedia Commons product photos, press-kit box, blurred-background fit for product stills motion graphics: animated card text, lower thirds, rank badges, flash transitions, synthesized whoosh/pop SFX (style.json motionGraphics)
- [x] M5 Full render + review page: 24.9-min video rendered in 481 s (44872/44872 frames, A/V diff 0.033 s, 58 SFX); render used ~2.8 GB RAM (lowest 0.29 GB free -> now auto 1 segment at a time when RAM is low); scene swap + caption fix re-render 1 of 30 segments
- [x] Step 7 QA: file/picture/sound/caption/originality/licence/product checks (report.md), description + chapters + pinned comment, AI-disclosure decision, approval gate (invalidated by a re-render); black-frame guard in assets re-cuts or auto-replaces clips
- [x] AI Footage Agent + official photo importer: 9/12 demo products got verified manufacturer photos (3 sites answer 403)
- [x] M6 Channel profiles (website: style, logo watermark, music with licence notes, new channels) + batch queue: 3 videos queued and built one after another (QA 0 failures each); planner now enforces the niche card share and keeps B-roll moving

## Use it

```
cd D:\YT_CODE_Base\clipforge
npm run serve
```
Open http://localhost:4173, drop a voiceover, optionally paste the script, press **Upload & start**.

## CLI (every step caches its output; `--force` redoes it)

```
npx tsx src/cli.ts doctor
npx tsx src/cli.ts transcribe --audio inputs/voiceover.mp3 --project myvideo
npx tsx src/cli.ts align --project myvideo [--script inputs/script.txt | --no-script-mode]
npx tsx src/cli.ts plan --project myvideo [--no-llm]
npx tsx src/cli.ts assets --project myvideo
npx tsx src/cli.ts timeline --project myvideo
npx tsx src/cli.ts render --project myvideo [--limit 60]
npx tsx src/cli.ts qa --project myvideo
npx tsx src/cli.ts serve
```

Dev/test helpers:
```
npx tsx src/cli.ts make-test-audio --minutes 28      # synthetic voiceover + truth timings (Windows TTS)
npx tsx src/cli.ts eval-drift --project X --truth inputs/test/truth.json
```

## Channels and batch (website)

- **Channels panel:** create a channel (copy of another), set default video type, colours, captions, music level/dip,
  motion graphics/SFX, logo (corner watermark, position + opacity) and music tracks (licence note required).
- **Batch panel:** drop several voiceovers (+ a same-named .txt as script), pick channel + video type, "Upload & queue".
  Videos run one at a time through all 7 steps; a failure does not stop the queue; state is in workspace/queue.json
  so a restart resumes. Pause / resume / retry / remove from the panel.

## Review page (fix things without re-rendering everything)

- **Swap footage:** every footage scene has a "Swap footage" button: pick another saved option (sorted by CLIP match)
  or search new footage. Only that scene's segment re-renders; swaps are saved in `overrides.json` and survive re-runs.
- **Fix captions:** double-click a word in the Transcript tab, then "Apply caption fixes". Saved in `word_edits.json`
  (re-applied if Align runs again); only scenes whose captions changed re-render.

## Footage selection

My clips (website): upload your own or permitted clips/photos with a required source note. Product footage goes to
`channels/<ch>/footage/<product>/`, B-roll to `footage/<keywords>/`; they are tier 1 (used before anything else).
B-roll matches the scene's main visual phrase only (60% of its words).

Product scenes (guns): own footage -> press kit (website "Press kit" box: paste a direct file link) ->
official photos -> Wikimedia Commons photo of the exact model (CC licence, author logged; maps/diagrams/military
shots filtered) -> footage of the same type of gun (the lower third names the product).

**Official photo importer** (`src/lib/assets/official.ts`, step 4 runs it for products without media; also the
"Find official photos" button in the Press kit box): brand -> manufacturer site (`niches/guns.json` `official.brands`)
-> product page from the site's sitemap, or a crawl of the homepage + up to 30 category pages when there is no
sitemap -> photos into `channels/<ch>/presskit/<product>/` with the page logged as source. With the agent on, Claude
picks the right page when the match is ambiguous and looks at the page's images to keep only photos of that product.
robots.txt is respected; sites that answer 403 (Mossberg, PSA) are skipped - add those photos by hand. YouTube
links on the product page are saved to `youtube_links.txt` for you; nothing is downloaded from YouTube. A product is
retried after 7 days (`presskit/official_tried.json`). Manufacturer photos are logged as editorial/review use.

**AI Footage Agent** (`src/lib/agent/footage.ts`, needs ANTHROPIC_API_KEY, `FOOTAGE_AGENT=off` disables it): Claude
reads every scene and writes 4 searches, exact -> broad (e.g. "ruger security 9 pistol" -> "compact 9mm pistol
shooting range" -> "handgun magazine close up" -> "shooting range target practice"), plus one ideal-shot sentence
that CLIP compares the thumbnails to. Scenes whose best clip is still a weak CLIP match get a second round: Claude
sees what came back (e.g. "burger, food") and writes different searches. Clearly unrelated picks (CLIP < 0.19) are
replaced by a well-matched clip from the same section. Plans are cached in `agent_footage.json`.
B-roll scenes: own footage -> the niche's stock order (niches/*.json stock.sources: pixabay, pexels, unsplash photos, wikimedia_video, archive) pool, ranked by CLIP (python/clip_score.py looks at each
candidate thumbnail vs the narration) -> weak matches reuse a nearby well-matched clip.

Archive.org: only a 15 s piece of a film is fetched (FFmpeg range reads, 30 s network timeout, 2 min hard limit).
Licences kept for stock: public domain, CC0, CC BY, CC BY-SA (no NC/ND); CC BY needs a credit in the description.
Unsplash needs UNSPLASH_ACCESS_KEY (free); downloads are registered with Unsplash as their API terms require.

## Video types (niches/*.json)

Each upload picks a rule set: `guns` (Top-X firearm listicles) or `general`. A rule set controls
B-roll hints (word list -> stock search), blocked stock terms (toys, airsoft, war...), where product
footage may come from (guns: never generic stock), per-item graphic limits and the Claude guidance.
Add a new type by copying `niches/general.json`.

## Files per project (`workspace/<project>/`)

| file | step | contents |
|---|---|---|
| words.json | 1 | `[{word,start,end,prob}]` from Whisper |
| aligned.json | 2 | words with script spelling + sentences + glossary corrections |
| scenes.json | 3 | `[{id,start,end,text,type,queries[],product_name?,graphic?}]` |
| sections.json | 3 | intro / item #N (product) / outro |
| plan_report.json | 3 | lengths, type mix, validation, LLM cost |
| assets.json | 4 | per scene: file path, source, license, url, clip in-point |
| license_log.csv | 4 | one row per scene: source, license, url, author |
| graphics/, thumbs/ | 4 | generated cards (PNG) and review thumbnails |
| timeline.json | 5 | hand-editable: per scene clip in-point, motion, transition; captions + music settings |
| render/ | 6 | cached per-scene segments (only changed scenes re-render), captions.ass |
| render_report.json | 6 | durations, A/V diff, frames, size, render time, RAM used |
| qa_report.json, report.md | 7 | automatic checks + publish texts |
| publish/ | 7 | description.txt, pinned_comment.txt, chapters.txt |
| approval.json | review | human approval, tied to the rendered file |
| candidates.json | 4 | swap options per scene (with CLIP match) |
| overrides.json, word_edits.json | review | manual footage swaps and caption fixes |

Final video: `output/<project>.mp4`. The `test` channel only holds a synthetic music tone for testing ducking.

## Important: GPU crashes during transcription are handled

On this laptop CUDA sporadically fails with `cudaErrorIllegalInstruction` / `cudaErrorIllegalAddress`
(every few minutes of audio). Transcription therefore runs in ~5-minute chunks with checkpoints:
a crash restarts a fresh worker that continues from the last finished chunk, and a chunk that fails
twice on the GPU runs on the CPU. The CUDA allocator is forced to `cub_caching` (the default
`cuda_malloc_async` aborted the process), and Whisper `hotwords` are not used (they also aborted it).

## Important: FFmpeg version is pinned to 7.1.1

FFmpeg 8.1.2+ / 9.x builds need NVENC API 13.1 (NVIDIA driver 610+).
This laptop's driver (596.08) only has API 13.0, so NVENC fails on newer builds.
FFmpeg is pinned in winget (`winget pin list`). After updating the NVIDIA driver to
610+, you can unpin and upgrade: `winget pin remove --id Gyan.FFmpeg -e`.

## Layout

```
niches/                 video-type rule sets (guns.json, general.json)
inputs/                 glossary.txt (+ test/ synthetic voiceover)
channels/<name>/        style.json, footage/, presskit/<brand>/ (+ sources.json: {"url","license"}), music/, logo/
cache/                  stock search results + downloaded clips (shared by all projects)
workspace/<video>/      per-video step outputs
models/                 Whisper model cache (downloaded once)
src/                    Node/TypeScript orchestrator, CLI, web server
web/                    web app (HTML/CSS/JS, no build step)
python/                 Whisper worker
tools/                  test-data generator
```
