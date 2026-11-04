# Testing ClipForge on your PC (Windows, RTX 3070 Ti 8 GB)

The script engine v3 work is on the branch **`feature/script-engine-v3`** (made from
`feature/full-pipeline-v2-cwi1sx`). Commands are for **PowerShell**, in the ClipForge folder
(`D:\YT_CODE_Base\clipforge`). PowerShell blocks `npm.ps1`, so type **`npm.cmd`**, not `npm`.

```powershell
git fetch origin
git checkout -b feature/script-engine-v3 origin/feature/script-engine-v3
npm.cmd install
```

---

## 0. What must be installed once

| Tool | Check | Install |
|---|---|---|
| Git | `git --version` | git-scm.com |
| Node.js 20 or newer | `node -v` | nodejs.org (LTS) |
| Python 3.11 | `python --version` | python.org |
| FFmpeg | `ffmpeg -version` | `winget install Gyan.FFmpeg` (then open a new PowerShell) |
| Ollama | `ollama --version` | ollama.com |
| NVIDIA driver | `nvidia-smi` | nvidia.com |

---

## 1. Get the branch

`src/lib/models/loader.ts` and `embed.ts` are committed now (`f62c09f`), so a fresh checkout builds.

```powershell
cd D:\YT_CODE_Base\clipforge
git status                         # must show no unsaved changes; else commit or stash them first
git fetch origin
git checkout -b feature/script-engine-v3 origin/feature/script-engine-v3
# (if that branch already exists locally:  git checkout feature/script-engine-v3 ; git pull)
```

---

## 2. Install the packages

```powershell
npm.cmd install
npm.cmd --prefix cards install          # the Remotion cards and the preview player

python -m venv .venv
.venv\Scripts\pip install -r python\requirements.txt
.venv\Scripts\pip install -U kokoro-onnx soundfile
```

---

## 3. Models (one time)

**Ollama** (the local AI). It has to be running: start "Ollama" from the Start menu.

```powershell
ollama pull qwen3:8b            # script, titles, niche
ollama pull qwen2.5:7b          # plan, labels, chat
ollama pull nomic-embed-text    # originality check
ollama pull qwen2.5vl:3b        # picture checks; 3b fits 8 GB better than the default 7b
```

If you use `qwen2.5vl:3b`, set it as the vision model on the Classic page > Settings > AI.

**Whisper** (subtitles and timing, about 1.6 GB):

```powershell
npm.cmd run cf -- fetch-model
```

**Kokoro voice.** Download both files into `models\kokoro\` (the links are from the kokoro-onnx
GitHub page; the model is Apache-2.0):

```powershell
New-Item -ItemType Directory -Force models\kokoro | Out-Null
curl.exe -L -o models\kokoro\kokoro-v1.0.onnx https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/kokoro-v1.0.onnx
curl.exe -L -o models\kokoro\voices-v1.0.bin https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.1/voices-v1.0.bin
```

---

## 4. `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

Set at least these:

```
TTS_PROVIDER=kokoro
KOKORO_PYTHON=D:\YT_CODE_Base\clipforge\.venv\Scripts\python.exe
```

Optional:
- `PEXELS_API_KEY`, `PIXABAY_API_KEY`: free stock footage (documentaries need them).
- `YOUTUBE_API_KEY`: the Research page.
- `ANTHROPIC_API_KEY`: API mode.
- `GEMINI_API_KEY`, `RUNWAYML_API_SECRET`: paid AI scenes.
- German voice: put `de_DE-thorsten-high.onnx` and its `.onnx.json` in `models\piper\`, then set
  `PIPER_MODEL_DE=D:\YT_CODE_Base\clipforge\models\piper\de_DE-thorsten-high.onnx` and `PIPER_PATH`
  (the piper.exe).

Never paste keys into a chat.

---

## 5. Check the install

```powershell
npm.cmd run typecheck              # must say nothing (no errors)
npm.cmd test                       # expected on this branch: 481 tests, 0 fail, 1 skipped
npm.cmd run doctor                 # Python, FFmpeg, NVENC, GPU, RAM, disk, .env
```

If typecheck complains about `@google/genai` or `@runwayml/sdk`, run `npm.cmd install`. Since
v3 they are optional: a missing package only stops the paid Veo / Gemini / Runway calls.

---

## 6. Start the app

```powershell
npm.cmd run serve
```

Open **http://localhost:4173/new**. At the top, set the **AI engine to Local** (Ollama must show ✓).

Keep a second PowerShell open with this, to watch the GPU during a run:

```powershell
ollama ps            # the PROCESSOR column must say 100% GPU
```

---

## 7. Tests, easy to hard (do them in this order)

Make each test short (about 5 minutes of video), so a problem shows up fast.

| # | Test | Where | What to check |
|---|---|---|---|
| 1 | **Ranked products** (3 products) | /new | `ollama ps` 100% GPU; voice plays; footage fits; QA shows the new checks (First frame, Caption size, Caption contrast) |
| 2 | **Documentary** (a topic Wikipedia covers, 5 min) | /make > Documentary | Claim table: open 2 "verified" sources and check them by hand; the "taken out" list makes sense |
| 3 | **Editor**: swap one scene | Classic > My videos > the video | "Make it with AI" > a real product photo > Write the prompt > Google Flow route |
| 4 | **German version** of test 1 | /new, step 3, "Another language" | needs the German Piper voice from step 4 |
| 5 | **Explainer** | /make > Explainer | needs explainroo: `git clone https://github.com/vincentsch/explainroo`, then in it `npm.cmd install` and `node bin/explainroo.js doctor --fetch`; in Tools > Video types set explainroo to the path of `bin\explainroo.js` |
| 6 | **Tutorial** (a 1-2 minute screen recording) | /make > Tutorial | needs argo: `npm.cmd install -g @argo-video/cli` |
| 7 | **earshot** sound check | Tools > Sound check: enabled = true | `.venv\Scripts\pip install earshot`, then `earshot doctor --fetch`; render + QA a video |
| 8 | **Product cutout** | Tools > Product photos: cutout = true | `.venv\Scripts\pip install "rembg[cpu]"`; a video with press-kit photos |
| 9 | **Shorts from a long video** (your own 20-60 min podcast or vlog) | /make > Shorts from a long video | Run `.venv\Scripts\pip install -r python\requirements.txt` again first (OpenCV is pinned below 5). Check whether the picks are good moments. Check that "Follow the speaker's face" keeps the face in frame; the meta line under each Short says when it fell back to "fit". |

---

## 8. When something fails, send me

1. Which test and which step (Voice, Footage, Render ...).
2. `workspace\<video name>\run.log`: the whole history of that video.
3. `workspace\<video name>\qa_report.json` (if the video was made).
4. A screenshot of the error box on the page.
5. For GPU problems: the output of `ollama ps` and `nvidia-smi` during the run.

---

## 9. Script engine v3: the 5-minute test

The idea: copy a winning channel's **structure**, never its words, and write in **your** channel's
voice. Run these in order (Ollama running, `ollama pull qwen3:8b`, `nomic-embed-text` and
`qwen2.5vl:3b` done).

| # | Step | Command / page | What to check |
|---|---|---|---|
| 1 | Channel brief | `npm.cmd run cf -- channel show survival-pulse` (seeded), or `/brief` | the voice, banned phrases, 8 min at 160 wpm = 1280 words |
| 2 | Competitor SOP from 5 transcripts | `npm.cmd run cf -- sop build --channel survival-pulse --competitor UCxxxxxxxxxxxxxxxxxxxxxx --videos 5` (needs `YOUTUBE_API_KEY`) **or** with a folder of 5 `.txt` transcripts: `--competitor D:\transcripts\rival` | `channels\survival-pulse\sop\<id>.json`: hook formula, beats with %, rules. The last line says "copied words stripped" and the 5-gram overlap must be 0. Read the rules: are they techniques, not their sentences? |
| 3 | Ideas from an outlier | `/research` > Scan > an outlier's **Ideas** > Survival Pulse > Find 15 ideas (or `npm.cmd run cf -- ideas --channel survival-pulse --from <videoId>`) | "Why it worked", 15 ideas, the "dropped as too similar" line; with `YOUTUBE_API_KEY`, viewer questions from the comments are used |
| 4 | Script with retention QA | Ideas > **Use ->** opens `/new` pre-filled (title, channel, format); add the products / items and write the script. CLI: `npm.cmd run cf -- script -p test-v3 -t "budget knives" --products "A,B,C" --channel survival-pulse` | `workspace\<video>\script_report.json`: `retention.status` (pass / warn / fail and the problems), `beats` (hook, promise, re-hooks, loops), `selfRepetition`, `channel.bannedFound` = [] |
| 5 | Render | finish the wizard (voice > footage > render) | the QA page shows **Script > Retention beats** and **Originality > Not repeating our own videos**; step 6 has **Make 3 thumbnail concepts** |

Also worth one try each:
- Another format: on `/new` step 2 pick **Versus** (2 items), **Myth vs reality**, **History of** or
  **Every X explained**. For myths and history chapters, check the footage by hand (see
  PHASE_LOG S5 limits).
- A second video on the same topic for the same channel: its script report should show
  `selfRepetition.checkedAgainst` = 1 or more.
- `npm.cmd run cf -- thumbnails -p <video>` after a research scan: it should say "N competitor
  thumbnail(s) studied" (needs `qwen2.5vl:3b`).

Send me `script_report.json`, the SOP json and `run.log` if anything looks off, especially when
the retention check and your own ear disagree.

