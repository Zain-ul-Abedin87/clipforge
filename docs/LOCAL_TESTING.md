# Testing ClipForge on your PC (Windows, RTX 3070 Ti 8 GB)

All work is on the branch **`feature/full-pipeline-v2-cwi1sx`**. Commands are for **PowerShell**,
in the ClipForge folder (`D:\YT_CODE_Base\clipforge`).

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

## 1. Get the branch, and commit the two missing files first

`src/lib/models/loader.ts` and `src/lib/models/embed.ts` exist only on your PC. An old `.gitignore`
rule hid them. Without them the branch does not build for anyone.

```powershell
cd D:\YT_CODE_Base\clipforge
git status                         # must show no unsaved changes; else commit or stash them first

# backup of the two files, just in case
New-Item -ItemType Directory -Force D:\clipforge_backup | Out-Null
Copy-Item src\lib\models\*.ts D:\clipforge_backup\

git fetch origin
git checkout -b feature/full-pipeline-v2-cwi1sx origin/feature/full-pipeline-v2-cwi1sx
# (if that branch already exists locally:  git checkout feature/full-pipeline-v2-cwi1sx ; git pull)

Test-Path src\lib\models\loader.ts # must print True (the files stay in the folder when you switch)
git add src/lib/models
git commit -m "Add model loader and embed modules (were hidden by .gitignore)"
git push
```

---

## 2. Install the packages

```powershell
npm install
npm --prefix cards install          # the Remotion cards and the preview player

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
npm run cf -- fetch-model
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
npm run typecheck                  # must say nothing (no errors)
npm test                           # expected: 0 fail, 1 skipped
npm run doctor                     # Python, FFmpeg, NVENC, GPU, RAM, disk, .env
```

`npm test` here (in the cloud) had 6 failures, all from stand-ins for the two `models` files. With
your real files, the model-loader tests decide whether they pass: if any fail, send me the output.

---

## 6. Start the app

```powershell
npm run serve
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
| 5 | **Explainer** | /make > Explainer | needs explainroo: `git clone https://github.com/vincentsch/explainroo`, then in it `npm install` and `node bin/explainroo.js doctor --fetch`; in Tools > Video types set explainroo to the path of `bin\explainroo.js` |
| 6 | **Tutorial** (a 1-2 minute screen recording) | /make > Tutorial | needs argo: `npm install -g @argo-video/cli` |
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
