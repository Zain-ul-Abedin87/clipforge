"""Exact-model YouTube extractor helper for ClipForge (src/lib/assets/ytExtractor.ts).

One request per process: JSON on stdin, one JSON line on stdout.

  python yt_extract.py search   {"queries": ["Honda HRX217 walkaround", ...], "limit": 10}
      -> {"ok": true, "results": [{"id", "url", "title", "duration", "channel", "channel_url", "query"}]}
  python yt_extract.py info     {"url": "https://www.youtube.com/watch?v=..."}
      -> {"ok": true, "title", "duration", "channel", "chapters": [{"start", "end", "title"}], "description"}
  python yt_extract.py captions {"url": "..."}
      -> {"ok": true, "kind": "manual" | "auto", "lang", "ext": "json3" | "vtt", "data": "<raw caption file>", "duration"}
  python yt_extract.py transcript {"url"}
      -> {"ok": true, "kind": "manual" | "auto", "lang", "segments": [{"text", "start", "duration"}]}
         youtube-transcript-api: one quick request, line-level timing (used to screen videos fast).
  python yt_extract.py whisper_words {"url", "model", "models_dir", "device", "prompt", "max_seconds", "ffmpeg"}
      -> {"ok": true, "words": [{"text", "t"}], "duration", "device"}
         For videos without captions: downloads the audio only and transcribes it with faster-whisper.
  python yt_extract.py fetch    {"url", "start", "seconds", "out", "ffmpeg", "max_height": 1080}
      -> same reply as web_crawl.py fetch: downloads ONLY that window (yt-dlp download sections),
         video only, re-encoded to H.264 mp4. 403 retries / cookies / proxy / PO tokens are shared
         with web_crawl.py.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import web_crawl  # noqa: E402  (patches yt_dlp.YoutubeDL with cookies / PO-token / pacing options)
from youtube_cc import base_opts  # noqa: E402

yt_dlp = web_crawl.yt_dlp


def search(req: dict) -> dict:
    limit = max(1, min(int(req.get("limit", 10)), 25))
    seen: dict[str, dict] = {}
    errors: list[str] = []
    opts = {**base_opts(), **web_crawl.js_opts(), "extract_flat": "in_playlist", "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        for q in req.get("queries", []):
            try:
                info = ydl.extract_info(f"ytsearch{limit}:{q}", download=False) or {}
            except Exception as e:  # noqa: BLE001
                errors.append(f"{q}: {str(e)[-120:]}")
                continue
            for e in info.get("entries") or []:
                if not e or not e.get("id") or e["id"] in seen:
                    continue
                seen[e["id"]] = {
                    "id": e["id"],
                    "url": e.get("url") if str(e.get("url", "")).startswith("http") else f"https://www.youtube.com/watch?v={e['id']}",
                    "title": e.get("title") or "",
                    "duration": float(e.get("duration") or 0),
                    "channel": e.get("channel") or e.get("uploader") or "",
                    "channel_url": e.get("channel_url") or e.get("uploader_url") or "",
                    "query": q,
                }
    return {"ok": True, "results": list(seen.values()), "errors": errors}


def info(req: dict) -> dict:
    opts = {**base_opts(), **web_crawl.js_opts(), "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        i = ydl.extract_info(req["url"], download=False) or {}
    return {
        "ok": True,
        "title": i.get("title") or "",
        "duration": float(i.get("duration") or 0),
        "channel": i.get("channel") or i.get("uploader") or "",
        "channel_url": i.get("channel_url") or i.get("uploader_url") or "",
        "width": i.get("width") or 0,
        "height": i.get("height") or 0,
        "chapters": [
            {"start": float(c.get("start_time") or 0), "end": float(c.get("end_time") or 0), "title": c.get("title") or ""}
            for c in (i.get("chapters") or [])
        ],
        "description": (i.get("description") or "")[:2000],
    }


def captions(req: dict) -> dict:
    """English captions of one video: uploader's own subtitles first, then YouTube's automatic ones.
    json3 (word-level timing in auto captions) is preferred, vtt is the fallback. Returns the raw text."""
    wanted = [l for l in req.get("langs", ["en", "en-US", "en-GB", "en-orig"]) if l]
    opts = {**base_opts(), **web_crawl.js_opts(), "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        i = ydl.extract_info(req["url"], download=False) or {}
        for kind, table in (("manual", i.get("subtitles") or {}), ("auto", i.get("automatic_captions") or {})):
            langs = wanted + sorted(l for l in table if l.lower().startswith("en") and l not in wanted)
            for lang in langs:
                tracks = table.get(lang) or []
                for ext in ("json3", "vtt"):
                    t = next((x for x in tracks if x.get("ext") == ext and x.get("url")), None)
                    if not t:
                        continue
                    data = ydl.urlopen(t["url"]).read().decode("utf-8", "replace")
                    return {"ok": True, "kind": kind, "lang": lang, "ext": ext, "data": data,
                            "duration": float(i.get("duration") or 0), "title": i.get("title") or ""}
    return {"ok": False, "error": "no English captions on this video"}


def _video_id(url: str) -> str:
    import re

    m = re.search(r"(?:v=|youtu\.be/|shorts/)([A-Za-z0-9_-]{11})", url)
    return m.group(1) if m else url


def transcript(req: dict) -> dict:
    """youtube-transcript-api: the video's English transcript in one request (no yt-dlp page load).
    Line-level timing only, so it screens videos fast; exact word times come from captions / Whisper."""
    try:
        from youtube_transcript_api import YouTubeTranscriptApi
    except ImportError:
        return {"ok": False, "error": "youtube-transcript-api is not installed (pip install -r python/requirements.txt)"}
    import os

    proxy = os.environ.get("YTDLP_PROXY", "").strip()
    kwargs = {}
    if proxy:
        from youtube_transcript_api.proxies import GenericProxyConfig

        kwargs["proxy_config"] = GenericProxyConfig(http_url=proxy, https_url=proxy)
    api = YouTubeTranscriptApi(**kwargs)
    langs = [l for l in req.get("langs", ["en", "en-US", "en-GB"]) if l]
    listing = api.list(_video_id(req["url"]))
    t = None
    for finder, kind in ((listing.find_manually_created_transcript, "manual"), (listing.find_generated_transcript, "auto")):
        try:
            t = finder(langs)
            break
        except Exception:  # noqa: BLE001
            continue
    if t is None:
        return {"ok": False, "error": "no English transcript"}
    fetched = t.fetch()
    segs = [{"text": x.text, "start": float(x.start), "duration": float(x.duration)} for x in fetched]
    return {"ok": True, "kind": kind, "lang": t.language_code, "segments": segs}


def whisper_words(req: dict) -> dict:
    """Audio of one video (no captions) -> words with start times, via faster-whisper."""
    import os
    import tempfile

    import transcribe as tr  # shares the CUDA DLL setup with the voiceover transcription

    max_sec = float(req.get("max_seconds") or 1500)
    work = Path(tempfile.mkdtemp(prefix="cf_whisper_"))
    try:
        opts = {**base_opts(), **web_crawl.js_opts(), "format": "bestaudio/best", "outtmpl": str(work / "a.%(ext)s"),
                "quiet": True, "noprogress": True}
        if req.get("ffmpeg"):
            opts["ffmpeg_location"] = req["ffmpeg"]
        with yt_dlp.YoutubeDL(opts) as ydl:
            i = ydl.extract_info(req["url"], download=False) or {}
            dur = float(i.get("duration") or 0)
            if dur and dur > max_sec:
                return {"ok": False, "error": f"video is {int(dur)} s, over the {int(max_sec)} s Whisper limit"}
            ydl.download([req["url"]])
        audio_file = next((f for f in work.iterdir() if f.name.startswith("a.")), None)
        if not audio_file:
            return {"ok": False, "error": "audio download failed"}
        os.environ.setdefault("CT2_CUDA_ALLOCATOR", "cub_caching")
        tr.add_cuda_dll_dirs()
        from faster_whisper import WhisperModel, decode_audio

        audio = decode_audio(str(audio_file), sampling_rate=tr.SR)
        words: list[dict] = []
        last_err = ""
        for device in ([req.get("device") or "cuda", "cpu"] if (req.get("device") or "cuda") != "cpu" else ["cpu"]):
            try:
                model = WhisperModel(req.get("model") or "large-v3-turbo", device=device,
                                     compute_type="int8_float16" if device == "cuda" else "int8",
                                     download_root=req.get("models_dir"))
                segs, _ = model.transcribe(audio, language="en", word_timestamps=True, vad_filter=True,
                                           initial_prompt=req.get("prompt") or None, condition_on_previous_text=False)
                words = [{"text": w.word.strip(), "t": round(float(w.start), 2)} for sg in segs for w in (sg.words or []) if w.word.strip()]
                return {"ok": True, "words": words, "duration": round(len(audio) / tr.SR, 2), "device": device}
            except Exception as e:  # noqa: BLE001  (a faulting GPU: retry on the CPU)
                last_err = f"{device}: {type(e).__name__}: {e}"[:200]
        return {"ok": False, "error": last_err or "whisper failed"}
    finally:
        import shutil

        shutil.rmtree(work, ignore_errors=True)


def main() -> int:
    op = sys.argv[1] if len(sys.argv) > 1 else ""
    if yt_dlp is None:
        print(json.dumps({"ok": False, "error": "yt-dlp is not installed in .venv (pip install -r python/requirements.txt)"}))
        return 0
    try:
        req = json.loads(sys.stdin.read() or "{}")
        if op == "search":
            reply = search(req)
        elif op == "info":
            reply = info(req)
        elif op == "captions":
            reply = captions(req)
        elif op == "transcript":
            reply = transcript(req)
        elif op == "whisper_words":
            reply = whisper_words(req)
        elif op == "fetch":
            reply = web_crawl.fetch_guarded({"max_height": 1080, "timeout": 180, **req})
        else:
            reply = {"ok": False, "error": f"unknown op {op!r} (search | info | captions | transcript | whisper_words | fetch)"}
    except Exception as e:  # noqa: BLE001
        reply = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    print(json.dumps(reply), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
