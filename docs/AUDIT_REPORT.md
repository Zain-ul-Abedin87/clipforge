# ClipForge — Audit Report

*Code state: 2026-10-18, branch `feature/general-web-crawler` (uncommitted). All numbers in this report come from the code.*

---

## 1. What the tool does

You provide a voiceover and/or a script; ClipForge produces a 1920×1080 faceless YouTube video with scenes, footage, cards, captions and sound, plus a description and chapters for publishing. Everything runs on your computer. An AI model (Claude, or Qwen locally/in the cloud) is used only for some decisions; with AI switched off, built-in rules are used.

**One UI** at `http://localhost:4173/`:

| Page | Purpose |
|---|---|
| Create | Add a script and/or voiceover, choose a channel, press Go |
| Studio (`#/project/<name>`) | Live preview while the video is made, CapCut-style editor, Render, final video, QA and publish pack |
| My videos | All projects |
| Library | Model vault, press kit, my clips, batch production, glossary |
| Settings | Defaults, footage sources, channel style, AI model and credit budget, API key status |

Start: `npm run serve`. CLI: `npx tsx src/cli.ts <command> -p <project>`.

### Studio live preview
The edit preview is the timeline played by the **Remotion Player** (`cards/src/preview`, bundled by `npm run build:preview` into `web/simple/preview.bundle.js`; `npm run serve` builds it first). It shows pictures with their source in-points, the same Remotion cards the render uses (drawn live from their props, fonts and photos from `cards/public` served at `/cards-static`), burned-in captions (re-timed after cuts), scene transitions (fade / flash), the logo, the voice and the music bed, and its clock drives the timeline playhead. The server builds the preview data in `src/lib/preview/previewModel.ts` (RPC `editor.preview`). It is a faithful draft, not pixel-exact: motion on stills, blur-pad fits and music ducking are approximated; the render stays the reference.

### Studio transcript editing
The **Transcript** tab shows every spoken word (from `aligned.json`, re-timed after cuts, `src/lib/transcriptEdit.ts`). Click a word to jump to it, drag or Shift+click to select, **Delete** removes the words from the voice and the pictures in one `cutRange` edit (the pause before them stays, the next word follows it). **Tighten pauses** shortens every pause longer than a minimum (default 0.5 s) to a kept length (default 0.2 s) in one undo step; a single pause can be shortened from its chip. A cut never leaves a picture under 6 frames (its neighbour takes the time). Word starts are rounded down to a frame so a cut drops whole words and never clips the next one.

### Caption styles and voice cleanup
- **Caption styles** (`src/lib/render/captionPresets.ts`): Classic (the original dark box, unchanged), Bold, Karaoke (the spoken word lights up), Pop (one word at a time) and Minimal. One definition drives the render (ASS subtitles burned in by FFmpeg, karaoke uses `\kf` fills) and the studio preview (Remotion), so what you see is what is rendered. A channel sets its default in Settings → Channel style preset; a video can change it in the Studio (**CC Captions**), which also switches captions on and sets the size. Captions are burned into every scene, so a style change re-renders the whole video.
- **Voice cleanup** (`src/audio/voiceCleanup.ts`, Studio **Voice**): noise reduction (off / light / strong, FFT denoise), rumble and hum filter (80 Hz high-pass), evening out the volume (gentle compression) and normalizing the voice loudness (about -16 LUFS before mixing; the final video is still -14 LUFS). Off by default. It is applied to the whole voice in the render, changes only the sound (no scene re-renders), and the panel plays 8-second before/after samples at the playhead. Noise reduction takes a few dB off steady hiss; it cannot rescue a very noisy recording.

---

## 2. The pipeline at a glance

```
Script / Voiceover
   │
   ├─ Step 0  TTS (Mode B only)     script → voice (Windows voice / ElevenLabs / OpenAI / Piper)
   ├─ Step 1  Transcribe            voice → start time of every word (Whisper)
   ├─ Step 2  Align                 script ↔ voice, differences found
   ├─ Step 3  Plan                  scenes, type (product/stock/graphic), sections (#5..#1)
   ├─ Step 4  Assets                footage per scene (own → model vault → press kit → card)
   │            └─ Model vault harvest (YouTube) when a product has no vault
   ├─ Step 5  Timeline              2–3 s cuts, cards, lower thirds, SFX, logo, captions
   │            └─ (stops in the Studio when "Stop in the studio before rendering" is on)
   ├─ Step 6  Render                one segment per scene (cached), then joined into the MP4
   └─ Step 7  QA                    checks + description / chapters / pinned comment → Approve
```

Each step writes its output to `workspace/<project>/`. On a re-run, steps whose inputs did not change are skipped as "cached" (`--force` redoes them).

---

## 3. Input modes

| You provide | Mode | Text from | Timing from |
|---|---|---|---|
| Voiceover only | **A** | Whisper transcript (corrected with the glossary) | Voiceover |
| Script only | **B** | Your script | TTS voice |
| Script + voiceover | **C** | Your script | Your voiceover |

### Mode B — TTS
- `TTS_PROVIDER` empty in `.env` = the built-in Windows voice (robotic, for drafts). Speed: `WINDOWS_TTS_RATE` (-10..10, default 1).
- `elevenlabs` (key + voice ID), `openai` (key, default voice `alloy`, model `gpt-4o-mini-tts`), `piper` (exe + .onnx file).
- Long scripts are split into chunks (ElevenLabs 2,400, OpenAI 3,800, Piper/Windows 20,000 characters) and joined with FFmpeg.
- **Glossary pronunciation:** a line such as `Cat DG671 = Cat D G six seventy one` in `inputs/glossary.txt` is sent to TTS only; **the script is never changed**. The text sent to the voice is saved in `tts_payload.txt`.
- An invalid key (401/403) gives a clear error; 429/500 responses are retried twice.

### Mode C — script vs. voice differences
- Script words are aligned to spoken words (banded Needleman-Wunsch).
- Every mismatching run becomes a "discrepancy": **omission** (in the script, not spoken), **addition** (spoken, not in the script), **substitution** (both differ).
- It is **significant** when a number changes (999 vs 899), a negation changes (not/never/don't…), or a model variant changes (pro, max, plus, mini, ultra, gen, mk, ii/iii…, or codes such as p365/s24). Words that the transcriber merely split differently ("six-shot" vs "six shot", "$289.99" vs "$289 .99") do not count.
- You choose: `keep_audio` (captions follow what was said), `correct_transcript` (Whisper misheard; the script is right), or `modify_script` (rewrite script.txt to match the voice; backup `script.before-modify.*.txt`).
- An unresolved significant difference fails QA.

---

## 4. Each step in detail

### Step 1 — Transcribe
- Whisper (`WHISPER_MODEL`, default `large-v3-turbo`, GPU `cuda`) returns the start/end time of every word → `words.json`.
- Glossary names are passed to Whisper as a hint (max ~600 characters).

### Step 2 — Align
- Glossary fixes: "Moss Berg 500" → "Mossberg 500". Model numbers must match (Glock 17 never becomes Glock 19). Similarity 0.8+ (0.85+ for short names).
- In script mode the spelling comes from the script and the timing from Whisper; unspoken words are interpolated.
- Output: `aligned.json`, `discrepancies.json` (Mode C).

### Step 3 — Plan (scenes)
- Scene length by video type, e.g. general 6–12 s, documentary 6–14 s (avg 9), explainer/breakdown/tech 5–10 s (avg 7).
- **Listicle detection** (regex): a sentence starting with "Number 5…", "#3", "coming in at number 2", "our number 1…" opens a new section. Ranks 1–25; only a consecutive chain (5,4,3,2,1) counts. Outro: "that wraps up", "thanks for watching", "see you in the next"…
- The active AI model (or the rules when AI is off) labels each scene: `stock`, `product`, `graphic` (title card, spec card, price badge, pros/cons), `image`. A local model gets smaller batches (20 scenes) and its answers are normalized per scene, so one bad label never discards a whole batch.
- **Segment routing:** `specific_product` (a named product is discussed) vs `generic_hook` (stats, intro, advice).
- "auto" channel: the model reads the title and script and writes the project niche (`<project>/niche.json`): category, shot length (1.8–3 s), search hints, blocked words.

### Step 4 — Assets (footage) — **the most important step**
Default policy: **real exact-model footage only**.

| Order | Source | When |
|---|---|---|
| 1 | Your uploads (`channels/<ch>/footage/`) | Always first |
| 2 | **Model vault** (`workspace/models/<brand>_<model>/`) | The scene is about that product, or the nearest product |
| 3 | Press kit / official photos (`channels/<ch>/presskit/`) | No vault |
| 4 | Text card + note | Nothing found |

- Pexels, Pixabay, Unsplash, Wikimedia, Archive.org, Storyblocks and CC/web crawl are **off** (`GENERIC_STOCK=on` re-enables them).
- When a product has no vault, the assets step harvests one automatically (`AUTO_HARVEST=off` disables this). See Section 5.
- How a scene gets a vault clip (`vaultAsset`):
  1. The scene's product (`product_name`, or the section it belongs to); otherwise the vault of the nearest product scene.
  2. Ranking: least-used first (×10 weight) → bonus (−5) when the scene text names the clip's feature ("deck") → video before photo → higher CLIP score.
  3. If the previous scene is a still and this one would be too, only video clips are allowed (avoids a slideshow).
  4. Every vault clip also becomes a swap option in the Studio (max 40).
- Vault clips are also written to `product_pool.json`, so the timeline cuts each scene from several clips in 2–3 s pieces.
- Each asset's licence is recorded in `license_log.csv` and `licenses.json`.

### Step 5 — Timeline
- 30 fps, 1920×1080, frame-exact boundaries (no drift).
- **Pacing** (when enabled by the niche): target shot 2.8 s by default (tech 2.1, guns 2.5), min 1.4, max 4, slightly faster in the first 30 s. Cuts land on word starts. The same moment of a source is not shown again within 30 s (`REUSE_GAP_SEC`); scene clips and pool shots share one footage identity (source video + time), so a moment is never repeated under a different file name.
- **Black-frame guard:** pacing sub-shots that would show a black stretch (a fade or scene change inside a harvested clip) are moved to a clean part of the clip.
- Cards (Remotion), lower thirds, rank badges, flash transitions, whoosh/pop SFX (-14 dB), logo, captions (channel setting).
- **Music is off by default.** Each video chooses its music when it is created: *Channel default* (the channel's `style.json` `music.enabled` plus every track of its library as a playlist), *No music*, or one track of the channel library. Tracks are uploaded in **Library → Music** (or from the Create page) and need a source/licence note. Level, ducking, fades and the track itself can then be changed in the Studio (**♪ Music**): the choice is stored in `project.json` (`music`), the bed lives on the timeline's music track, and the preview plays it (ducking is approximated; the render ducks exactly under speech).
- Price cards take their price from the script (`facts.json`); QA verifies the match.

### Step 6 — Render
- One segment per scene: NVENC (GPU, cq 22, max 10 Mbps); on failure, two retries, then x264.
- **Cache:** each scene's SHA-256 hash = its voice slice + footage files (path, size, mtime) + captions + overlays + transition + motion + logo. Same hash → the existing segment is reused (`workspace/<p>/cache/segments/`).
- Edit one scene → only that scene re-renders; the rest are joined (FFmpeg concat with exact durations, no drift).
- Sections cut out in the editor are removed from the voice too: the audio plan plays only the kept parts of the voice file, and captions are re-timed to match.
- Audio: voice + SFX (+ music, ducked under the voice unless ducking is switched off; level and 0–10 s fades from the Studio), loudness -14 LUFS, true peak -1.5, AAC 192k. Changing only the music re-muxes the audio; no scene is re-rendered.
- Less than 4.5 GB free RAM → one segment at a time.

### Step 7 — QA
Fail = the video cannot be approved. Warn = review it.

| Check | Fails / warns when |
|---|---|
| Resolution / codec / fps | not 1920×1080, H.264 + AAC, 30 fps → fail |
| A/V sync, length | difference above 0.1 s / 0.15 s → fail |
| Black frames | 0.4 s+ → fail |
| Frozen video clip | 3 s+ → warn |
| Silent gaps | 2.5 s+ warn, **5 s+ fail** |
| Loudness | outside -14 ± 2 LUFS → warn |
| Media files | missing / empty / unreadable by ffprobe → fail |
| Clip reuse | one clip in more than 4 scenes (tech-amazon: 3) → fail |
| Distinct footage | below 60% warn, below 40% fail |
| Repeated segments | the same part of a source shown twice → fail |
| Another product's clip in a product section | fail |
| Exact model | conflict → fail; unverified → warn (fail in strict niches) |
| Licence ledger | external asset without a record → fail |
| Mode C differences | unresolved significant → fail |
| Background music licence | a track without a licence note → warn |
| Exact-model YouTube clips | used → **warn (rights)** |
| Web-crawled / CC uploaders | warn |
| Share of still images | per niche (e.g. 50% warn, 65% fail) |
| Picture vs narration (AI check) | wrong product → fail |
| Price card vs script | mismatch → fail |

- `qa --preflight`: checks files, reuse, models, licences and differences without a rendered video.
- Re-rendering after approval cancels the approval automatically.
- Output: `report.md`, `qa_report.json`, `publish/` (description, chapters, pinned comment, title, thumbnails).

---

## 5. How YouTube clips are collected (model vault)

Code: `src/lib/agents/youtube/ytExtractor.ts` (decisions) + `python/yt_extract.py` (talks to YouTube via `yt-dlp`). No YouTube API key is needed.

### 5.1 Search
Four queries, top 10 results each (listing only, no download):
```
"<brand> <model>" walkaround
"<brand> <model>" review
"<brand> <model>" demo
"<brand> <model>" official
```

### 5.2 Video selection rules
| Rule | Value |
|---|---|
| Exact model in the title | required; spaces/dashes allowed ("HRX 217", "Z-930M") |
| Trim suffix | a model ending in a digit may carry 1–3 letters ("HRX217HZA"); `HARVEST_ALLOW_TRIMS=off` disables this |
| Another model in the title | rejected ("HRX216 vs HRX217", "Z930M vs Z960M"); sizes such as `21"` are not treated as models |
| Different generation | rejected ("Gen 5" when "Gen 3" is wanted) |
| Length | under 45 s or over 25 min → rejected |
| Ranking | walkaround/official/demo in the title +2, the brand's own channel +1 |
| Max videos | 6 (`HARVEST_MAX_VIDEOS`) |

### 5.3 Which part of a video
- 4 windows × 20 s (`HARVEST_WINDOWS`, `HARVEST_WINDOW_SECONDS`).
- The first 10 s (intro) and the last 8% (outro) are skipped.
- Uploader chapters naming your feature ("deck") are used first.
- The rest are spread evenly and nudged apart when they overlap.

### 5.4 Keyword mode (spec close-ups) — transcript chain
For a spec such as "trigger", only 3–5 s around each spoken mention is downloaded. The words come from a three-step chain:
1. **youtube-transcript-api** — one fast request. If the transcript exists and the keyword is never spoken, the video is skipped before anything is downloaded.
2. **yt-dlp captions (json3)** — exact per-word times for the clip windows. If yt-dlp cannot read them, the line-timed transcript from step 1 is used.
3. **Whisper** — only for videos without any captions: the audio is downloaded and transcribed locally (GPU, falling back to CPU). Limited to `KEYWORD_WHISPER_MAX` videos per keyword (default 2) and videos up to `KEYWORD_WHISPER_MAX_SECONDS` (default 1,500 s); `KEYWORD_WHISPER=off` disables it.

### 5.5 Download
- `yt-dlp` fetches only the selected window, **without audio**, max 1080p, re-encoded to H.264 mp4.
- On a YouTube 403, a fresh link is fetched and retried, then a short full-file fallback. Each window has a 3-minute timeout.
- Proxy (`YTDLP_PROXY`), cookies (`YTDLP_COOKIES_FILE` / `YTDLP_COOKIES_FROM_BROWSER`) and request pacing are shared with the web-crawl code.
- Vertical videos are converted to 16:9 or rejected.

### 5.6 Shots and the talking-head filter
1. FFmpeg `select='gt(scene,0.3)'` → camera cuts; 0.1 s trimmed on each side of a cut.
2. Shots under 1.5 s are dropped; shots over 6 s are cut into 5 s pieces.
3. The middle frame of each shot is extracted (full-quality JPG).
4. CLIP (`clip-ViT-B-32`, local) compares the frame with:
   - **Positive:** `"<brand> <model> <category> machine closeup action outdoors"` (category from the niche, `HARVEST_CATEGORY`, or "lawn mower")
   - **Negatives (the highest one counts):** a person talking to the camera; a person in a shop next to the product; a face close-up; a cartoon logo intro; a title card on a plain background.
5. **Decision:** worst negative ≥ 0.34, or positive − worst negative < 0.005 → **reject** (talking head or logo/title); positive < 0.20 → **reject** (not the product); otherwise **keep**.
6. Feature tag: each feature prompt is scored too ("<brand> <model> <category> deck close up"); the best feature is recorded.
7. **Black frames:** a kept shot that contains a black stretch is trimmed to its longest clean part, or dropped when that is under one second.
8. Kept: `clips/<id>.mp4` (crf 18, no audio) + `frames/<id>.jpg` for HD (720p+) sources. Rejected frames and temporary downloads are deleted.

> Calibration on real frames: a dealer talking next to a mower scored 0.02–0.11 below positive → rejected; cartoon logos → rejected; walkaround B-roll 0.02–0.04 above → kept. **The margin is thin — review each vault once.** To tighten it, raise `HARVEST_MARGIN` and run `--rescore`.

### 5.7 Vault and manifest
```
workspace/models/scag_turf-tiger-ii/
  clips/   *.mp4
  frames/  *.jpg
  manifest.json   brand, model, category, features,
                  items[ video URL + &t=, channel, title, start/end, CLIP +/- scores, feature, size ],
                  processed{video: windows},  rejectedVideos[ title + reason ],  stats
```
- Windows already processed are skipped on a re-run; failed windows are retried next time.
- `--rescore`: re-checks existing clips with the current filter, without downloading.
- Product → vault: the product name must contain the vault's exact model; a matching brand ranks first; longer model names win ("Turf Tiger II" > "Turf Tiger").

### 5.8 Commands / UI
```bash
npx tsx src/cli.ts harvest-model --brand "Scag" --model "Turf Tiger II" --features "deck,engine,blades"
npx tsx src/cli.ts harvest-model --brand "Ruger" --model "Security-9" --keyword "trigger" --category pistol
```
Options: `--category`, `--exclude "Z960M,Z950M"`, `--max-videos`, `--windows`, `--force`, `--rescore`, `--keyword`, `--aliases`.
UI: **Library → Model vault**.

---

## 6. Products and exact models

- Each product has a record in `product_research.json`: manufacturer, model, variant, generation, Amazon URL + ASIN, affiliate link (separate), spec pages, status.
- Brand = the first word, except for these multi-word brands: John Deere, Cub Cadet, Bad Boy, Briggs & Stratton, Black+Decker, Black & Decker, Smith & Wesson, Sig Sauer, Rock Island Armory, Spartan Mowers, Big Dog, Hustler Turf.
- **Affiliate links are never used in footage searches** (a query containing a URL/ASIN is an error).
- Model-match verdicts: `match` / `conflict` (other generation, variant, model number or brand) / `needs_review` (variant/generation not in the title) / `no_match`.
- Manual verdicts are stored in `model_verifications.json` (tied to the file path; they survive re-runs).

---

## 7. Licence ledger (`licenses.json`)
One record per scene: category (`own`, `presskit`, `official`, `review`, `stock`, `wikimedia`, `archive`, `unsplash`, `web`, `generated`), licence class (public domain, CC0, CC BY, CC BY-SA, stock, editorial, own, unknown), whether attribution is required, URL, author, number of scenes using it, first use.
- YouTube vault clip: the channel name contains the brand → `official`, otherwise `review`. Licence text: "standard YouTube licence – editorial use, check rights".
- Clip reuse penalty: first use 0, then 0.04, 0.16, 0.28… (increasing).

---

## 8. AI model and credit budget
- Settings → AI model: Claude, Qwen or Off (built-in rules), plus a backup model.
- Qwen runs in the cloud (Alibaba Model Studio, `QWEN_API_KEY`) or locally (Ollama, free). Local requests use Ollama's native API, so each request can choose the GPU or CPU; when the GPU returns garbage (a faulting GPU), the request is repeated on the CPU automatically ("Auto" device).
- Credit budget: enter your remaining credit and a "stop below" amount; spend is counted from token usage, and a provider is disabled automatically at the limit or on a "credit balance too low" error. Web-search steps run on Claude only.

---

## 9. Fixed values

### In code (edit the code to change)
| Item | Value | File |
|---|---|---|
| Resolution / FPS | 1920×1080, 30 | `render.ts`, `timeline.ts` |
| Fade | 0.25 s | `render.ts` |
| Loudness | -14 LUFS, TP -1.5 | `render.ts` |
| NVENC quality | cq 22, max 10 Mbps, GOP 60 | `render.ts` |
| Listicle header / outro regex | "number N", "#N", "thanks for watching"… | `planner/structure.ts` |
| YouTube query words | walkaround, review, demo, official | `ytExtractor.ts` |
| Video length | 45 s – 25 min | `ytExtractor.ts` |
| Intro / outro skip | 10 s / last 8% | `ytExtractor.ts` |
| Scene-cut threshold | 0.3 | `ytExtractor.ts` |
| Shot min / max / slice | 1.5 s / 6 s / 5 s | `ytExtractor.ts` |
| CLIP prompts (1 positive, 5 negative) | Section 5.6 | `ytExtractor.ts` |
| Stills only from 720p+ sources | 720 | `ytExtractor.ts` |
| Negation / variant word lists | Section 3 | `lib/align.ts`, `productResearch.ts` |
| Multi-word brands | Section 6 | `productResearch.ts` |
| QA thresholds | Section 4, Step 7 | `qa.ts`, `qaGate.ts` |

### `.env` settings (main ones)
| Setting | Default | Purpose |
|---|---|---|
| `GENERIC_STOCK` | off | Re-enables stock sites |
| `AUTO_HARVEST` | on | Harvests a vault when none exists |
| `HARVEST_CATEGORY` | niche or "lawn mower" | Product word in the CLIP prompt |
| `HARVEST_MAX_VIDEOS` / `HARVEST_WINDOWS` / `HARVEST_WINDOW_SECONDS` | 6 / 4 / 20 | How much is downloaded |
| `HARVEST_MARGIN` / `HARVEST_MIN_POSITIVE` / `HARVEST_MAX_NEGATIVE` | 0.005 / 0.20 / 0.34 | Talking-head filter |
| `HARVEST_ALLOW_TRIMS` | on | HRX217HZA = HRX217 |
| `KEYWORD_WHISPER` / `KEYWORD_WHISPER_MAX` | on / 2 | Whisper for caption-less videos in keyword mode |
| `TTS_PROVIDER` | (empty = Windows) | Voice |
| `LLM_MODEL` | claude-opus-5-5 | Claude model for labels and agents |
| `QWEN_API_KEY` / `QWEN_TIMEOUT_MS` | — / 240000 | Qwen cloud key / request timeout |
| `WHISPER_MODEL` | large-v3-turbo | Transcription |
| `VIDEO_ENCODER` | h264_nvenc | GPU / x264 |
| `RENDER_CONCURRENCY` | auto (RAM) | Parallel segments |
| `REUSE_GAP_SEC` | 30 | Minimum gap before a moment is reused |
| `PRODUCT_PARALLAX` | on | 2.5D effect on product photos |

### Niche file (`niches/*.json` or the project's `niche.json`)
Scene length, listicle on/off, share of cards, product sources, stock hints, blocked words, pacing (shot length), QA still limits, exact-model rules (`productMatch`), music on/off.

### Channel (`channels/<ch>/style.json`)
Colours, fonts, captions, logo, music (off by default), motion graphics/SFX, card set, shot length.

---

## 10. Files

| File | Contents |
|---|---|
| `workspace/<p>/project.json` | Settings, mode, discrepancy choices |
| `words.json` / `aligned.json` | Words + timing |
| `discrepancies.json` | Mode C differences |
| `scenes.json` / `sections.json` | Plan |
| `assets.json` / `candidates.json` | Footage + swap options |
| `product_research.json` / `product_pool.json` | Products / pacing shots |
| `licenses.json` / `license_log.csv` | Licences |
| `timeline.json` / `timeline.v3.json` | Edit (v3 is the multi-track timeline the editor changes) |
| `channels/<ch>/music/` | Music library (`sources.json` holds each track's licence note) |
| `cache/segments/` | Render cache |
| `render_report.json`, `qa_report.json`, `report.md`, `publish/` | Results |
| `output/<p>.mp4` | Final video |
| `workspace/models/<brand>_<model>/` | Model vault (shared by all projects) |

---

## 11. Known limitations and risks

1. **Copyright:** vault clips come from other channels; Content ID claims or strikes are possible. QA warns; obtaining permission is better.
2. **The CLIP filter is heuristic:** the margin is thin (~0.02). Review vault thumbnails; raise `HARVEST_MARGIN` and run `--rescore` if needed.
3. **No face detector:** this OpenCV build has no Haar face model, so the filter relies on CLIP alone.
4. **Slow connections:** windows that do not arrive within 3 minutes are skipped (retried next time). The first harvest takes several minutes per model.
5. **Titles are trusted:** if a title names the right model but the video shows another, the filter will not catch it (CLIP checks "is this the product type", not the model).
6. **Brand splitting:** multi-word brands missing from the list split incorrectly; correct them in the product record.
7. **Scenes without a product** use clips of the nearest product (stock is off), so one product's clips can appear more often.
8. **The Windows voice is robotic** — use ElevenLabs or OpenAI for uploads.
9. **Faulty GPU on this laptop:** the NVIDIA driver has logged Xid 13 "Graphics Exception" errors since 2026-10-10, so the local AI model falls back to the CPU (slower). A clean driver reinstall is recommended.
10. **Uncommitted:** all changes are still in the working tree.

---

## 12. Tests
`npm test` → 167 tests (TTS, glossary, discrepancies, niche/music, product match, ledger, scene hash, QA gate, real FFmpeg incremental render, stock policy, YouTube title/window/shot rules, transcript chain, vault, timeline editor edits incl. cut-out and transitions, AI provider layer incl. GPU→CPU fallback, Flow round trip, background music: choice, timeline ops, mix graph, licence check; live preview model; transcript edits; caption styles incl. real FFmpeg rendering; voice cleanup). All pass.
