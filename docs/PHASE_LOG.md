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

## Blocked / needs user

- **Phase 0 hardware check**: run one full video on the RTX 3070 Ti and confirm `ollama ps` shows
  100% GPU, that there are no `GPU returned garbage twice` lines, that `[vision] verified` > 0 and
  that `pacing_stats.json` `forcedReuse` < 20.
