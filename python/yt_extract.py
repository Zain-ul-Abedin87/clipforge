"""Exact-model YouTube extractor helper for ClipForge (src/lib/assets/ytExtractor.ts).

One request per process: JSON on stdin, one JSON line on stdout.

  python yt_extract.py search   {"queries": ["Honda HRX217 walkaround", ...], "limit": 10}
      -> {"ok": true, "results": [{"id", "url", "title", "duration", "channel", "channel_url", "query"}]}
  python yt_extract.py info     {"url": "https://www.youtube.com/watch?v=..."}
      -> {"ok": true, "title", "duration", "channel", "chapters": [{"start", "end", "title"}], "description"}
  python yt_extract.py captions {"url": "..."}
      -> {"ok": true, "kind": "manual" | "auto", "lang", "ext": "json3" | "vtt", "data": "<raw caption file>", "duration"}
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
        elif op == "fetch":
            reply = web_crawl.fetch_guarded({"max_height": 1080, "timeout": 180, **req})
        else:
            reply = {"ok": False, "error": f"unknown op {op!r} (search | info | captions | fetch)"}
    except Exception as e:  # noqa: BLE001
        reply = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    print(json.dumps(reply), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
