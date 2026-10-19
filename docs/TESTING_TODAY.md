# How to test today's work

Branch: `feature/general-web-crawler`. Every check below says what to run and which log line
proves it worked. Do them in order: setup first, then the automated tests, then one real video.

## 0. Setup (once)

```
git pull origin feature/general-web-crawler
npm ci
cd cards && npm ci && cd ..
.venv\Scripts\python.exe -m pip install -r python\requirements.txt      (Windows)
```

**Know these before your first run:**
- **Full re-render once.** The first render after the update re-renders every scene: the render-cache
  format changed and captions now use the bundled Inter font. After that, renders are incremental again.
- **Full re-plan once.** The first plan after the update asks the LLM for everything, because its caches
  start empty. After that, only edited parts are sent.
- **Cards look different.** They now use the bundled fonts. Oswald titles show as Anton and other text as
  Inter, where they used to be Arial on Windows. Put Oswald-Bold.ttf in `assets/fonts/` to get Oswald back.
- **TTS may switch provider.** If `TTS_PROVIDER` is empty and your `.env` has `OPENAI_API_KEY`,
  script-only videos now use OpenAI TTS, which costs money. Set `TTS_PROVIDER=windows` to keep the free voice.

## 1. Automated tests (2-3 minutes)

```
npm test           # TypeScript: 197 tests, expect "fail 0"
npm run test:py    # Python crawler tests, expect "OK"
npm run typecheck
```
The queue tests need `redis-server` installed; without it they are skipped, not failed.

## 2. One real video: what each feature prints in the log

Use an old project you know. Press Go, or run the steps with `npx tsx src/cli.ts <step> --project NAME`.

| Feature | Where to look | What proves it works |
|---|---|---|
| 2-4 s random shots, no clip repeats | `[pacing]` lines, QA report | `avg 2.x s` between 2 and 4; QA "No clip moment shown twice" = pass |
| Intro / outro found from the script | `[plan]` | `[plan] hook ends 4.4s, outro from 512.0s (llm)` |
| Hook teaser + HookTitle card | `[pacing]`, `[timeline]` | `hook teaser: 6 fast shot(s) in the first 4.4 s`, `hook title: 1 scene(s)` |
| Intro / outro footage follows the words | `[pacing]` | `intro/outro: N shot(s) show the product the narration names` |
| No "Top Picks" / "See you next time" cards | the video | first and last scenes are footage |
| Comment / subscribe lines get matching B-roll | `[assets]` | `scene 41: "comment" line -> hands typing on smartphone` (only with `GENERIC_STOCK=on`) |

Preview the HookTitle animation on its own: `cd cards && npx remotion studio`, then open **HookTitle**.

## 3. Delta rendering: edit one sentence, the rest is reused

Use a **script-only (Mode B)** project:
1. Make the video once.
2. Change **one sentence** in its `script.txt` and run again.
3. Check these lines:
   - `[tts] 40 sentence(s): 39 from cache, 1 synthesized`. Only one TTS request was made.
   - `[transcribe] Mode B: ... Whisper skipped`
   - `[plan] labels: 7/8 section(s) unchanged (cached)`. Only one LLM batch.
   - `[pacing] shot locks: N sub-shot(s) kept from the last run`
   - `[render] 120 segments (110 reused from cache)`. Only the scenes around the edit re-render.

## 4. Redis queue (optional; the app still works without it)

```
docker compose up -d redis
# add to .env:  REDIS_URL=redis://localhost:6379
npm run serve
```
- **Startup log:** `[queue] BullMQ on redis://localhost:6379: working on plan, sourcing, render`
- **Restart test:** start a video, stop the server (Ctrl+C), start it again. The log page still shows
  the old log lines, and the queued work continues.
- **Separate worker:** set `QUEUE_WORKERS=plan,sourcing` in `.env` and restart the server. In a
  second terminal run `npx tsx src/cli.ts worker --stages render`. Renders now happen in that window.
- **Rate limiter:** add `RATE_LIMITS=pexels=2/60` and run the assets step. You should see
  `[rate-limit] pexels: budget used up, waiting 5x s`. Remove the line afterwards.

To go back to the old local queue: empty `REDIS_URL`.

## 5. GPU fallback

- **On your laptop (with GPU):** the render log has no "NVENC not usable" line, and `render_report.json`
  shows `x264Fallbacks: 0`.
- **Forcing the CPU path:** `VIDEO_ENCODER=libx264`, or render on a machine without an NVIDIA GPU.
  The log shows
  `[render] NVENC not usable on this machine (...); encoding with libx264 (CPU)` and the video still renders.

## 6. Linux / Docker

```
docker compose up -d --build                 # Redis + web app + a render worker
# open http://localhost:4173
docker compose exec app node node_modules/tsx/dist/cli.mjs src/cli.ts doctor
docker compose logs -f render-worker
```
Behind a company proxy that inspects TLS: `docker build --secret id=ca_bundle,src=ca.pem .`.

**Docker limits:**
- **No Remotion on a plain build.** `WITH_REMOTION=1` (the default) needs Debian's apt for Chromium's
  libraries. With `WITH_REMOTION=0` the animated cards fall back to static PNGs.
- **No GPU by default.** The image's FFmpeg has no NVENC; renders use the CPU. A GPU host needs an
  NVENC FFmpeg image (`FFMPEG_IMAGE=`), `WITH_CUDA=1` and `--gpus all`.
- **Text-to-speech in Docker:** set `ELEVENLABS_*` / `OPENAI_API_KEY`, or mount a Piper voice and set `PIPER_MODEL`.
