# ClipForge — "Zero-Error Auto-Fetch Engine": what the 4 phases built

*State: 2026-10-17, branch `feature/general-web-crawler`, not committed. 104/104 tests pass (`npm test`).*

This report covers the four phases built on the agreed architecture (domain / agents / engine / compiler / server).
Earlier work (TTS modes A/B/C, model vault, licence ledger, QA gate) is in `docs/AUDIT_REPORT.md`.

---

## 0. The big picture

**Goal:** a fast-paced tech / gadget video where every shot is *real footage of the exact product* (or a generated
diagram for things nobody can film), cut every 2.5–4 s on the voice's rhythm, frame-perfect, and fixable shot by
shot in a CapCut-style editor without re-rendering the whole video.

```
script / voice
   │  Plan step ───────────────► micro_scenes.json   (Phase 1: 2.5-4 s pieces + subject + spec)
   │  Assets step ─► auto-fetch ► model vault          (Phase 2: YouTube harvest, fuzzy names, diagrams)
   │  Timeline step ───────────► timeline.v3.json     (Phase 3: multi-track, exact rational time)
   │  Render ─► compiler ──────► cached scene segments ► concat ► MP4   (Phase 3)
   └─ Editor (web/editor.html) ─► JSON-RPC ─► projectStore ─► timeline.v3.json ─► render changed scenes (Phase 4)
```

New folders (the locked architecture):

| Folder | Role | Files |
|---|---|---|
| `src/domain/` | Pure data models, no I/O | `rational.math.ts`, `timeline.types.ts`, `product.types.ts` |
| `src/lib/agents/` | Outside intelligence (YouTube, CLIP, Claude) | `youtube/ytExtractor.ts`, `youtube/fuzzyMatcher.ts`, `vision/clipScorer.ts`, `generative/manimAgent.ts`, `autoFetch.ts` |
| `src/lib/engine/` | FFmpeg / audio processing | `pacing/autoEditor.ts`, `filters/lavfiBuilder.ts` |
| `src/lib/planner/` | Planning logic | `activeSubject.ts` |
| `src/lib/compiler/` | Assembly + caching | `timelineCompiler.ts`, `incrementalCache.ts`, `concatDemuxer.ts` |
| `src/server/` | Editor backend | `state/projectStore.ts`, `routes/editorAPI.ts` |
| `web/` | Editor UI | `editor.html`, `editor.js`, `editor.css` |
| `python/` | yt-dlp helper | `yt_extract.py` (`search`, `info`, `captions`, `fetch`) |

Old paths (`src/lib/assets/ytExtractor.ts`, `src/lib/render/sceneHash.ts`) are now one-line re-exports, so nothing
that imported them broke.

---

## Foundation (before Phase 1): `src/domain/`

### `rational.math.ts` — exact time, no floats
- Every time is `n/d` seconds with BigInt numbers, always reduced (`rat(6,-4)` = `-3/2`).
- `fromDecimal(0.1)` is exactly `1/10`, so `0.1 + 0.2 = 0.3` exactly.
- Frames: `secondsToFrame`, `frameToSeconds`, `snapToFrame`, `isFrameAligned`; NTSC 29.97 (`30000/1001`)
  round-trips exactly.
- `boundariesToFrames` snaps every cut from its exact time (cumulative), so 10,000 scenes never drift.
- `toFixed` / `toNumber` exist **only** for FFmpeg arguments and display.

### `timeline.types.ts` — multi-track timeline v3
- Tracks: `voiceover`, `broll` (exclusive: one picture per frame), `overlay`, `captions`, `music`, `sfx`.
- Clips: `VideoClip` (media, fit incl. `blur_pad`, motion, transition, `single`, `backdrop`, variant,
  **provenance**: source / URL / licence / keyword / confidence / verified), `AudioClip`, `SfxClip`,
  `OverlayClip` (cards, HUD, `tracking` slot), `CaptionClip`.
- Scenes are blocks with text and an `ActiveSubject`. `settings` holds captions, logo and SFX levels.
- `validateTimeline`: no overlaps on exclusive tracks, frame-aligned, inside the timeline, unique IDs, scenes tile
  the timeline exactly.
- JSON stores rationals as `{"$r": "n/d"}`.
- `fromLegacyTimeline`: v2 `timeline.json` → v3, frame-identical (uses v2's integer frames).

### `product.types.ts`
`ProductIdentity`, `ProductRecord` (moved here from `productResearch.ts`), `ProductSpec`,
`SpecVisualTag` (spec + spoken keywords + visual idea + `diagramFallback`), `ActiveSubject`
(product + spec + confidence + reason: named / section / nearest / none), `productKey()`.

---

## Phase 1 — Pacing, active subject, CLIP profiles, Shorts

### 1a. Auto-Editor style pacing → `src/lib/engine/pacing/autoEditor.ts`
How it works (auto-editor's idea, re-implemented):
1. FFmpeg decodes the voice to 8 kHz mono; `frameLevels` takes the **loudest sample per video frame** (0..1).
2. `silentRanges`: frames under the threshold (0.04) are silent; short blips and silences under 0.15 s are ignored.
   For *cut points* the margin is 0.05 s. auto-editor's 0.2 s margin swallowed a real 0.4 s pause in testing.
3. `microCuts` slices each scene into **2.5–4 s pieces**:
   - first it picks how many pieces fit the range, closest to 3.2 s;
   - then it places each cut in the window that keeps the rest feasible, preferring the middle of a pause
     (score 3), then a word after a sentence end (2), then any word start (1).
   - Lengths that can't fit (4.0–5.0 s) take the piece count that misses the range by less.
4. `sliceScene` snaps the cuts to frames (rational, cumulative).

Result: `micro_scenes.json`, written by the plan step when the niche opts in (`pacing.micro`, on in
`tech-amazon`; `MICRO_SCENES=on/off` overrides). The pacing engine (`pacing.ts`) uses these boundaries as its cuts.
Scenes and cards stay as they were.

### 1b. Active subject + spec tags → `src/lib/planner/activeSubject.ts`
- `SPEC_LEXICON`: ~24 filmable specs (brushless motor, battery, deck, blades, height adjustment, display, camera,
  ports, trigger, chuck…). Internal ones (battery chemistry, voltage, cooling, ANC) are marked `diagramFallback`.
- `detectSpecs(text)`: longest phrase wins ("brushless motor" over "motor"), in spoken order.
- `lockSubject(text, sectionProduct, products)`: a line naming a model wins (`named`, 0.95); otherwise the listicle
  section's product (`section`, 0.7); otherwise `none`.
- In pacing, a line about a spec prefers vault shots cut around **that spoken spec** (+1.5 score).

### 1c. CLIP scorer → `src/lib/agents/vision/clipScorer.ts`
- Moved out of the extractor. Score = **best positive prompt − worst negative prompt**.
- Negatives in every profile: talking to camera, presenter in a shop, face close-up, cartoon logo, title card.
- Profiles:
  - **machine** (strict): one "machine in action" prompt, for walkaround B-roll.
  - **handson** (relaxed): adds "close-up" and "detail of a part" positives, for gadget and keyword clips.
- **Measured on real frames:** my first relaxed version *dropped* a negative and let a dealer talking to camera and
  a cartoon logo through. The final version keeps all negatives: 6/6 bad frames rejected, 6/6 good kept, and the
  gloved-hand blade close-up went from a +0.016 margin to +0.055.

### 1d. Shorts → `src/lib/engine/filters/lavfiBuilder.ts`
- `fitGraph`: `cover` (crop), `contain` (letterbox), `blur_pad` (OpenShorts technique in reverse: a blurred,
  darkened copy fills 16:9 behind the whole vertical picture).
- `chooseFit` keeps 16:9-ish sources (within 15 %) as `cover`; anything else → `blur_pad`.
- The extractor now accepts YouTube **Shorts of 15–60 s** (`HARVEST_SHORTS`; normal videos keep the 45 s minimum),
  downloads them vertically and converts each window to 1920×1080 before cutting shots. A converted Short gives no
  full-screen still, because its real detail is only the narrow centre.

### 1e. Caption-sliced clips → `src/lib/agents/youtube/ytExtractor.ts`
- `yt_extract.py captions`: the uploader's English subtitles first, then YouTube auto-captions (`json3`, else `vtt`).
- `parseJson3`: auto-captions carry **per-word times** (`tStartMs` + `tOffsetMs`). `parseVtt` handles inline word
  times and drops YouTube's repeated rolling lines.
- `findKeywordMoments` → `keywordWindow`: starts 0.5 s before the word, 3–5 s long.
- `harvestKeyword` downloads **only those windows**.
- Live: "blades" on Honda HRX217 → 3 videos, 8–14 mentions each, 6 clips kept, including a correct blade close-up.

---

## Phase 2 — Zero-friction fallbacks

### 2a. Generic stock stays off
Pexels / Pixabay / Unsplash / Wikimedia / Archive are never searched unless `GENERIC_STOCK=on` (done earlier;
still true).

### 2b. Typo-tolerant names → `src/lib/agents/youtube/fuzzyMatcher.ts`
Rule: **letters may be misspelled, numbers never.**
- Damerau-Levenshtein edit distance. Budget: ≤4 letters → 0 edits ("deck" ≠ "desk"); 5–7 → 1; 8+ → 2.
- The first letter must match ("motor" ≠ "rotor"). Digits must be identical ("LM2135" ≠ "LM2153").
- Roman numerals, variant words (Pro/Max/Plus…) and numbered tokens must match exactly, as numbers:
  II = 2 = "ll", but never 3 ("Turf Tiger III" ≠ "Turf Tiger II").
- `suggestSpelling`: the spelling most search titles agree on replaces a typo (digits never change).
- Used in four places:
  - the title filter (exact first, then fuzzy);
  - a re-search with the corrected spelling when fewer than 2 videos are found;
  - caption keyword matching (ASR "brushles" = "brushless");
  - vault lookup.
- **Live:** "Turf Tigre II" → the exact filter found 0, the fuzzy filter 12, and titles corrected it to
  "Turf Tiger II". That run also exposed "Tiger 2" and "Tiger ll", which led to the numeral rule.

### 2c. Auto-fetch on demand → `src/lib/agents/autoFetch.ts`
At the start of the assets step (replacing the older inline auto-harvest loop):
1. `planFetches` (pure) lists what's missing:
   - a product with no vault, or fewer than 6 clips (`AUTO_FETCH_MIN_CLIPS`);
   - each spec from `micro_scenes.json` with no clip cut around it.
2. `ensureFootage` logs `pausing assets…`, then runs model harvests, then caption-keyword harvests, then logs
   `resuming…`.
3. An internal spec (`diagramFallback`) that still has no real footage → **diagram** (2d).
4. It writes `auto_fetch.json` and `diagrams.json`. Diagrams join the product pool as verified shots tagged with
   their spec.
- Each fetch is independent: one failure is logged and the rest continue. `AUTO_FETCH=off` disables it.

### 2d. Diagram agent → `src/lib/agents/generative/manimAgent.ts`
Agentic loop after Code2Video:
1. Claude (`MANIM_MODEL`, default `claude-opus-5-5`, structured output, server-side refusal fallback) plans and
   writes one Manim scene. It may use **only facts from the narration**.
2. **Safety screen** before running model-written Python:
   - only `manim` / `math` / `numpy` / `random` imports;
   - no file, OS, network, eval/exec or dunder access, and no LaTeX;
   - runs in a temp folder with a time limit.
3. Manim renders 1080p30. On a failure, the **exact error goes back to Claude** for a fix (up to 3 attempts).
4. No Manim, no API key, or all attempts failed → an **FFmpeg template diagram** (known flows such as
   "Lithium-ion cells → Battery management → Motor"). The pipeline never stops.
- Manim 0.19.0 is installed into `.venv` and listed in `python/requirements.txt`.
- **Live:** a clean 5 s diagram for "battery chemistry" on the EGO LM2135SP, first attempt, ~28 s. It used only
  "56 V lithium-ion", "brushless motor" and "gas-like power, no fumes" from the narration.

---

## Phase 3 — Multi-track rational timeline + incremental render (`src/lib/compiler/`)

### `timelineCompiler.ts`
- `loadTimeline(dir)`:
  - `timeline.v3.json` is the source of truth.
  - With only `timeline.json`, it migrates on the fly.
  - If `timeline.json` was **edited later** (simple-UI swaps, hand edits), it rebuilds the v3 file from it and keeps
    the scene text and subjects (`v2-synced`).
- `compileTimeline`: validates, requires 30 fps (the filter graphs are built for 30), and produces one render job
  per scene: frame-exact start and length, B-roll shots or the single picture, overlays (delay / out / alpha-video
  cards), SFX, transition, backdrop. Plus the audio plan (voice, music bed and gain, SFX events) and captions / logo.
- `limitFrames` for `render --limit` previews.

### `incrementalCache.ts`
- SHA-256 per scene over everything that changes its pixels: audio slice, asset files (path + size + mtime),
  captions, overlays and their files, transition, motion, backdrop, logo, frame count.
- `SegmentCache`: `cache/segments/seg_<scene>_<hash>.mp4` with methods `invalidate` (force / `--scene`),
  `changed`, and `commit` (writes the manifest and prunes old versions).

### `concatDemuxer.ts`
- The concat list carries an **exact duration per segment** from its frame count (rational). Without it the
  demuxer drifts about one frame per scene.
- Stream copy when all segments share one encoder; one re-encode when NVENC and x264 segments are mixed.
- The final `-t` is the exact cut length, not a float sum.
- Verified at 29.97: 600 × 77 frames = exactly 1541.54 s, while summed rounded floats drift.

### Render and timeline steps
- `render.ts` now loads → compiles → hashes → renders only missing segments → stitches → mixes audio. The segment
  filter graphs (Ken Burns, product showcase, sub-shots, cards, logo, captions) are unchanged.
- The timeline step also writes `timeline.v3.json` with each scene's narration and the subject the micro plan
  locked.
- **Live:** a real project preview (`ccw-today` copy, 20 s) rendered through the v3 path: 600/600 frames, A/V diff
  0 s, blur backdrop and cards intact.

---

## Phase 4 — Block editor (CapCut-style)

### `src/server/state/projectStore.ts`
- The active v3 timeline per project, with a **revision** number and **undo / redo** (50 steps).
- Edit operations (frame-snapped):

| Op | Pictures (B-roll) | Overlays / SFX |
|---|---|---|
| `trimEnd` | moves the **cut between two pictures**; the next picture keeps showing the same moment (its in-point moves with the cut) | trims the end |
| `moveClip` | refused (pictures tile the scene) | moves; the overlay joins the scene it lands in |
| `splitClip` | two pictures; the second continues the source | two blocks (animated cards can't be split) |
| `deleteClip` | the neighbour takes over the time; the last picture of a scene can't be deleted | removed |
| `setLocked` | locked blocks refuse edits | same |
| `replaceMedia` | **server-only** (via `editor.replace`) | — |

- **Atomic and validated:** every batch of edits runs on a copy. It's checked against the timeline rules plus
  "every scene stays fully covered by pictures", and only then saved to `timeline.v3.json`. A rejected edit
  changes nothing (state and file both untouched).
- **Optimistic concurrency:** an edit names its `baseRevision`, and a stale one gets a conflict, so two tabs can't
  overwrite each other. An outside change to the file is picked up.
- It tracks which scenes were edited since the last render.

### `src/server/routes/editorAPI.ts` — JSON-RPC 2.0 on `POST /api/editor`

| Method | What it does |
|---|---|
| `editor.open` | block view: tracks of blocks (frames, label, source, keyword, verified, thumbnail), scenes (text, subject), revision, undo/redo, edited scenes |
| `editor.edit` | `{baseRevision, ops[]}`, only `moveClip`/`trimEnd`/`splitClip`/`deleteClip`/`setLocked` |
| `editor.undo` / `editor.redo` | with `baseRevision` |
| `editor.candidates` | vault clips of the clip's scene product: unused first, then the spoken spec, then videos, then CLIP score |
| `editor.replace` | swaps in a candidate **by ID** (never a client file path) |
| `editor.fetchNewClip` + `editor.job` | **hot-swap from YouTube**: reads the scene's product + spec (or your keyword), harvests (keyword or model), picks the best **new unused** clip, swaps it in, returns a job log |
| `editor.render` | starts an incremental render; only edited scenes re-render |

- Error codes: −32700 parse, −32600 invalid request, −32601 unknown method, −32602 bad params,
  −32000 edit rejected, −32001 conflict, −32002 not found, −32003 pipeline busy. Batches and notifications are
  supported.
- `GET /api/editor/thumb` gives block thumbnails (FFmpeg frame at the clip's in-point, cached).

### `web/editor.html` + `editor.js` + `editor.css`
- Reached from the project view: **✂ Open editor**.
- **Layout:** top bar (undo, redo, zoom, play, time, Render changes), a preview of the selected block, an inspector,
  then the ruler, scene row (edited scenes highlighted) and track rows.
- **Mouse:** drag a picture's right edge to move a cut; drag or trim overlays and SFX; click the ruler to set the
  playhead.
- **Keys:** **S** split, **Delete**, Ctrl+Z / Ctrl+Y, Space play.
- **Inspector:** details, Split, Delete, Lock, **Show vault clips**, **Fetch new clip** (live job log).
- **Live check** on a real 35-scene project copy: 99 blocks loaded, thumbnails served, a real edge drag saved as
  revision 2 with scene #0 marked edited, and Ctrl+Z restored it. That check found a keyboard bug (shortcut dead
  when nothing had focus), which is fixed.

---

## Bugs found by testing (and fixed)

| Where | Bug |
|---|---|
| fuzzy titles | "Turf Tiger III" passed for "Turf Tiger II" through the spacing fallback → variant tokens must be exact |
| Manim safety screen | an import regex spanning lines rejected every valid script (every diagram would have silently been a template) |
| Manim coder | inherited `LLM_MODEL=claude-haiku-4-5`, which rejects `effort` → its own `MANIM_MODEL`; effort / fallbacks only on models that support them |
| micro slicing | the greedy cut left 4.6 s tails → two 2.3 s pieces → the piece count is chosen first |
| pause detection | auto-editor's 0.2 s margin swallowed 0.4 s pauses → 0.05 s for cut points |
| CLIP relaxed profile | dropping a negative let a talking dealer and a logo through → keep all negatives, add positives |
| keyword match | the plural rule accepted the typo "brushles"; hyphenated "brush-less" didn't match |
| title filter | `21"` (deck size) was read as another model number |
| v2 → v3 | simple-UI swaps edit `timeline.json` → render would use a stale v3 file → sync rule |
| editor keys | Ctrl+Z / S / Delete died when the event target was the document |

---

## Tests (`npm test`, 104)

| File | Covers |
|---|---|
| `tests/domain.test.ts` | rational math (exactness, 29.97, no drift), v3 validation, JSON round-trip, v2 → v3 migration |
| `tests/ytCaptions.test.ts` | json3 / vtt parsing, keyword moments, 3–5 s windows |
| `tests/engine.test.ts` | silence math, micro slicing (also real FFmpeg audio with pauses), spec / subject, CLIP profiles on measured scores, Shorts filter, real 9:16 → 16:9 |
| `tests/agents.test.ts` | fuzzy matching, auto-fetch plan + orchestration, Manim safety screen, template render, **real Manim repair loop** (unsafe → crash → render) |
| `tests/compiler.test.ts` | v3 → jobs round-trip, previews, 29.97 concat, sync rules, **real render from an edited v3 file re-rendering one scene** |
| `tests/editor.test.ts` | store ops / atomicity / conflicts / undo / locks, JSON-RPC protocol, path-injection block, candidates / replace, Fetch New Clip hot-swap |
| `tests/pipeline.test.ts` | the earlier phases (TTS, discrepancies, ledger, QA gate, incremental render) |

---

## Limits and risks

1. **Copyright:** vault clips are other channels' videos (logged in `licenses.json`; QA warns). Ask for permission
   or replace.
2. **CLIP is a heuristic:** good on the frames measured, but margins are a few hundredths. Glance at vaults.
3. **Title ≠ content:** a correctly titled video can still show another model.
4. **Render is 30 fps only.** The model supports 29.97, but the filter graphs are built for 30.
5. **HUD tracking** (ff-tracking) has a slot in the model (`OverlayClip.tracking`) but no tracker yet.
6. **Editor:** no adding new overlays or clips yet; the editor's undo history is in memory (lost on server restart;
   the saved file stays).
7. **Pool shots aren't in `licenses.json`:** the ledger records each scene's main asset, not every pacing sub-shot.
8. **Not run end to end:** a full tech-amazon project (micro plan + auto-fetch + diagrams + v3 render) has not been
   run as one job.
9. **Nothing is committed.**
