"""
YouTube Creative Commons worker for ClipForge (stock provider "youtube_cc").

Runs as one long-lived process (`youtube_cc.py serve`): the Node side writes one JSON request per
line on stdin and reads one JSON reply per line on stdout, so yt-dlp is imported once per run.

  {"id": 1, "op": "search", "query": "...", "limit": 6}
      -> {"id": 1, "ok": true, "results": [{"id", "title", "channel", "duration"}, ...]}
     YouTube search with its own "Creative Commons" filter. Licences are checked again on fetch.

  {"id": 2, "op": "fetch", "video": "<11-char id>", "start": 120.0, "seconds": 15,
   "out": "C:/.../ytcc_x.mp4", "ffmpeg": "C:/.../ffmpeg.exe", "max_height": 1080}
      -> {"id": 2, "ok": true, "path": "...", "license": "...", "channel": "...", "width": 1920, ...}
     Reads the watch page, refuses anything that is not marked Creative Commons, then downloads
     only `seconds` of video (no audio) from `start` and re-encodes it to H.264 at `out`.

Proxy: YTDLP_PROXY (http://user:pass@ip:port, or user:pass@ip:port) routes every request.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import shutil
import tempfile
import time
from pathlib import Path
from urllib.parse import quote_plus, urlsplit

try:
    import yt_dlp
    from yt_dlp.utils import DownloadError, download_range_func
except ImportError:
    yt_dlp = None

# YouTube's search filter parameter for "Creative Commons".
CC_FILTER = "EgIwAQ%3D%3D"


def proxy_url() -> str | None:
    raw = os.environ.get("YTDLP_PROXY", "").strip()
    if not raw:
        return None
    if "://" not in raw:
        raw = "http://" + raw
    parts = urlsplit(raw)
    if parts.scheme not in {"http", "https", "socks4", "socks5", "socks5h"} or not parts.hostname or not parts.port:
        raise ValueError("YTDLP_PROXY must look like http://user:pass@ip:port")
    return raw


def base_opts() -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "retries": 3,
        "fragment_retries": 3,
        "extractor_retries": 2,
        "socket_timeout": 30,
    }
    proxy = proxy_url()
    if proxy:
        opts["proxy"] = proxy
    return opts


def search(req: dict) -> dict:
    limit = max(1, min(int(req.get("limit", 6)), 15))
    url = f"https://www.youtube.com/results?search_query={quote_plus(req['query'])}&sp={CC_FILTER}"
    # Flat listing: one search page, no per-video requests (slow connections).
    opts = {**base_opts(), "extract_flat": "in_playlist", "playlistend": limit * 2, "noplaylist": False}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False) or {}
    results = []
    for e in info.get("entries") or []:
        vid = (e or {}).get("id")
        dur = e.get("duration") or 0
        # Skip Shorts (vertical), live streams, and clips too short to cut a piece from.
        if not vid or len(vid) != 11 or "/shorts/" in (e.get("url") or "") or e.get("live_status") == "is_live":
            continue
        if dur < 30 or dur > 4 * 3600:
            continue
        results.append({
            "id": vid,
            "title": e.get("title") or "",
            "channel": e.get("channel") or e.get("uploader") or "",
            "channel_url": e.get("channel_url") or e.get("uploader_url") or "",
            "duration": dur,
        })
        if len(results) >= limit:
            break
    return {"ok": True, "results": results}


def probe_size(ffmpeg: str, file: str) -> tuple[int, int]:
    ffprobe = str(Path(ffmpeg).with_name("ffprobe" + Path(ffmpeg).suffix))
    r = subprocess.run(
        [ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file],
        capture_output=True, text=True, timeout=60,
    )
    w, h = (r.stdout.strip().split(",") + ["0", "0"])[:2]
    return int(w or 0), int(h or 0)


def fetch(req: dict) -> dict:
    url = f"https://www.youtube.com/watch?v={req['video']}"
    seconds = float(req.get("seconds", 15))
    out = Path(req["out"])
    ffmpeg = req["ffmpeg"]
    h = int(req.get("max_height", 1080))
    # A worker killed after a timeout leaves its temp folder behind: clear ones older than an hour.
    for old in out.parent.glob("tmp*"):
        try:
            if old.is_dir() and time.time() - old.stat().st_mtime > 3600:
                shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass
    with tempfile.TemporaryDirectory(dir=out.parent) as tmp:
        opts = {
            **base_opts(),
            # Video only: the narration replaces the audio, so never download it.
            "format": f"bv*[vcodec^=avc1][height<={h}]/bv*[height<={h}][ext=mp4]/bv*[height<={h}]/b[height<={h}]",
            "outtmpl": str(Path(tmp) / "piece.%(ext)s"),
            "ffmpeg_location": ffmpeg,
        }
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            lic = (info or {}).get("license") or ""
            # The search filter is not proof: the watch page must say Creative Commons.
            if "creative commons" not in lic.lower():
                return {"ok": False, "error": f"not Creative Commons on its watch page (licence: {lic or 'standard YouTube'})"}
            if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
                return {"ok": False, "error": "live stream"}
            dur = float(info.get("duration") or 0)
            if dur < seconds + 2:
                return {"ok": False, "error": f"too short ({dur:.0f}s)"}
            start = max(0.0, min(float(req.get("start", dur * 0.35)), dur - seconds - 1))
            # Only this piece is downloaded (yt-dlp hands the range to FFmpeg), never the whole video.
            ydl.params["download_ranges"] = download_range_func(None, [(start, start + seconds + 1)])
            ydl.process_ie_result(info, download=True)
        pieces = [p for p in Path(tmp).iterdir() if p.name.startswith("piece.") and p.stat().st_size > 0]
        if not pieces:
            return {"ok": False, "error": "download produced no file"}
        part = out.with_name(out.name + ".part.mp4")
        r = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(pieces[0]), "-t", str(seconds),
             "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", str(part)],
            capture_output=True, text=True, timeout=300,
        )
        if r.returncode != 0 or not part.exists():
            part.unlink(missing_ok=True)
            return {"ok": False, "error": f"re-encode failed: {r.stderr[-200:]}"}
        w, hh = probe_size(ffmpeg, str(part))
        if w and hh and w < hh:
            part.unlink(missing_ok=True)
            return {"ok": False, "error": "vertical video"}
        part.replace(out)
    return {
        "ok": True,
        "path": str(out),
        "license": lic,
        "title": info.get("title") or "",
        "channel": info.get("channel") or info.get("uploader") or "",
        "channel_url": info.get("channel_url") or info.get("uploader_url") or "",
        "start": round(start, 2),
        "width": w,
        "height": hh,
    }


def serve() -> None:
    if yt_dlp is None:
        print(json.dumps({"ready": False, "error": "yt-dlp is not installed in .venv (pip install -r python/requirements.txt)"}), flush=True)
        return
    try:
        proxy_url()
    except ValueError as e:
        print(json.dumps({"ready": False, "error": str(e)}), flush=True)
        return
    print(json.dumps({"ready": True, "version": yt_dlp.version.__version__, "proxy": bool(proxy_url())}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            if req.get("op") == "search":
                reply = search(req)
            elif req.get("op") == "fetch":
                reply = fetch(req)
            else:
                reply = {"ok": False, "error": f"unknown op {req.get('op')!r}"}
        except DownloadError as e:
            reply = {"ok": False, "error": str(e).replace("ERROR: ", "")[:300]}
        except Exception as e:  # one bad request must not kill the worker
            reply = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
        reply["id"] = rid
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        serve()
    else:
        sys.exit(__doc__)
