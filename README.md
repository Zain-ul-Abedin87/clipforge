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
- [~] VidRush M1 "voice + script -> edit" (branch `m1-vidrush-edit`): video types (Documentary / Explainer / Breakdown / Listicle) with their own pacing, footage-source switch ("Stock + CC" or "CC & public domain only"), YouTube Creative Commons source (15 s pieces, licence re-checked on the watch page), plan approval with estimate before footage is fetched, per-scene search edits, next-best option when a download fails
- [x] M6 Channel profiles (website: style, logo watermark, music with licence notes, new channels) + batch queue: 3 videos queued and built one after another (QA 0 failures each); planner now enforces the niche card share and keeps B-roll moving

## Use it

```
cd D:\YT_CODE_Base\clipforge
npm run serve
```
Open http://localhost:4173, drop a voiceover, paste the script, pick the video type and footage sources, press
**Upload & start**. Steps 1-3 run, then the **plan review** appears: scene count and mix, pacing, footage sources,
Claude cost so far and an estimated time. Change any scene's searches (✎ Edit searches in the Scenes list), then
press **Approve plan & make video**. Untick "Show me the plan..." to run all 7 steps without stopping.

## Plan approval (before any footage is fetched)

- The approval is tied to the exact `scenes.json`: re-planning (e.g. a new video type) asks for approval again.
- Search edits are saved in `plan_edits.json` and come back after a re-plan (same start time + same words); the AI
  Footage Agent keeps edited searches instead of writing its own.
- Batch runs never stop for approval. Projects made before this feature run straight through as before.

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

**Web research** (`src/lib/agent/webResearch.ts`, needs ANTHROPIC_API_KEY, `WEB_RESEARCH=off` disables it):
Claude with the web search tool finds the maker's own product page and official press / newsroom pages for each
product (any brand - no entry in `official.brands` needed), plus 3-4 short spec facts. The importer tries the
brand table first, then these pages (robots.txt respected) until it has 3 photos. Saved in
`channels/<ch>/presskit/<product>/research.json` for 30 days. Model: `WEB_RESEARCH_MODEL` (default Opus 5.5,
about $0.20 per new product, measured on 5 guns).

**Product motion graphics:** the first real shot of each product shows its spec facts as chips sliding in on the
right (`renderSpecChip`). Non-16:9 product photos get a parallax showcase: a studio gradient (cut-out photos) or
blurred copy as backdrop drifting one way, the whole photo with a soft shadow growing and drifting the other way;
with chips the product sits left of centre. `PRODUCT_PARALLAX=off` restores the single blurred still.

**AI Footage Agent** (`src/lib/agent/footage.ts`, needs ANTHROPIC_API_KEY, `FOOTAGE_AGENT=off` disables it): Claude
reads every scene and writes 4 searches, exact -> broad (e.g. "ruger security 9 pistol" -> "compact 9mm pistol
shooting range" -> "handgun magazine close up" -> "shooting range target practice"), plus one ideal-shot sentence
that CLIP compares the thumbnails to. Scenes whose best clip is still a weak CLIP match get a second round: Claude
sees what came back (e.g. "burger, food") and writes different searches. Clearly unrelated picks (CLIP < 0.19) are
replaced by a well-matched clip from the same section. Plans are cached in `agent_footage.json`.
B-roll scenes: own footage -> the niche's stock order (niches/*.json stock.sources: pixabay, pexels, unsplash photos, wikimedia_video, archive, youtube_cc) pool, ranked by CLIP (python/clip_score.py looks at each
candidate thumbnail vs the narration) -> weak matches reuse a nearby well-matched clip.

**Footage sources switch** (per project, website): "Stock + CC / public domain" uses the video type's own order;
"CC & public domain only" keeps only own clips, Wikimedia Commons, Archive.org and YouTube CC.

**YouTube Creative Commons** (`youtube_cc`, `python/youtube_cc.py` + `src/lib/assets/youtube.ts`): needs yt-dlp in
.venv. YouTube search with its Creative Commons filter; the picked video's watch page must say "Creative Commons"
or it is skipped (the next-best option is used). Only a 15 s piece (~35% in), video only, is downloaded - never the
full upload. Logged as CC BY with the channel name; QA adds the credit to the description and warns you to check
each uploader (re-uploads are sometimes mislabelled CC). Optional `YTDLP_PROXY=http://user:pass@ip:port`;
`YTCC_MAX_SEARCHES` (default 40) caps live searches per run on slow connections.

**General web crawl** (`web_crawl`, `python/web_crawl.py` + `src/lib/assets/webCrawl.ts`, VidRush-style): for a
scene's searches it queries YouTube (`ytsearch`, any licence) and DuckDuckGo video results on sites yt-dlp supports
(Vimeo, Dailymotion, archive.org; `WEBCRAWL_SITES`). The best hits get a 45 s **360p preview** piece, which
`python/split_shots.py` (PySceneDetect ContentDetector) cuts into shots (shots < `SHOT_MIN_SECONDS`=1.5 s are dropped);
every shot is its own candidate with 3 frames. Only the **picked shot** is fetched in HD (download range, no audio).
Respects `YTDLP_PROXY`. Licence is logged as `unknown/web` with URL + uploader in license_log.csv, and QA warns
"Web-crawled footage (copyright risk)". **You may not have the right to use these clips** (Content ID claims,
strikes, demonetisation) - review each one. Listed last in `niches/documentary.json` and `general.json`; by default
(`WEBCRAWL_MODE=fallback`) it is only searched when the other sources found < `WEBCRAWL_WHEN_FEWER` candidates.
"CC & public domain only" projects never use it. `WEB_CRAWL=off` disables it.

**Multi-frame CLIP** (`python/clip_score.py`): a candidate may carry up to 3 frames; its score is the best frame.
`CLIP_MODEL` picks the fastembed model (`clip-ViT-B-32` default, `jina-clip-v1`, or `text,vision`).

**Vision verify** (`src/lib/agent/visionVerify.ts`): the top `VISION_VERIFY_TOP` (3) CLIP candidates per scene are shown
to Claude (`LLM_MODEL`) with the narration line; it answers fits yes/no and the best candidate that passes is used.
Cached in `<project>/vision_verify.json`. On by default when ANTHROPIC_API_KEY is set (`VISION_VERIFY=off`).

**Footage library** (`src/lib/assets/footageLibrary.ts`): every downloaded pick is stored with its CLIP embedding,
source, URL and licence in `cache/footage_library.sqlite` (Node's built-in `node:sqlite`; JSON fallback). Each scene
checks the library first and reuses a clip when similarity >= `LIBRARY_MIN_MATCH` (0.27). `FOOTAGE_LIBRARY=off` disables it.

Archive.org: only a 15 s piece of a film is fetched (FFmpeg range reads, 30 s network timeout, 2 min hard limit).
Licences kept for stock: public domain, CC0, CC BY, CC BY-SA (no NC/ND); CC BY needs a credit in the description.
Unsplash needs UNSPLASH_ACCESS_KEY (free); downloads are registered with Unsplash as their API terms require.

## Video types (niches/*.json)

Each upload picks a rule set: `documentary`, `explainer`, `breakdown`, `listicle`, `guns` (Top-X firearm
listicles) or `general`. Optional `scenes` sets the type's pacing (documentary 6-14 s shots, explainer /
breakdown / listicle 5-10 s; otherwise the channel's style.json). `structure.detectListicle: false` keeps
"number one..." phrases from splitting a documentary into list items. A rule set also controls
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
| plan_edits.json | plan review | footage searches you changed before approving |
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
