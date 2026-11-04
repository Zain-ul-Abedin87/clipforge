# Phase log: full pipeline v2 (YtHunter-style workflow)

Branch: `feature/full-pipeline-v2`, created from `origin/feature/general-web-crawler` (the newest
remote branch, 2026-10-20). Each phase ends with `npm run typecheck` + `npm test`, a commit, a push
and an entry here.

---

## Phase 0: Fix current issues

**What changed**

- `qwen.numCtx` default is now **8192** (`DEFAULT_NUM_CTX`); 16384 spilled a 7B model ~36% to the CPU.
  Every hard-coded `|| 16384` fallback is gone.
- New **model loader** `src/lib/models/loader.ts`:
  - Before a local model is used, every *other* resident model is unloaded (`/api/ps` +
    `keep_alive: 0`), so the text model and the vision model are never in VRAM together.
  - VRAM guard: `nvidia-smi --query-gpu=memory.free,memory.total` before loading. If free VRAM
    stays below the estimate (or `models.minFreeVramMb`), it waits up to 5 s for the unloads to
    land, then logs a warning. It never blocks the run.
  - A stage model that is not pulled falls back to `qwen.model` / `qwen.visionModel`, with a log
    line.
  - Logs `[models] stage=<stage> model=<m> gpu load=<ms> gpu_time=<ms>` for every request. Per-stage
    totals are added to `cache/gpu_time.json` (Phase 9 shows these as GPU-time "cost").
  - The CLI `preAction` hook sets the stage from the command (plan, assets, timeline→labels, qa).
    The `postAction` hook unloads the stage's model (`models.unloadAfterStage`), so Whisper, TTS and
    render get the VRAM.
  - Turned off in unit tests (`NODE_TEST_CONTEXT`) and with `MODEL_LOADER=off`.
- **Per-stage models** in `llm_settings.json` → `"stages"`: niche/titles/script default to
  `qwen3:8b`, plan/labels keep your `qwen.model` at numCtx 8192, vision uses `qwen.visionModel` (or
  `stages.vision.model`, e.g. `qwen2.5vl:3b` / `gemma3:4b`), embed uses `nomic-embed-text`. Any
  stage can set `{ "model": "...", "numCtx": ... }`. For example, `deepseek-r1:8b` for `script` is
  an option, not a default.
- **Vision and QA frame checks: 1-2 images per request.** New setting `qwen.maxImages` (default 2)
  and a new helper `runImageBatches` (packs units by image count, then runs each pack through
  `splitWhenTooBig`). A 413 or a garbage answer halves the pack down to one image. A pack is no
  longer skipped.
  - `visionVerify.ts`: one unit = one candidate. A local model sees 1-2 frames per candidate.
    Before this change, one scene × 3 candidates × 3 frames = 9 images, ~10.8K tokens > 8K, so
    every request hit 413 and the check was skipped.
  - `frameCheck.ts` (QA), `editor.ts` (stock thumbnail vetting) and `official.ts` (official photo
    picker) all use the same packing.
- **Garbage or empty answer: GPU halving first, on every call path** (`localChat`):
  1. inside `splitWhenTooBig` (or `splittable()`) with more than one item: returns 422 "split it",
     and the caller halves the request on the GPU;
  2. a single request: one more GPU try with a smaller context (`retryCtx`: half when it fits),
     after unloading the runner;
  3. only after that the CPU. The log line is now "GPU returned garbage **twice**".
  - The planner labels (`label.ts`, which already halves its batches itself) now marks its
    requests as splittable. `footage.ts` (`planFootage`, `broadenFootage`) now goes through
    `splitWhenTooBig`.
- **Repeats**
  - Pacing, forced repeat: picks the least-used clip (the own clip wins ties; never the clip shown
    just before). No clip goes past `MAX_CLIP_USES` (default 2) while another clip is still under
    it.
  - Pacing writes `<project>/pacing_stats.json` (`forcedReuse`, the list, `overCap`).
  - QA: new check **"Forced reuse (fail above 20)"** (warn at 1-20).
  - QA "Repeated on-screen segments" (identical-scene pairs, CLIP > 0.97): **fail above 20**,
    warn at 1-20. Before this change, a single pair failed it.
  - QA "Repeated clip segments": fails when a source moment is shown **more than 2 times** or
    when there are more than 20 repeats. Below that it warns.

**Files**: `src/lib/models/loader.ts` (new), `src/lib/agents/llm/settings.ts`,
`src/lib/agents/llm/llm.ts`, `src/lib/agent/{visionVerify,frameCheck,editor,official,footage}.ts`,
`src/lib/planner/label.ts`, `src/lib/pacing.ts`, `src/lib/qaGate.ts`, `src/commands/{qa,timeline}.ts`,
`src/cli.ts`, `tests/models.test.ts` (new), `tests/llmBudget.test.ts`, `tests/llm.test.ts`,
`tests/pacing.test.ts`.

**Checks**: `npm run typecheck` passes. `npm test`: 282 tests, 281 pass, 0 fail, 1 skipped (that
test was already skipped before this phase).

**How to verify on your PC**

```bash
ollama pull qwen3:8b
ollama pull qwen2.5vl:3b
ollama pull nomic-embed-text
npm run cf -- plan -p <project>
ollama ps
```

- `ollama ps` (in a second terminal while a step runs) should show **one** model at `100% GPU`.
- In `workspace/<project>/run.log`, look for the `[models] stage=... gpu_time=...` lines.
- There should be no `GPU returned garbage twice` line, and `[vision] verified N candidate(s)`
  should be > 0.
- After `npm run cf -- timeline -p <project>`, `workspace/<project>/pacing_stats.json` should show
  `forcedReuse` < 20.
- Optional, to use the smaller vision model: in `llm_settings.json` set
  `"stages": { "vision": { "model": "qwen2.5vl:3b" } }`.

**Open risks**

- The VRAM estimate is rough (it only feeds the warning). Ollama still decides the real GPU/CPU
  split.
- `qwen3:8b` writes `<think>` blocks unless told not to. Phases 1/2/5 send `think: false` / strip
  them.
- "Done when" (`ollama ps` 100% GPU for a whole run, vision checks running, forced reuse < 20)
  needs a real run on your GPU. See "Blocked / needs user".

---

## Phase 1: Niche / Outlier Finder

**What changed**

- `src/lib/research/youtube-api.ts`: YouTube Data API v3 client (`search`, `videos`, `channels`,
  `playlistItems`).
  - Quota counter per quota day (Pacific time, when Google resets it). It counts 100 units per
    `search` and 1 unit per list call.
  - A call that would go past `dailyQuota - quotaReserve` is refused before it is sent.
  - A real `quotaExceeded` answer marks the day as used up.
  - Every answer is cached in SQLite, so a repeat scan within `cacheHours` costs ~0 units.
- `src/lib/research/outliers.ts`: score = views / median of the channel's last 30 long-form
  uploads. Flags are 2x, 3x and 5x+. Shorts (< 60 s) are left out of both sides. Channels with
  fewer than 5 recent uploads are skipped (the median is not reliable).
- `src/lib/research/niche-scan.ts`: channels created in the last 12 months (search with
  `publishedAfter`, plus the channels the outlier scan already loaded).
  - Faceless heuristic score from title and description.
  - 28-day views are **measured** once two snapshots are 3+ days apart; until then they are
    **estimated**.
  - RPM and 28-day revenue are shown only as **estimate ranges** per niche. The seed decides the
    niche.
- `src/lib/research/db.ts`: `data/research.db` on Node's built-in `node:sqlite` (no native
  module). Tables: cache, quota, channel snapshots, last scans. The file is git-ignored.
- `src/lib/settings/features.ts`: `features.json` (git-ignored) with a section per new feature,
  validated and merged with the defaults. API: `GET/PUT /api/features`.
- UI: **`/research`** page (seeds, Scan button, quota meter, live log, outlier table with
  thumbnails and flags, growing-channel table). Shared nav for the new pages is in `web/full/`.
  The main UI nav links to it.
- CLI: `npm run cf -- research [-s "seed1,seed2"]`.

**Quota per scan** (6 default gun/survival seeds, nothing cached): about 6×100 (video search) +
6×100 (channel search) + ~2 units per channel for the medians, so roughly 1,500-1,900 units out of
10,000. A re-scan on the same day mostly hits the cache.

**Files**: `src/lib/research/{youtube-api,outliers,niche-scan,db,index}.ts`,
`src/lib/settings/features.ts`, `src/server/routes/research.ts`, `src/server/server.ts`,
`src/cli.ts`, `web/research.html`, `web/full/{full.js,full.css}`, `web/simple/index.html`,
`tests/research.test.ts`, `.env.example`, `.gitignore`.

**Checks**: typecheck passes. 292 tests, 291 pass, 0 fail, 1 skipped (the one skipped before this
phase). The `/research` page was loaded in the browser preview; without a key it shows the
"add YOUTUBE_API_KEY" message.

**How to verify on your PC**

1. Google Cloud console → enable **YouTube Data API v3** → create an API key, and add
   `YOUTUBE_API_KEY=...` to `.env`.
2. Run `npm run serve`, open <http://localhost:4173/research> and press **Scan**. Or run:

   ```bash
   npm run cf -- research
   ```

3. Expect up to 50 outliers (with 2x/3x/5x+ flags) and up to 20 growing channels, with the quota
   meter well under 10,000.

**Open risks**

- The faceless check is a heuristic (it does not look at thumbnails). An optional
  vision-model check could come later.
- The RPM table is a rough industry range, not data from the channels. It is labelled "est."
  everywhere.
- `search.list` with `order=viewCount` favours big channels. Raise `research.resultsPerSeed`
  or add more specific seeds to find more small-channel outliers.

---

## Phase 2: Titles

**What changed**

- `src/lib/research/title-patterns.ts`: 11 title structures (numbered list, best of year, versus,
  warning, budget, only one, curiosity, question, tested, ranked, made in). They are found in
  competitor titles and ranked by mean views × count. The agent only gets abstract templates
  such as `Top {N} {X} ({YEAR})`, never competitor wording.
- `src/lib/agents/titles.ts`: 10 options from the local model (stage `titles`, default
  `qwen3:8b`, thinking off).
  - Every candidate is checked against the competitor titles: word 2-gram Jaccard, word cosine,
    and embedding cosine (nomic-embed-text, when pulled).
  - A title more than **80%** similar (`features.json` → `titles.maxSimilarity`) is rewritten,
    up to 2 rounds, and dropped if it is still too close.
  - Template titles fill any gap, so there are always 10 (also when no model is available).
- `src/lib/originality/similarity.ts`: the shared originality guard (n-gram Jaccard,
  containment, word cosine, embedding cosine). Phase 5 uses it for scripts.
- `src/lib/models/embed.ts`: Ollama `/api/embed` through the model loader (stage `embed`). If the
  model is missing, it falls back to lexical scores with a log line.
- `src/lib/research/news.ts`: Google News RSS headlines (free, no key, cached 6 h). They are
  offered as angles and never copied.
- `llm.ts`: `think: false` for qwen3 / deepseek-r1 (set `THINK=on` to allow thinking), and
  `<think>` blocks are stripped from answers.
- Competitor titles come from the last research scan's outliers, plus a 25-result topic search
  when `YOUTUBE_API_KEY` is set (101 units, cached).
- UI: **Titles** card on `/research`. API: `POST /api/research/titles {topic}`. CLI:
  `npm run cf -- titles -t "best budget 9mm pistols"`.

**Files**: `src/lib/research/{title-patterns,news,index}.ts`, `src/lib/agents/titles.ts`,
`src/lib/originality/similarity.ts`, `src/lib/models/embed.ts`, `src/lib/agents/llm/llm.ts`,
`src/server/routes/research.ts`, `src/cli.ts`, `web/research.html`, `tests/titles.test.ts`.

**Checks**: typecheck passes. 299 tests, 298 pass, 0 fail, 1 skipped (the one skipped before
this phase).

- Browser check: on `/research`, "Generate titles" returned 10 titles. This worktree has no
  model configured, so they came from the template fallback, with 8 Google News headlines.
- Unit test: 2 copied competitor titles were rejected and rewritten, and all 10 final titles
  scored ≤ 80%.

**How to verify on your PC**

```bash
ollama pull qwen3:8b
ollama pull nomic-embed-text
npm run cf -- titles -t "best budget 9mm pistols"
```

You should get 10 titles. Each line shows its structure and "closest competitor N%", and every
N should be ≤ 80.

**Open risks**

- Embedding similarity of short titles is noisy. It is rescaled (cosine 0.5 = 0) and only raises
  the score, never lowers it.
- Google News can rate-limit; the titles still work without hooks.

---

## Phase 3: Captions + edit polish

**What changed**

- **Word-highlight captions.** Two new presets:
  - `highlight`: the spoken word turns yellow and grows 12%;
  - `bold-pop`: capitals, 3 words per line, and the spoken word sits on a green box.
- **ASS output.** The render writes one ASS event per word. Each event runs from that word's start
  to the next word's start, so the events tile the line with no gap. Timing accuracy is 10 ms
  (centiseconds).
- `cards/src/Captions.tsx` is one caption component for every mode (line, karaoke, word,
  highlight):
  - the studio preview (`TimelinePreview`) now uses it;
  - it is also registered as a transparent **`Captions`** composition (overlay for Shorts in
    Phase 8);
  - frames come from `src/lib/render/captionTiming.ts`.
- **Sync.** The highlight is within **±17 ms** of the aligned word at 30 fps, well inside the
  ±100 ms target. A test checks this on uneven, real-looking timings.
- **Beat punch-in zoom** (`src/lib/render/beats.ts`): a quick 6% punch-in (4 frames in, 10 out)
  on emphasised words: numbers and prices, superlatives, model names, words after a pause, CAPS.
  Beats are at least 2.5 s apart.
  - The render applies it with `zoompan`, on footage only. Cards and captions on top stay sharp.
  - Checked with real ffmpeg 7.1: 1920×1080, 90 of 90 frames.
- **Visual change every 3-5 s.** Any stretch longer than `captions.maxVisualSec` (default 4 s)
  with no cut and no beat gets an extra punch-in. The render writes `render/beats.json`, and QA
  adds a **"Visual change at least every N s"** check (warns above N + 1 s).
- **Render cache.** A segment's hash only changes when it has punch-ins. Segments without them
  keep their old hash, so an existing render cache stays valid.
- **Toggle.** `features.json` → `captions.enabled` is the master switch (default on; channels
  still opt in through `style.json` or the editor). `captions.preset` is the default style for
  channels that have none (empty means classic, so existing channels look the same). Also
  `captions.punchIn` and `captions.maxVisualSec`.

**Files**: `src/lib/render/{captionPresets,captions,captionTiming,beats}.ts`,
`src/commands/{render,timeline,qa}.ts`, `src/lib/compiler/incrementalCache.ts`,
`src/lib/preview/previewModel.ts`, `src/lib/qaGate.ts`, `src/lib/settings/features.ts`,
`cards/src/{Captions.tsx,Root.tsx,preview/TimelinePreview.tsx}`, `tests/polish.test.ts`,
`tests/captions.test.ts` (its preset lists now include the 2 new presets).

**Checks**:

- typecheck passes, and so does `typecheck:cards`.
- 308 tests: 307 pass, 0 fail, 1 skipped (the one skipped before this phase). That includes the
  existing ffmpeg test that draws every preset's ASS file.
- `build:preview` bundles.

**How to verify on your PC**

1. In the studio, open a project → Captions → pick **Word highlight** or **Bold pop**. The
   preview should show the spoken word highlighted.
2. Render:

   ```bash
   npm run cf -- render -p <project>
   ```

3. Check that the log has `[render] punch-ins: N on emphasised words + M ...` and that
   `workspace/<project>/render/beats.json` exists. In the video, words should light up as they
   are spoken, with short punch-ins on numbers and key words.
4. To turn things off in `features.json`: `"captions": { "punchIn": false }`, or
   `"enabled": false` for no captions at all.

**Open risks**

- `zoompan` on video costs some render time, and only on segments that have beats. Set
  `punchIn: false` if renders get slow.
- The ASS "box" for `bold-pop` is a thick accent-coloured border (ASS has no per-word
  background), so it looks a little rounder than the preview's box.

---

## Phase 4: Stock visuals + Prompt Mapper

**What changed**

- `src/lib/assets/prompt-mapper.ts`: for every segment, a stock **query** (2-5 filmable words) and
  an **image prompt**.
  - Comes from the local model (stage `assets`), split on the GPU when too big; rule-based
    fallback when there is no model.
  - Queries are made unique across segments, so two segments never search the same thing.
  - Product segments get `allowGenerated: false` (exact-model policy).
- `src/lib/assets/stock/pexels.ts`, `stock/pixabay.ts`: search and download through the existing
  `stock.ts` (24 h cache, rate limits, 1080p file pick). Each download saves a
  **`<file>.license.json`** sidecar: source, id, page URL, author, licence, licence URL, query,
  date.
- `src/lib/assets/imagegen.ts` (optional, **off** by default, `features.json` →
  `stock.imagegen`): ComfyUI API client.
  - SDXL-Turbo checkpoint workflow (4 steps, cfg 1), or Flux.1 schnell GGUF (ComfyUI-GGUF nodes).
  - One picture at a time, cached by prompt, licence sidecar with model and prompt.
  - The text model is unloaded first.
- `src/lib/assets/visualPlan.ts`: ranking **product footage (0) > product photo (1) > stock (2) >
  generated (3)**.
  - Greedy unique assignment: the most constrained segment chooses first, and each picks its best
    unused candidate.
  - Nothing unused left: a generated picture when allowed, otherwise a **counted** forced reuse.
  - Product lines never take stock or generated pictures.
  - Writes `visual_plan.json` and one log line per asset: tier, source, licence, query.
- `npm run cf -- visuals -p <project> [--apply]`. `--apply` downloads or generates, then **only**
  fills scenes that had no real picture (missing, or a fallback card on a footage scene), and
  rewrites `licenses.json`. Real product footage is never replaced.
- The ledger knows the new `imagegen` source (category `generated`).

**Policy note**: your saved preference is "exact-model footage only". Stock is therefore limited to
**non-product** lines (hook, transitions, generic sentences), and only when
`PEXELS_API_KEY` / `PIXABAY_API_KEY` are set. `GENERIC_STOCK=off` still controls the old assets
step, which is unchanged.

**Files**: `src/lib/assets/{prompt-mapper,imagegen,visualPlan}.ts`,
`src/lib/assets/stock/{pexels,pixabay,license}.ts`, `src/lib/assets/{types,licenseLedger}.ts`,
`src/lib/models/loader.ts`, `src/cli.ts`, `tests/visuals.test.ts`.

**Checks**: typecheck passes. 315 tests, 314 pass, 0 fail, 1 skipped (the one skipped before this
phase). In the end-to-end test project (fake ComfyUI), the 3 footage segments got 3 unique visuals,
forced reuse 0, and all 3 have a licence logged.

**How to verify on your PC**

1. Optional: add `PEXELS_API_KEY` / `PIXABAY_API_KEY` to `.env`.
2. Optional, image generation:
   - Start ComfyUI.
   - Put `sd_xl_turbo_1.0_fp16.safetensors` in its `models/checkpoints`.
   - In `features.json`, set `"stock": { "imagegen": true }`.
3. Run:

   ```bash
   npm run cf -- visuals -p <project>
   ```

   This is a dry plan. Check the `[visuals] N segment(s): N unique visual(s), forced reuse 0`
   line.
4. Run `npm run cf -- visuals -p <project> --apply`, then `timeline` and `render`.

**Open risks**

- **SDXL-Turbo licence**: Stability AI Community License (free under $1M a year). Check the
  current terms. Flux schnell (Apache-2.0) is the safer choice for commercial use.
- The plan does not show stock thumbnails to the vision model (the old assets step does). Stock is
  ranked by the provider's own relevance.

---

## Phase 5: Script writer

**What changed**

- `src/lib/agents/script/outline.ts`: intro (hook, ~8%), one section per product in countdown
  order (the last product listed is #1 and gets 1.2× budget), outro (~5%).
  - Word budgets add up **exactly** to the target (largest-remainder rounding).
  - Angles and the hook come from the local model (stage `script`, `qwen3:8b`, thinking off).
- `src/lib/agents/script/sections.ts`: **one request per section**, so each prompt carries only
  one product's facts and stays well inside 8K.
  - Up to 3 attempts to hit the section budget; the closest attempt is kept.
  - A draft that states unsourced numbers is rewritten, and any leftover sentence with an
    unsourced number is removed.
  - The total is then balanced to **±3%**.
  - Rule-based sections are used when there is no model.
- `src/lib/agents/script/facts.ts`: **sourced facts only**.
  - Inputs are a facts file (`<project>/facts_sources.json`) and/or product pages
    (`<project>/sources.json`: `{product: [urls]}`).
  - For pages, the model may only return values whose numbers appear in that page's text
    (invented specs are dropped). Each fact keeps its URL and page title.
  - **Claim checker**: every number in the finished script must match a sourced fact of that
    section's product. Exceptions are counting numbers 1-10 and numbers inside product names
    (Glock 43X).
- `src/lib/agents/script/originality.ts`: per section, 5-gram containment against the
  competitor transcripts, plus nomic-embed-text similarity to the closest ~120-word window.
  - Above `script.maxNgramOverlap` (0.2) or `script.maxSimilarity` (0.8), the section is
    rewritten and re-checked.
- CLI:
  `npm run cf -- script -p <name> -t "<topic>" --products "a,b,...,#1" [--words 1500] [--competitors <videoIds>]`.
  - Competitor transcripts come from `youtube-transcript-api` (existing `quickTranscript`) and
    are saved in `<project>/competitors/`.
  - Writes `script.txt` and `script_report.json` (word counts, deviation, originality, unsourced
    claims, facts used with their URLs).
  - The exit code is 2 when the script is not clean.

**Files**: `src/lib/agents/script/{outline,sections,facts,originality,index}.ts`,
`src/lib/settings/features.ts`, `src/lib/models/loader.ts`, `src/cli.ts`, `tests/script.test.ts`.

**Checks**: typecheck passes. 322 tests, 321 pass, 0 fail, 1 skipped (the one skipped before this
phase). The 10-product test checks:

- every section is its own request;
- the total is within ±3%;
- one section that copied a competitor is caught and rewritten, so the originality report is
  clean;
- 0 unsourced claims, and the 10 facts used all carry an https source.

**How to verify on your PC**

1. Put product page URLs in `workspace/<name>/sources.json`.
2. Run:

   ```bash
   npm run cf -- script -p <name> -t "best concealed carry pistols" --products "Taurus G3C,Ruger Max-9,Glock 43X,Sig P365,S&W Shield Plus,Springfield Hellcat,Kimber R7 Mako,CZ P-10 S,Walther PDP F,Canik Mete MC9" --words 1500 --competitors <id1>,<id2>
   ```

3. Expect the final line `[script] 1500±45 words ... 0 unsourced claim(s)`.

**Open risks**

- A 7-8B model often misses the budget on the first attempt. Expect 2-3 attempts per section
  (~3-6 min for 12 sections on the 3070 Ti).
- With no sources, the script states **no numbers at all** (by design).
- Some manufacturer pages render specs with JavaScript only. In that case, add the facts to
  `facts_sources.json` by hand.

---

## Phase 6: Local TTS

**What changed**

- `src/lib/tts/index.ts`: TTS **engine interface** (`engineFor`, `closeEngines`, `loudnorm`).
  - Local engines: **kokoro** (default), **piper**, **xtts**, and the Windows draft voice.
  - Cloud engines (elevenlabs, openai) stay optional and are only used when their keys are set.
- `src/lib/tts/kokoro.ts` + `python/kokoro_tts.py`: Kokoro-82M (Apache-2.0). Two ways to run it:
  - a **Kokoro-FastAPI** server (`KOKORO_URL`, OpenAI-compatible `/v1/audio/speech`);
  - a persistent **kokoro-onnx** worker (`src/lib/tts/worker.ts`). The model loads once, then
    each sentence is one JSON line.
  - It runs on the CPU, so it never fights the LLM for VRAM.
- `src/lib/tts/xtts.ts` + `python/xtts_tts.py`: XTTS-v2, **own voice only**.
  - The speaker sample must be inside `channels/<channel>/voice/`; any other path is refused.
  - Each request is at most 240 characters (XTTS limit).
- `src/lib/tts/piper.ts`: setup check for Piper. The engine itself already existed.
- Integrated into the existing provider system (`TTS_PROVIDERS`, `speakChunk`, cache keys per
  voice), so the existing behaviour still applies:
  - **one request per sentence**;
  - cached sentences are reused;
  - `tts_chunks.json` sentence timings feed `aligned.json` / `words.json` (the existing align
    path, no Whisper needed).
- **Auto engine choice**: Kokoro comes first when it is installed and `features.json` →
  `tts.engine` is `kokoro`. After that, the old order applies.
- The `tts` step logs the **real-time factor**. It then runs **ffmpeg loudnorm** on the whole
  voiceover to `tts.lufs` (-14 LUFS, true peak -1.5 dB). The length does not change, so the
  timings stay valid.

**Files**: `src/lib/tts/{index,kokoro,xtts,piper,worker}.ts`, `src/lib/tts.ts`,
`src/lib/ttsChunks.ts`, `src/commands/tts.ts`, `python/{kokoro_tts,xtts_tts}.py`, `.env.example`,
`tests/localTts.test.ts`.

**Checks**: typecheck passes. 326 tests, 325 pass, 0 fail, 1 skipped (the one skipped before this
phase).

- Fake worker: the model starts once and requests are queued.
- Server mode sends the expected request.
- XTTS refuses a sample that is not your own voice file.
- Sentence cache: 3 sentences synthesized, then 3 reused.
- Real ffmpeg loudnorm keeps the file length.

**How to verify on your PC**

1. Install Kokoro in the ClipForge `.venv`:

   ```bash
   .venv/Scripts/pip install kokoro-onnx soundfile
   ```

2. Download `kokoro-v1.0.onnx` and `voices-v1.0.bin` from the kokoro-onnx GitHub releases into
   `models/kokoro/`.
3. Set `TTS_PROVIDER=kokoro` in `.env`. Optional: `KOKORO_VOICE=am_michael` or another voice.
4. Run:

   ```bash
   npm run cf -- tts -p <project>
   ```

5. Look for this line:
   `[tts] kokoro: 10.0 min of voice in X min (Nx real time)`. Kokoro on the i7-12700H should reach
   well over 1x, so 10 minutes of voice takes under 10 minutes.
6. Then run `align` / `plan` as usual.

**Open risks**

- **XTTS-v2 licence**: the Coqui Public Model License is **non-commercial**. Monetised videos
  need a commercial licence. Kokoro and Piper are free for commercial use.
- The "10-min VO in < 10 min" target has not been measured on your PC yet (needs the model files).

---

## Phase 7: AI Avatar

**What changed**

- `src/lib/avatar/index.ts` + `engines.ts` (engine interface): `musetalk` (default),
  `liveportrait`, and optional `sadtalker`, `wav2lip`, `latentsync`, `hallo2`, `echomimic` (the
  last two are marked slow).
  - Each engine is a command template run in its own checkout (`avatar.engineDir`, with its own
    `avatar.pythonCmd`).
  - `avatar.command` overrides the template. Placeholders: `{python} {image} {audio} {out}
    {outdir} {face_video} {driving} {fps}`.
  - `musetalk.ts` and `liveportrait.ts` hold the setup notes for each engine.
- **Input**: one fixed photo per channel, `channels/<id>/avatar.png` (jpg/webp also work). The
  audio is cut from the voiceover (Kokoro/XTTS or your own recording).
- **Placement** (`avatar.placements`): `intro` (after the hook teaser), `bridge` (the first line
  of every product), `outro`.
  - Clips always cover whole scenes and last at most `avatar.maxClipSec` (15 s).
  - Layout (`avatar.layout`) is `pip` or `full`:
    - `pip`: transparent ProRes 4444 layers, `pipCorner` / `pipScale`. These go through the same
      overlay path as the Remotion cards, so the renderer needs no change.
    - `full`: the scene picture becomes the clip.
- **One clip at a time**: every clip is its own engine process, so the model leaves VRAM when it
  ends. All local LLMs are unloaded before the first clip. GPU time is logged per clip (stage
  `avatar`).
- **QA**: clips are tagged `source: own-avatar` (`avatar_plan.json`, timeline asset source).
  - The "Talking heads on screen" check does not count shots inside avatar ranges, and the detail
    says how many were skipped.
  - The licence ledger records `own-avatar` as `own`.
- CLI: `npm run cf -- avatar -p <project>`, after `timeline` and before `render`. It is off unless
  `features.json` → `avatar.enabled` is true (or `--force`). Re-run it after re-running
  `timeline`.

**Files**: `src/lib/avatar/{index,engines,musetalk,liveportrait}.ts`, `src/commands/avatar.ts`,
`src/commands/qa.ts`, `src/lib/assets/{types,licenseLedger}.ts`, `src/lib/settings/features.ts`,
`src/cli.ts`, `tests/avatar.test.ts`.

**Checks**: typecheck passes. 331 tests, 330 pass, 0 fail, 1 skipped (the one skipped before this
phase). In the end-to-end test, FFmpeg stands in for the lip-sync engine:

- 4 clips render one at a time;
- the 6 s intro clip comes out 6.0 s;
- 5 scenes get a PiP layer and the hook stays clean;
- the full-frame layout sets `source: own-avatar` with the correct in-points.

**How to verify on your PC** (this needs the GPU and the MuseTalk model):

1. Clone https://github.com/TMElyralab/MuseTalk, set up its Python environment and download the
   v1.5 weights (see its README).
2. In `features.json`, set:

   ```json
   "avatar": {
     "enabled": true,
     "engine": "musetalk",
     "engineDir": "D:/AI/MuseTalk",
     "pythonCmd": "D:/AI/MuseTalk/.venv/Scripts/python.exe",
     "placements": ["intro", "outro"],
     "layout": "pip"
   }
   ```

3. Put a front-facing photo at `channels/<channel>/avatar.png`.
4. Run, one after the other:

   ```bash
   npm run cf -- timeline -p <project>
   ```

   ```bash
   npm run cf -- avatar -p <project>
   ```

   ```bash
   npm run cf -- render -p <project>
   ```

   ```bash
   npm run cf -- qa -p <project>
   ```

5. Watch the intro and outro: the lips should match the voice, and QA's "Talking heads" check
   should pass.

**Open risks**

- The command-line flags of the engines' own scripts change between releases. If a run fails,
  copy the current inference command from the engine's README into `avatar.command`.
- LivePortrait does not lip-sync to audio (it needs a driving video). Use MuseTalk, or chain
  Wav2Lip.
- Check the licences of the engine weights before monetising (MuseTalk and SadTalker code is
  MIT/Apache; some face models are non-commercial).

---

## Blocked / needs user

- **Phase 1**: add `YOUTUBE_API_KEY` to `.env` and press Scan on `/research` to confirm the live
  results. The code and tests run against a fake API.

- **Phase 0 hardware check**: run one full video on the RTX 3070 Ti and confirm `ollama ps` shows
  100% GPU, that there are no `GPU returned garbage twice` lines, that `[vision] verified` > 0 and
  that `pacing_stats.json` `forcedReuse` < 20.
- **Phase 6**: put the Kokoro model files in `models/kokoro/` (or run Kokoro-FastAPI), then run
  `tts` on a 10-minute script and confirm the real-time factor is above 1x.
- **Phase 7**: install MuseTalk + weights, put the photo at `channels/<id>/avatar.png`, render a
  15 s intro/outro on the GPU, and judge the lip-sync by eye.
