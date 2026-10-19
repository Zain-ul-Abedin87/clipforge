# ClipForge architecture (forensic extraction)

Branch `feature/general-web-crawler`, commit after `51df7ec`. Every item below was checked against
the code; `file:line` numbers can drift by a couple of lines as the code changes. Things the brief
asked about that do **not** exist as described are listed in [§0](#0-corrections-to-the-brief).

Pipeline (one CLI, `src/cli.ts`; each step reads the previous step's files in `workspace/<project>/`):

```
tts (Mode B) -> transcribe -> align -> plan -> assets -> timeline -> render -> qa
     voiceover_tts.wav  words.json  aligned.json  scenes.json  assets.json  timeline.json  final.mp4  qa_report
```

Orchestration: `src/server/server.ts` (web app), `src/server/pipelineQueue.ts` (BullMQ stage queues
plan / sourcing / render when `REDIS_URL` is set, else `workspace/queue.json`), `src/server/jobStore.ts`.

---

## 0. Corrections to the brief

| Brief says | Code actually does |
|---|---|
| Mode C produces `significant` discrepancies as a kind | Kinds are `omission \| addition \| substitution` (`src/lib/align.ts:112`). `significant` / `minor` is a **severity**; reasons are `number \| negation \| model_variant` (:113, :122). |
| Whisper chunks overlap | No overlap. Contiguous chunks cut at the quietest 0.3 s window (`python/transcribe.py:77-96`). |
| Render bypasses MoviePy entirely | True for render. MoviePy **is** used by the `web_cc` crawler to cut clips (`python/web_crawler.py:362-364`). |
| Segment hash covers the audio byte array | The voice audio is **not** in the segment hash. Files are stamped by path + size + mtime, not bytes (`incrementalCache.ts:58-83`). Audio is muxed after the concat. |
| `RENDER_CHUNK_SECONDS` chunked rendering | Only in `.env.example:172`. **No code reads it.** |
| `split_shots.py` chops long shots | It does not. Only the vault harvest (`ytExtractor.ts shotsFromCuts`) slices long shots into 5 s pieces. |
| `qa --preflight` checks BOM headers | No BOM check. The BOM fix is in `server.ts readProject` (parse, never overwrite a broken file). |
| `qa` checks audio drift | No drift check. The nearest are the A/V sync and length checks (< 0.1 s / < 0.15 s). |
| General web crawl respects robots.txt | Only `web_cc` (`python/web_crawler.py:246-272`) and `official.ts` do. **`web_crawl.py` / `webCrawl.ts` do not.** |
| Vault sharing when a pool is dry | Since `51df7ec` a product scene never borrows another product's vault; only scenes naming no product borrow the nearest one. |

---

## 1. Input modes

### 1.0 How the mode is chosen
- `src/lib/inputMode.ts:18-23` `resolveInputMode({hasUploadedAudio, hasScript})`:

  | Uploaded audio | Script | Mode |
  |---|---|---|
  | yes | yes | C |
  | yes | no | A |
  | no | yes | B |
  | no | no | null |

  Legacy mapping, `modeFromVoiceMode` (:26-28): `voice`→A, `tts`→B, `both`→C.
- `server.ts inputModeOf()` (:181-186) tries three sources in order:
  1. `project.json.inputMode`
  2. the legacy `voiceMode`
  3. whether the files exist: `audio` set and `voiceMode !== "tts"`, plus `script.txt` present
- Align arguments (`cliArgs` ~:192-198): `--script <proj>/script.txt` if that file exists, else `--no-script-mode`.

### 1.1 Mode A: voiceover only
**`python/transcribe.py` (faster-whisper / CTranslate2)**

- **Defaults** (:204-216):

  | Option | Default |
  |---|---|
  | `--model` | `large-v3-turbo` |
  | `--device` | `auto` |
  | `--compute-type` | `int8_float16` (`int8` on CPU, :269) |
  | `--language` | `en` |
  | `--chunk-seconds` | 300 |

  `CT2_CUDA_ALLOCATOR=cub_caching` is set (:220).
- **Device auto** (:224-231): `cuda` if `ctranslate2.get_cuda_device_count() > 0`, else `cpu`.
- **Chunk plan**, `plan_chunks` (:77-96), at SR 16000:
  - Audio no longer than `1.3 × target` (390 s by default) is one chunk.
  - Otherwise a cut is made every `target` seconds, snapped to the quietest 0.3 s RMS window within ±15 s.
  - The plan is saved to `chunks/plan.json`, keyed by audio size and chunk length.
  - Each chunk is written atomically (`chunk_NNN.tmp` → `.json`, :302-304). Finished chunks are reused after a crash.
- **Decode** (:281-292):
  - `word_timestamps=True`
  - `vad_filter=True` (min silence 500 ms)
  - `beam_size=5`
  - `initial_prompt` built from the glossary keys, max 600 chars (:62-71, :233-240). Its wording is still gun/hunting specific: "A product review video about guns, hunting and survival gear", a niche leak.
- **Skip repair** (`repair_skips`, :144-200): spans that look like skipped speech are re-transcribed on CPU with VAD off. The tests are:
  - a word longer than 3 s
  - a gap longer than 3 s (1.5 s at the very start)
  - the audio in the span is more than 35% voiced
- **Onset refine** (`refine_onsets`, :99-141): moves a word's start after a pause to the real voice onset. Threshold `max(4·noise, noise + 0.12·(speech−noise))`; result emitted as `onsets_refined.words_moved`.
- **Outputs**: `words.json` `[{word, start, end, prob}]` and `segments.json`.
- **CUDA error**: event `cuda_error`, exit code 3 (:334-337).

**GPU → CPU failover: `src/commands/transcribe.ts:88-108`**
- The worker is restarted after each crash, up to `MAX_RESTARTS = 15`.
- The failing chunk is tracked through `chunk_start` events. After 2 failures on the same chunk it is added to `--cpu-chunks`, so only that chunk runs on the CPU.
- Env: `WHISPER_MODEL`, `WHISPER_DEVICE`, `WHISPER_COMPUTE_TYPE`. Child process env: `HF_HOME=models/hf`, `HF_HUB_DISABLE_XET=1`.
- Cache key: audio, glossary, model and a hash of the worker script (:55-61). `--force` deletes `chunks/`.

**`src/commands/align.ts` without a script (`mode: "transcript"`, `transcriptOnly` :282-327)**
- **Glossary corrections**: `applyGlossary` (`src/lib/glossary.ts:78`) fuzzily matches word windows against glossary keys.
  - Minimum score 0.85 for keys of 6 chars or fewer, else 0.8, minus `0.1·|span−len|` (:94-99).
  - Times are split by character count; `prob` = minimum over the window.
  - Corrected words get `source:"glossary"` and `heard`.
- **Sentences** end on `/[.!?]["')\]]*$/` (`src/lib/text.ts:60`). A new paragraph starts after a pause longer than 1.2 s (:310).
- **lowConfidence**: count of words with `prob < LOW_PROB = 0.5` (:72).
- Deletes `discrepancies.json` (:139-141).
- **Structure without a script**: `src/lib/planner/structure.ts detectSections` (:62-97).
  - Finds the longest monotonic chain of "Number N" headers (`HEADER_RE` :13, ranks 1-25); at least 3 are needed.
  - Adds an intro section if the first header starts after 1 s.
  - The outro is the first `OUTRO_RE` sentence that is more than 2 sentences after the last header and in the last 120 s.

### 1.2 Mode B: script only
- **`src/commands/tts.ts`** `tts()` (:24-56) → `synthesizeUnits` (`src/lib/ttsChunks.ts:136-173`). It writes:

  | File | Contents |
  |---|---|
  | `voiceover_tts.wav` | the voiceover |
  | `tts_chunks.json` | manifest, version 1 |
  | `tts_payload.txt` | what the engine was actually given (:51) |
  | `tts.json` | provider, script hash, counts |
  | `aligned.json`, `words.json` | written by `writeModeBTimings` :59-67, words with `prob: 1` |
  | `project.json` | `inputMode:"B"` (`setProjectAudio` :69-73) |

- **Providers**, `src/lib/tts.ts`:
  - `TTS_PROVIDERS` (:21): elevenlabs, openai, piper, windows.
  - `autoProvider` (:81-89): ElevenLabs (key + voice id) → OpenAI (key) → Piper (`PIPER_MODEL` + binary) → Windows SAPI (win32) → `TtsConfigError`.
  - Chunk limits `CHUNK_CHARS` (:102): 2400 / 3800 / 20000 / 20000.
  - `speakChunk` (:183-210) does the HTTP request. ElevenLabs returns `mp3_44100_128`, OpenAI `wav`. 429/5xx get 2 retries; 401/403 throw.
- **Pronunciations**:
  - Glossary lines `Name = spoken form` are parsed by `loadPronunciations` (`glossary.ts:38`).
  - `applyPronunciations` (:55) replaces whole words, case-insensitive, longest term first.
  - `scriptUnits` (`ttsChunks.ts:59-87`) gives each sentence unit a `text` (the script) and a `payload` (what is spoken). Captions use `text`.
- **No faked narration**: timings come from the engine's own audio.
  - Each sentence is trimmed with `silenceremove` at −50 dB (`normalise` :176-192).
  - Pauses: `TTS_PAUSE_MS` 250 within a paragraph, `TTS_PARAGRAPH_PAUSE_MS` 600 between paragraphs.
  - Each sentence plus its pause is padded to a whole frame by `frameAlignedGap` (FPS 30, 44.1 kHz).
- **Cache**: `ttsCacheKey` (:95-105) = sha256 of `{v, provider, voice settings, payload}`. The API key is not in it.
  - Stored at `cache/tts/<provider>/<key32>.wav`.
  - Editing one sentence re-synthesises only that sentence.
- **Whisper skipped**: `ttsTimingsFor` (:259-268) returns the manifest when `tts_chunks.json` (v1) names the current project audio. Transcribe and align then short-circuit.
- **aligned.json**: `alignedFromChunks` (:232-256).
  - Sentence edges are exact.
  - Words are spread inside a sentence by weight `max(1, len) + 1`, plus 2 for a trailing `,;:`.

### 1.3 Mode C: script + voiceover
- `align.ts alignToScript` (:176-258): script tokens per paragraph (`scriptTokens` :160-168) are aligned to the Whisper words by `alignTokens` (`src/lib/align.ts`) on normalised forms. Then `findDiscrepancies` runs.
- **Discrepancies**, `findDiscrepancies` (`align.ts:184-229`):
  - Each run of non-matching alignment pairs becomes one item.
  - Type: `omission` if nothing was heard, `addition` if no script tokens, else `substitution`.
  - Id: `d_` + sha1 of `(type | scriptNorm | heardNorm | occurrence)`, first 10 chars.
  - Times come from the heard words, or for an omission from the gap between neighbouring heard words.
- **Reasons**, `classifyDifference` (:165-177):
  - It first compares `compactSpoken` forms (:152-162): hyphens and spaces removed, number words turned into digits. If they are equal, it is no discrepancy.
  - `number`: the sets of tokens containing a digit differ.
  - `negation`: the sets of `NEGATIONS` tokens differ (:139).
  - `model_variant`: the sets of `VARIANT_WORDS` (pro, max, plus, mini, ultra, gen, mk, ii…, :141) or of model codes (letters + digits, :144) differ.
  - Any reason makes the item `severity: "significant"`.
- **Resolutions**: `keep_audio | correct_transcript | modify_script` (:114), stored in `project.json.discrepancyResolutions`.
  - `modify_script` rewrites `script.txt` only inside the project folder, with a backup `script.before-modify.<ts>.txt` (:261-279).
- **Word sources**: `script`, `interpolated` (`interpolateGaps` :330-352, spread by character count), `extra`.
- Writes `discrepancies.json` `{generatedAt, script, items}`, or deletes it when there are none.
- **Gate**: `src/lib/qaGate.ts:185-194` `checkDiscrepancies` blocks while a significant item has no resolution.

---

## 2. Footage sourcing stack

**Default policy is exact-model only.** `GENERIC_STOCK` defaults to `off` (`src/lib/assets/sources.ts:25`). While it is off:
- `searchProvider()` makes no network call.
- Allowed sources are only `local`, `presskit` and `youtube_exact_model` (`EXACT_MODEL_SOURCES` :24).

### 2.1 Official photos: `src/lib/assets/official.ts`
- **Brand map**: `niche.official.brands` from `niches/<name>.json` (:431). The longest brand found in the product name wins (`brandOf` :422-428).
  - Auto-detected niches have **no** brand map, which is why every product logged `no-brand`.
- **Robots**: `robots()` (:48-67) reads `Sitemap:` and `Disallow:` (User-agent `*`). `allowed()` is a prefix match only; wildcard rules are ignored.
- **Sitemaps**: `sitemapUrls()` (:118-144) uses the robots.txt sitemaps, or `/sitemap.xml` and `/sitemap_index.xml`.
  - At most 25 sitemap files; sitemaps with "product" in the name come first.
  - `<loc>` is read with a regex that handles CDATA.
  - Child sitemaps for blog/news/post/… are skipped.
- **Crawl** (`crawlLinks` :98-115): only when no sitemap page matched.
  - Reads the homepage plus up to **30** category pages, one level deep.
  - A link is a category when it matches the `CATEGORY` regex (:92).
  - 700 ms between pages.
- **Page match**: `bestPage` (:154-165) tries `strictPage` (:192-210), then `loosePage` (:167-188; ≥50% of model parts and a digit). `SKIP_PAGE` (:190) excludes blog/review/parts/manual pages.
- **LLM**:
  - `choosePage` (`src/lib/agent/official.ts:23`) picks one of up to 8 pages, or −1 for none.
  - `pickProductPhotos` (:46) filters the page's images. It only runs if `agentEnabled()`.
  - Model: `LLM_MODEL` (default `claude-haiku-4-5`).
- **403**: `text()` (:36-41) throws `Blocked` on 401/403, which gives status `blocked` (:477-479). Any status other than "imported" falls back to `importViaWebSearch()` (:483-486). There is no evasion; it gives up on that site.
- **Limits**:
  - Fetch timeout 30 s.
  - Images 15 KB-4.5 MB, JPEG/PNG/WebP magic bytes checked.
  - Max 5 photos per page; 3 via web search.
  - YouTube links found on the page go to `youtube_links.txt` (used by the product pool).
  - Retry after 7 days (`presskit/official_tried.json`).

### 2.2 Web research: `src/lib/agent/webResearch.ts`
- **Call**: Anthropic server tool `web_search_20260209` (`max_uses: 4`) plus a strict `report_product_research` tool (:48-79, :166).
  - `client.beta.messages.create` with `effort: "low"` and `max_tokens 16000`, up to 5 turns, `pause_turn` handled.
- **Output**: up to 4 official pages and 3-4 spec chips (≤24 chars).
  - `clean()` (:114-133) drops retailers, marketplaces and social sites (:126) and keeps specs of 28 chars or fewer.
- **Cache**: `channels/<ch>/presskit/<slug>/research.json`, `REFRESH_DAYS = 30`.
- **Env**: `WEB_RESEARCH` (on) and `WEB_RESEARCH_MODEL` (`claude-opus-5-5`). Your `.env` has `WEB_RESEARCH=off`.

### 2.3 Footage agent: `src/lib/agent/footage.ts`
- **Queries**: per scene, 4 searches of 2-5 words: exact subject → the kind of thing doing something visible → a close-up/detail → a broad mood shot. Plus one `visual` sentence (≤20 words) that CLIP uses (SYSTEM :35-50).
  - `sanitize` drops blocked terms and queries over 7 words.
  - Batches of 40 scenes, cached by sha1 of the scene inputs.
- **No thumbnail scoring in this file.** CLIP ranking happens in `src/commands/assets.ts` (`MIN_MATCH = 0.215`, :554).
- **Fallback**: scenes below `MIN_MATCH` go to `broadenFootage` (:180-199).
  - It sees up to 6 titles already returned and asks for 4 new queries that have not been tried.
  - The last resort is `webFallbackKeyword` → `web_cc`.

### 2.4 YouTube Creative Commons: `python/youtube_cc.py`, `src/lib/assets/youtube.ts`
- **Search**: `CC_FILTER = "EgIwAQ%3D%3D"` (:83), added as `&sp=`.
  - Skips Shorts, live streams, and videos under 30 s or over 4 h.
- **Licence**: `fetch()` (:153-216) refuses the video unless the watch page's `info.license` contains "creative commons" (:178).
  - It also rejects vertical videos and videos that are too short.
  - Downloads video only, just the needed range (`download_range_func`), re-encoded to libx264 crf 20.
- **TS side** (`src/lib/assets/youtube.ts`):
  - `SEGMENT = 15` s, starting 35% into the video, or at 30 s if the length is unknown (:229).
  - Search cache 7 days; `YTCC_MAX_SEARCHES` 40.
  - Max height 720 or 1080 depending on `STOCK_MAX_WIDTH`.
  - The `Worker` class (long-lived JSON-lines process) takes a rate-limit slot before each request.

### 2.5 General web crawl: `python/web_crawl.py`, `src/lib/assets/webCrawl.ts`
This is the `web_crawl` provider. It does **no licence check** (licence recorded as `unknown/web`) and **no robots.txt check**.
- **Search**: `WEBCRAWL_SITES` default `youtube.com,youtu.be,vimeo.com,dailymotion.com,archive.org`.
  - YouTube is searched with `ytsearch`; the other sites via `DDGS().videos()`, filtered by host.
- **Loop** (`webCrawl.ts`):
  1. `preview()` (:129-167): a 360p preview of `WEBCRAWL_PREVIEW_SECONDS` (45) s, 30% into the video.
  2. `splitShots()` (:103-127): `python/split_shots.py`; if that fails, 3 ffmpeg frames.
  3. Each shot of at least `SHOT_MIN_SECONDS` (1.5) becomes a CLIP candidate.
  4. `downloadWebCrawl()` (:275-297) fetches only the picked shot in HD: heights 1080/720/480, length min(20, max(shot, `WEBCRAWL_SECONDS` = 10)).
- **Python fetch**:
  - On a 403 the range download is retried once, then it falls back to a full download under `WEBCRAWL_MAX_MB` (80).
  - Each fetch runs in a child process with a hard timeout (`fetch_guarded`).
- **Mode**: `WEBCRAWL_MODE=fallback` crawls only when there are fewer than `WEBCRAWL_WHEN_FEWER` (6) candidates.
- **Separate last resort, `web_cc`** (`python/web_crawler.py`, `src/lib/assets/webCrawler.ts`): Creative Commons only.
  - `licence_ok` accepts CC BY, BY-SA, CC0 and PD, and rejects NC and ND.
  - Respects robots.txt per RFC 9309 and waits a per-host delay (`WEBCC_HOST_DELAY` 1.5 s).
  - Cuts a 5 s piece with MoviePy.

### 2.6 Footage library: `src/lib/assets/footageLibrary.ts`
- **Storage**: SQLite via Node's built-in `node:sqlite` `DatabaseSync` at `cache/footage_library.sqlite`. Falls back to `cache/footage_library.json`.
- **Schema** (:49-51):
  `shots(id PK, path, source, url, license, author, kind, duration, width, height, title, model, embedding TEXT, added)`
- **Embeddings**: the CLIP vector is stored as JSON text. **There is no vector index.**
  - `queryLibrary` loads the rows for the current `model`, takes a dot product with each (vectors assumed normalised), and returns the top 5.
  - A match counts above `LIBRARY_MIN_MATCH` (0.27, used in assets.ts:992).
  - In assets, a library clip can be used at most twice.

### 2.7 Stock APIs: `src/lib/assets/sources.ts`
`STOCK_PROVIDERS`: storyblocks, pixabay, pexels, unsplash, wikimedia_video, archive, youtube_cc, web_crawl.

| Provider | Endpoint | Key |
|---|---|---|
| Pexels | api.pexels.com/videos/search | `PEXELS_API_KEY` |
| Pixabay | pixabay.com/api/videos | `PIXABAY_API_KEY` |
| Unsplash | api.unsplash.com/search/photos | `UNSPLASH_ACCESS_KEY` |
| Wikimedia | commons api.php | — |
| Storyblocks | api.storyblocks.com | `STORYBLOCKS_*` |
| Archive | advancedsearch | — |

### 2.8 Exact-model vault (the main product source)
**`src/lib/agents/youtube/ytExtractor.ts`**
- **Vault layout**: `workspace/models/<brand>_<model>/` with `clips/`, `frames/`, `_work/` and `manifest.json` (`VaultManifest` :266-281: items, processed windows, rejected videos, stats).
- **Search**: `"Brand Model" walkaround|review|demo|official`, limit 10 per query.
  - When fewer than `FUZZY_MIN_HITS` (2) videos are kept: re-search with the spelling the titles agree on, then a core-model retry with the brand required in the title (new in `51df7ec`).
- **`filterHits`** rejects, in order:
  1. title does not name the exact model (`modelPattern`)
  2. length outside 45 s-25 min (Shorts 15-60 s allowed)
  3. title names another listed model
  4. `conflictingModel`
  5. `generationConflict`
- **Windows**: `planWindows`, `HARVEST_WINDOWS` 4 × `HARVEST_WINDOW_SECONDS` 20 s per video, `HARVEST_MAX_VIDEOS` 6.
  - Chapters that name a feature come first; the rest are spread between 10 s and 92% of the video.
- **Shots**: FFmpeg `select='gt(scene,0.3)',showinfo` (:517) → `shotsFromCuts` (:204-221).
  - Shots under 1.5 s are dropped; shots up to 6 s are kept whole; longer ones are cut into 5 s slices.
  - 0.1 s is trimmed at each cut.
- **CLIP scoring** (`clipScorer.ts`): positive prompt `"<brand> <model> <category> machine closeup action outdoors"` against talking-head, logo and title-card negatives.
  - Thresholds `HARVEST_MIN_POSITIVE` 0.2, `HARVEST_MAX_NEGATIVE` 0.34, `HARVEST_MARGIN` 0.005.
  - If CLIP fails, nothing is kept.
- **Keyword mode**, `harvestKeyword`: the transcript comes from, in order, youtube-transcript-api, then yt-dlp captions, then Whisper. Each clip is 3-5 s, starting 0.5 s before the spoken word.

**`src/lib/agents/autoFetch.ts`**: `planFetches` queues a harvest when a vault has fewer than `AUTO_FETCH_MIN_CLIPS` (6) clips, and a spec harvest for each narrated spec. Products with no searchable brand/model are skipped and logged.

**`src/lib/assets/productPool.ts`** (used when generic stock is on and the niche enables the pool):
- **Sources**: official YouTube links, browser product videos, `fetchRetailImages` (retail photos, `RETAIL_IMAGES_WANT` 16), and Amazon/Google/Bing video results (`PRODUCT_WEB_VIDEOS`).
  - So a retail/Amazon image path exists, but **only outside exact-only mode**.
- **Scoring**: CLIP image-to-image against reference photos plus text-to-image, score `img + 0.5·txt`.
  - Near-duplicates above cosine 0.96 are removed; an uploader cap applies.
  - Claude does the exact-model check (`PRODUCT_VISION`).
- **Gate**: `minTarget` 12 verified shots; below that the product is `insufficient` in `product_pool_status.json`.
- **Exact-only mode**: `product_pool.json` is instead written by `assets.ts:867` from `vaultPoolShots` + diagrams.

### 2.9 Rate limiting: `src/lib/rateLimit.ts`
A sliding window per source with an optional minimum gap. It is shared through a Redis Lua script when `REDIS_URL` is set; otherwise, or after a Redis error, it runs in-process.

| Limiter | Max / window | Gap |
|---|---|---|
| pexels | 200 / 1 h | — |
| pixabay | 100 / 60 s | — |
| unsplash | 50 / 1 h | — |
| youtube | 30 / 60 s | 1.5 s |
| duckduckgo | 20 / 60 s | 2 s |
| retail | 20 / 60 s | 2 s |
| any other host | 600 / 60 s | — |

Override with `RATE_LIMITS="name=max/windowSec[:gapMs]"`.

---

## 3. Shots, scenes and pacing

### 3.1 Camera-cut detection (three separate detectors)

| Where | Detector | Threshold | Short shots | Long shots |
|---|---|---|---|---|
| `python/split_shots.py` (web crawl) | PySceneDetect `ContentDetector` | 27.0 (not settable from TS) | dropped below `SHOT_MIN_SECONDS` 1.5 | not chopped |
| `ytExtractor.ts:517` (vault) | FFmpeg `select='gt(scene,0.3)'` | 0.3 (hardcoded) | dropped below 1.5 s | cut into 5 s slices above 6 s |
| `python/shot_qa.py` (QA) | PySceneDetect `AdaptiveDetector` | min 12 frames | — | — |

### 3.2 Scenes: `src/commands/plan.ts`, `src/lib/planner/*`
- **Limits**: `niche.scenes ?? style.scenes` (:168).

  | Niche / style | avg | min | max (s) |
  |---|---|---|---|
  | listicle, explainer, breakdown, tech_web, tech-amazon, `channels/tech` | 7 | 5 | 10 |
  | documentary | 9 | 6 | 14 |
  | guns, guns_web | 4 | 3 | 5.5 |
  | `channels/{default,auto,…}` style.json | 8 | 6 | 12 |
  | auto-detect, `allowStock:false` | 4 | 3 | 5.5 |
  | auto-detect, otherwise | 7 | 5 | 10 |

- **Flow**:
  1. Sections: `sectionsFromScript` / `detectSections` / one body section.
  2. `findBounds` (hook / intro / outro: LLM with a heuristic fallback; `HOOK_MIN=3`, `HOOK_MAX=15`, `OUTRO_MAX=120`).
  3. `applyBounds`.
  4. `splitIntoScenes`, a DP partition (`structure.ts:133-160`) with cost `(d−avg)² + 100 per second outside [min,max] + cut cost`. Cut cost is 0 at a sentence end, 1 at `,;:`, 3 mid-phrase.
  5. Labels: LLM or heuristic, then `repair` (now also cleans `"null"` names and merges name fragments).
  6. `capGraphics` → `routeSegments` → `validateScenes`.
- **Outputs**: `scenes.json`, `sections.json`, `plan_report.json`, plus the micro plan.

### 3.3 Pacing: `src/lib/pacing.ts`
- **Sub-shot cuts inside a scene** (`cutTimes` :216-249):
  1. **Hook teaser** until `hookEnd`: pieces from `TEASER_CHOICES` [0.6, 0.8, 1] s.
  2. **Intro** until `introEnd`: pieces from `INTRO_CHOICES` [1.5, 2, 2.5] s.
  3. **The rest**: `SHOT_CHOICES` / `niche.pacing.shotChoices`, default [2, 3, 4] s.
  4. **Target mode** instead, when the niche sets `targetShotSec` (guns_web 2.5, tech 2.1): `openingFactor` for the first 30 s and for 6 s after each chapter start.
- **Randomness**: `randomPieces` (:116-138) and `randomCuts` (:266-284).
  - Seeded by `contentSeed` (an FNV hash of the scene's words plus its duration, not its position), so a moved scene keeps its cuts.
  - Cuts snap to a word start within 0.35 s when both neighbouring pieces stay in range.
- **`ShotLedger`** (:305-348): it records every on-screen window, keyed by source identity.
  - Methods: `reserve` / `claim` (shot locks), `take`, `free` (0.05 s tolerance), `gapOk`, `forced`. Stills occupy the whole file (`STILL = 1e6`).
  - `REUSE_GAP_SEC` is 30.
  - `farthestIn` picks the in-point farthest from moments already shown.
  - A forced repeat gets a mirror, a punch-in, or both.
- **Pick order per sub-shot** (:664-749):
  1. Shot lock.
  2. Intro preview of the product being named.
  3. Outro pool.
  4. Hook teaser.
  5. Photo on a price / intro line.
  6. Own product pool → photo.
  7. Stock, only within `MAX_STOCK_SHARE` (0.2) of the chapter.
  8. Reuse with the 30 s gap → photo reuse → reuse without the gap.
  9. Generic scenes: own clip → stock → any product's unused verified B-roll → reuse.
  10. Logged forced reuse.
- **`poolPick` score**: `2·imgSim + text/scene sim + 1.5 for the same spec + 0.6·mix`, then penalties:
  - −1 for the same author as the last shot
  - −0.3 for an in-point > 0
  - −0.4 for a static window
  - −0.3 for a shot type not in the mix
- **Transitions**: a flash + whoosh only at product boundaries; every other cut is a hard cut.

### 3.4 Asset allocation: `src/commands/assets.ts`
- **`vaultProductOf`** (:281-290):
  - A scene uses its own product's vault.
  - A product scene **without** a vault gets none: it falls through to press kit, then a text card, and is reported.
  - Only scenes naming no product, in exact-only mode, borrow the nearest product's vault.
- **`vaultAsset` ranking** (:298), lowest first:
  `rank = uses×10 − 5 (feature named in the narration) − 1 (video) − clipPositive`
  The top 40 items are saved to `candidates.json` for the review page.
- **Other reuse penalties**:
  - stock CLIP ranking subtracts `reusePenalty(u) = 0.04u + (u≥2 ? 0.08(u−1) : 0)` (`licenseLedger.ts:120-123`)
  - `pick` (:178) takes the least-used of the top 8
- **Outputs**: `assets.json`, `license_log.csv`, `licenses.json`, `candidates.json`.
- **M3 gate** (:880-895): fails if any scene has no file or no licence.

---

## 4. Render, cache, overlays, QA

### 4.1 Render: `src/commands/render.ts`, `src/lib/encoder.ts`
- **Encoder choice**:
  - `VIDEO_ENCODER` defaults to `auto`; `libx264` / `cpu` force the CPU.
  - Otherwise `nvencUsable()` (:19-24) runs a real 3-frame NVENC test encode, once per process.
  - `EncoderPicker` (:45-63) is a circuit breaker: each segment tries `[nvenc, nvenc, x264]`; after 3 failures it switches to x264 only.
- **Encode settings** (:233-236):
  - NVENC: `-preset p5 -rc vbr -cq 22 -b:v 0 -maxrate 10M -bufsize 20M -g 60`
  - x264: `-preset veryfast -crf 21 -g 60`
  - Video only, `-frames:v n`, timescale 15360.
- **Segment graph**, `segmentArgs` (:152): sub-shots each zoompan'd to 1.05 → `concat` → overlays → logo → ASS captions with `fontsdir` (time-shifted with `setpts`).
  - Written to `.part.mp4`, then renamed; the encoder is recorded in `<seg>.enc`.
  - `RENDER_CONCURRENCY`: 2 when free RAM is over 4.5 GB, else 1.
- **Concat** (`src/lib/compiler/concatDemuxer.ts`):
  - `concat.txt` gives each segment an exact `duration` computed from its frame count, which stops drift of about one frame per scene.
  - `-f concat -safe 0 -c:v copy`, or a single re-encode when the segments came from mixed encoders.
- **Audio**:
  - Voice resampled to 48 kHz stereo and `atrim`med.
  - Music looped with `-stream_loop -1`; SFX combined with `amix normalize=0`.
  - Final chain `loudnorm=I=-14:TP=-1.5:LRA=11`, `aac 192k`, `+faststart`.
  - `render_report.json` says `sync` only when A/V differ by less than 0.1 s and video-vs-timeline by less than 0.1 s.

### 4.2 Segment cache: `src/lib/compiler/incrementalCache.ts`
- **Hash**: SHA-256 over `canonicalJson` (sorted keys) of `sceneContentHash` (:58-83). It covers:
  - the version (6) and the scene length in frames
  - each asset and shot: path + size + mtime, kind, in-point, variant
  - captions, relative to the segment start (`relativeCaptions`, ms), plus the caption style
  - overlays and their files, logo, transition, motion, fades, backdrop, showcase
- **Not hashed**: scene id, the scene's position in the video, and the voice audio. That is what makes a moved scene reusable.
- **Files**: `<project>/cache/segments/seg_<24 hex>.mp4`, content-addressed, with a `manifest.json`.
  - `commit()` deletes unreferenced segments.
  - Identical scenes are rendered once.

### 4.3 Overlays and motion
- **Ken Burns** (`motionFilter` :38-51): zoom 1.03 on graphics, 1.06 on stills. zoom in/out is linear in `on/n`; pan_x = `(iw−iw/zoom)·on/n`. The image is upscaled 1.5× before zoompan to avoid jitter.
- **Showcase** (`prepareShowcase` :95-117, `showcaseGraph` :76-89):
  - **Canvas**: (W+120)×(H+68).
  - **Backdrop**: `boxblur=36:3,eq=brightness=-0.24:saturation=0.85`, or a radial "studio glow" behind cut-out photos.
  - **Shadow**: alpha 0.55, offset 74:84, `boxblur=22:2`.
  - **Motion**: progress `p = min(1, t/D)`; scale `1 + 0.06p`; backdrop x moves 120·p; photo x offset `−dir·30·(p−0.5)`.
  - **Direction**: from the scene's pan motion, else alternating by scene id.
- **`PRODUCT_PARALLAX`** (env, on): when it is off, or motion is `none`, a still gets `fitToFrame` instead: one baked frame, the photo centred over a copy of itself blurred with `boxblur=40:3`. `PHOTO_PARALLAX` (on) controls the Remotion `PhotoParallax` card (`specVisuals.ts:135`).
- **Sliding cards** (:133-141): ease-out cubic `pow(1−clamp((t−d)/len), 3)`.

  | Animation | Distance | Duration |
  |---|---|---|
  | slide_up | 70 px | 0.4 s |
  | slide_left | 760 px | 0.45 s |
  | slide_right | 820 px | 0.4 s |

  Fade in and out 0.3 s.
- **`renderSpecChip`** (`graphics.ts:240`):
  - Font size 36 when the label is over 20 characters, else 42.
  - Width `min(700, len·size·0.6 + 80)`, height 84.
  - Position x = W−w−70, y = 250 + 108·index, panel opacity 0.84 with a 10 px accent strip.
  - Placed with `slide_right` (timeline.ts:430).
- **Remotion** (`src/lib/render/remotionCards.ts`, `cards/src/`):
  - Rendered to ProRes 4444 with alpha, cached at `cache/cards/<comp>_<sha1-16>.mov`.
  - Compositions: RankCard, PriceCard, SpecCard, LowerThird, SpecBars, ProsCons, PriceTag, CompareTable, GaugeCard, PartCallout, HookTitle, PhotoParallax.
  - HookTitle is capped at 16 s, other cards at 6 s.
  - Falls back to drawtext PNG cards when Remotion is missing or `CARDS=off`.

### 4.4 QA
**`qa --preflight`** (`src/cli.ts:148` → `qaPreflight`; checks in `qaGate.ts:199-217`), before render:

| Check | Fails / warns when |
|---|---|
| `checkAssetFiles` | a media file is missing or unreadable (fail) |
| `checkClipReuse` | a clip is used more than `qa.maxClipUses` (4) times (fail) |
| `checkExactRepeats` | the same moment is shown twice (fail) |
| `checkShotLength` | a shot is longer than `qa.maxShotSec` (4) (warn) |
| `checkProductMatches` | a model conflict (fail); unverified (warn, fail in strict) |
| `checkLicenseRecords` | `licenses.json` is missing or a record is missing (fail) |
| `checkDiscrepancies` | a significant discrepancy is unresolved (fail) |

**Full `qa`** (`src/commands/qa.ts`) on the rendered file runs all the preflight checks plus:

| Check | Threshold |
|---|---|
| A/V sync | < 0.1 s |
| Length vs timeline | < 0.15 s |
| Black frames | `blackdetect=d=0.4:pix_th=0.10`, any hit fails |
| Frozen clips | `freezedetect=n=-55dB:d=3` (warn) |
| Shot QA | `shot_qa.py`: talking heads fail; static shots (2 s+) warn when more than 3; repeats fail above CLIP similarity 0.97 |
| Silent gaps | `silencedetect=n=-45dB:d=2.5`; warns, fails at 5 s |
| Loudness | `ebur128`: −14 ± 2 LUFS (warn outside) |
| Clipping | true peak ≤ −0.5 dBFS (warn above) |
| Captions | aligned words must cover more than 80% of the video |
| Distinct footage | pass ≥ 0.6, warn ≥ 0.4 |
| Most repeated clip | pass ≤ 3 uses, warn ≤ 5 |
| Product sections show only their product | any leak fails |
| Graphic cards | warn above 35% of the video |
| Run of stills | warn above 4 in a row |
| Verified footage per product | insufficient fails, pass at 80% |
| Product shots without real media | pass at 0, warn up to 30% |

**`doctor`** (`src/commands/doctor.ts`) checks, without failing on the hardware ones:
- Node, Python 3.11, `.venv`
- FFmpeg and FFprobe; NVENC test (warn)
- `nvidia-smi` (warn)
- RAM (warn below 3 GB free) and disk (warn below 20 GB)
- `.env` keys
- yt-dlp, the web crawl dependencies, the footage library, vision

**Timeline footage gate** (new in `51df7ec`, `timeline.ts`): warns when chapters have less than `FOOTAGE_GATE_MIN_SHARE` (0.3) own-product footage. `FOOTAGE_GATE=strict` stops the run.

---

## 5. Architectural risks found during this extraction

1. **Whisper prompt is niche-specific.** `transcribe.py` tells Whisper the video is about "guns, hunting and survival gear" for every niche, which biases word recognition. It should come from the niche or the title.
2. **`web_crawl` ignores robots.txt and licences** while `web_cc` honours both. Its footage is recorded as `unknown/web`, so this is a legal-risk path, not a bug. It stays in `fallback` mode by default.
3. **Retail/Amazon images exist only in `productPool.ts`, which exact-only mode skips.** That is why every chapter showed `photos 0s` in video-1019-1843. Wiring `fetchRetailImages` into the exact-only vault, with a model-name check, is the smallest fix for audit P1-4.
4. **Three cut detectors with different thresholds** (27 adaptive, 0.3 FFmpeg, AdaptiveDetector) mean the same video splits differently depending on the source.
5. **`RENDER_CHUNK_SECONDS` is dead config.** Remove it from `.env.example` or implement it.
6. **The footage library uses a linear scan** (a JSON vector per row, dot product in JS). Fine for thousands of shots; slow beyond that.
