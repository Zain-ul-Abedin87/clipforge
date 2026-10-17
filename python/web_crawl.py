"""
General web-crawl footage worker for ClipForge (stock provider "web_crawl", VidRush-style).

Unlike youtube_cc.py this is NOT limited to Creative Commons: it searches YouTube (yt-dlp
"ytsearch") plus DuckDuckGo video results on sites yt-dlp supports (Vimeo, Dailymotion,
archive.org, ...). Every clip is logged with licence "unknown/web" and flagged in QA as a
copyright risk. Same JSON-lines protocol as youtube_cc.py (`web_crawl.py serve`):

  {"id": 1, "op": "search", "query": "...", "limit": 4}
      -> {"ok": true, "results": [{"url", "title", "uploader", "duration", "site"}, ...]}
  {"id": 2, "op": "fetch", "url": "...", "start": 30, "seconds": 45, "out": ".../x.mp4",
   "ffmpeg": ".../ffmpeg.exe", "max_height": 360}
      -> {"ok": true, "path", "uploader", "uploader_url", "license", "title", "duration", "start", "width", "height"}
     Downloads only `seconds` of video (no audio) from `start` (yt-dlp --download-sections style).
     Used twice: low-res (360p) preview for shot splitting + CLIP, then HD for the picked shot only.

Proxy: YTDLP_PROXY is honoured (same helper as youtube_cc.py).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from youtube_cc import base_opts, probe_size, proxy_url  # noqa: E402

try:
    import yt_dlp
    from yt_dlp.utils import DownloadError, download_range_func
except ImportError:
    yt_dlp = None

# --- yt-dlp anti-bot setup (every YoutubeDL in this module):
#  * PO tokens via bgutil-ytdlp-pot-provider: HTTP server on 127.0.0.1:4416 (tools/bgutil/server,
#    started by the CLI) with script mode (node tools/bgutil/server/build/generate_once.js) as fallback.
#  * Node as the JS runtime for YouTube signature solving.
#  * Polite pacing: sleep between requests/downloads, retries with exponential backoff.
#  * Optional cookies: YTDLP_COOKIES_FILE=path\\to\\cookies.txt or YTDLP_COOKIES_FROM_BROWSER=firefox[:profile].
def _ytdlp_cookie_opts():
    import os as _os
    root = _os.path.dirname(_os.path.dirname(_os.path.abspath(__file__)))
    home = _os.environ.get("BGUTIL_SERVER_HOME", _os.path.join(root, "tools", "bgutil", "server"))
    backoff = lambda n: min(30.0, 2.0 ** n)
    o = {
        "js_runtimes": {"node": {}},
        "extractor_args": {
            "youtubepot-bgutilhttp": {"base_url": [_os.environ.get("BGUTIL_POT_URL", "http://127.0.0.1:4416")]},
            "youtubepot-bgutilscript": {"server_home": [home]},
        },
        "sleep_interval_requests": float(_os.environ.get("YTDLP_SLEEP_REQUESTS", "0.8")),
        "sleep_interval": float(_os.environ.get("YTDLP_SLEEP_INTERVAL", "1")),
        "max_sleep_interval": float(_os.environ.get("YTDLP_MAX_SLEEP_INTERVAL", "3")),
        "retries": 5,
        "extractor_retries": 3,
        "fragment_retries": 5,
        "retry_sleep_functions": {"http": backoff, "fragment": backoff, "extractor": backoff},
    }
    f = _os.environ.get("YTDLP_COOKIES_FILE", "").strip().strip('"')
    if f and _os.path.exists(f):
        o["cookiefile"] = f
    else:
        b = _os.environ.get("YTDLP_COOKIES_FROM_BROWSER", "").strip()
        if b:
            name, _, prof = b.partition(":")
            o["cookiesfrombrowser"] = (name, prof or None, None, None)
    return o

if yt_dlp is not None and not getattr(yt_dlp.YoutubeDL, "_cf_cookies", False):
    class _CookieYDL(yt_dlp.YoutubeDL):
        _cf_cookies = True
        def __init__(self, params=None, *a, **k):
            p = params or {}; d = _ytdlp_cookie_opts(); ea = {**d.pop('extractor_args'), **(p.get('extractor_args') or {})}
            super().__init__({**d, **p, 'extractor_args': ea}, *a, **k)
    yt_dlp.YoutubeDL = _CookieYDL
# --- end cookies
    DownloadError = Exception  # type: ignore

DEFAULT_SITES = "youtube.com,youtu.be,vimeo.com,dailymotion.com,archive.org"


def sites() -> list[str]:
    return [s.strip().lower() for s in os.environ.get("WEBCRAWL_SITES", DEFAULT_SITES).split(",") if s.strip()]


def host_ok(url: str) -> str | None:
    host = (urlsplit(url).hostname or "").lower()
    for s in sites():
        if host == s or host.endswith("." + s):
            return s
    return None


def parse_dur(v) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    try:
        parts = [float(p) for p in str(v).split(":")]
        t = 0.0
        for p in parts:
            t = t * 60 + p
        return t
    except ValueError:
        return 0.0


def search(req: dict) -> dict:
    limit = max(1, min(int(req.get("limit", 4)), 10))
    q = req["query"]
    results: list[dict] = []
    seen: set[str] = set()

    def add(url, title, uploader, duration, site):
        if not url or url in seen:
            return
        d = parse_dur(duration)
        if d and (d < 20 or d > 4 * 3600):
            return
        seen.add(url)
        results.append({"url": url, "title": title or "", "uploader": uploader or "", "duration": d, "site": site})

    errors = []
    if any(s in ("youtube.com", "youtu.be") for s in sites()):
        try:
            opts = {**base_opts(), "socket_timeout": 20, "extract_flat": "in_playlist", "noplaylist": False}
            with yt_dlp.YoutubeDL(opts) as ydl:
                info = ydl.extract_info(f"ytsearch{limit * 2}:{q}", download=False) or {}
            n = 0
            for e in info.get("entries") or []:
                vid = (e or {}).get("id")
                if not vid or len(vid) != 11 or "/shorts/" in (e.get("url") or "") or e.get("live_status") == "is_live":
                    continue
                add(f"https://www.youtube.com/watch?v={vid}", e.get("title"), e.get("channel") or e.get("uploader"), e.get("duration"), "youtube.com")
                n += 1
                if n >= limit:
                    break
        except Exception as e:  # noqa: BLE001
            errors.append(f"ytsearch: {e}"[:150])
    others = [s for s in sites() if s not in ("youtube.com", "youtu.be")]
    if others:
        try:
            try:
                from ddgs import DDGS
            except ImportError:
                from duckduckgo_search import DDGS  # type: ignore
            proxy = proxy_url()
            dd = DDGS(proxy=proxy) if proxy else DDGS()
            n = 0
            for r in dd.videos(q, max_results=limit * 6) or []:
                url = r.get("content") or ""
                site = host_ok(url)
                if not site or site in ("youtube.com", "youtu.be"):
                    continue
                add(url, r.get("title"), r.get("uploader") or r.get("publisher"), r.get("duration"), site)
                n += 1
                if n >= limit:
                    break
        except Exception as e:  # noqa: BLE001
            errors.append(f"ddgs: {e}"[:150])
    if not results and errors:
        return {"ok": False, "error": "; ".join(errors)}
    return {"ok": True, "results": results}


MAX_MB = int(os.environ.get("WEBCRAWL_MAX_MB", "80"))
FETCH_TIMEOUT = float(os.environ.get("WEBCRAWL_FETCH_TIMEOUT", "90"))


def log(msg: str) -> None:
    print(f"[web_crawl.py] {msg}", file=sys.stderr, flush=True)


def kill_tree(proc: subprocess.Popen) -> None:
    if os.name == "nt":
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True)
    else:
        proc.kill()


def fetch_guarded(req: dict) -> dict:
    """Runs fetch() in a child process with a hard timeout; the whole tree (yt-dlp, ffmpeg) is killed on expiry."""
    timeout = float(req.get("timeout", FETCH_TIMEOUT))
    proc = subprocess.Popen([sys.executable, "-u", __file__, "fetch-one"], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=None, text=True)
    try:
        outp, _ = proc.communicate(json.dumps(req), timeout=timeout)
    except subprocess.TimeoutExpired:
        kill_tree(proc)
        proc.communicate()
        log(f"fetch {req.get('url')}: TIMEOUT after {timeout:.0f}s, killed")
        return {"ok": False, "error": f"timeout after {timeout:.0f}s"}
    lines = [l for l in (outp or "").splitlines() if l.strip().startswith("{")]
    if not lines:
        return {"ok": False, "error": f"fetch child exited {proc.returncode} without a reply"}
    return json.loads(lines[-1])


def fetch_one() -> None:
    req = json.loads(sys.stdin.read())
    try:
        reply = fetch(req)
    except DownloadError as e:
        reply = {"ok": False, "error": str(e).replace("ERROR: ", "")[:300]}
    except Exception as e:  # noqa: BLE001
        reply = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
    print(json.dumps(reply), flush=True)


def js_opts() -> dict:
    """JS runtime for YouTube signature solving (yt-dlp >= 2025.11 only enables deno by default)."""
    node = shutil.which("node")
    if not node or os.environ.get("WEBCRAWL_JS", "on").lower() == "off":
        return {}
    return {"js_runtimes": {"node": {"path": node}}}


def fetch(req: dict) -> dict:
    url = req["url"]
    seconds = float(req.get("seconds", 15))
    out = Path(req["out"])
    out.parent.mkdir(parents=True, exist_ok=True)
    ffmpeg = req["ffmpeg"]
    h = int(req.get("max_height", 1080))
    MAX_MB = int(req.get("max_mb", globals()["MAX_MB"]))
    for old in out.parent.glob("tmp*"):
        try:
            if old.is_dir() and time.time() - old.stat().st_mtime > 3600:
                shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass
    with tempfile.TemporaryDirectory(dir=out.parent) as tmp:
        # Previews and HD shots: yt-dlp fetches only the needed seconds (download_ranges, ffmpeg reads
        # the googlevideo URL). YouTube answers ~10% of those URLs with HTTP 403 (ffmpeg exit
        # 0xCCD00008 = AVERROR_HTTP_FORBIDDEN), at random, with or without a JS runtime. A 403 fails in
        # a few seconds, so: re-extract (fresh URL) and retry the range once, then fall back to a full
        # small-file native download that is trimmed locally.
        # Height: HD asks for exactly 1080p, then 720p, then the best below max_height.
        if h >= 720:
            heights = [x for x in (1080, 720) if x <= h]
            exact = "/".join(f"bv*[height={x}][vcodec^=avc1]/bv*[height={x}]" for x in heights)
            range_fmt = f"{exact}/bv*[height<={h}][vcodec^=avc1]/bv*[height<={h}]/b[height<={h}]"
        else:
            range_fmt = f"bv*[height<={h}][height>=240][vcodec^=avc1]/bv*[height<={h}][height>=240]/bv*[height<={h}]/worst"
        full_fmt = (f"bv*[height<={h}][height>=240][vcodec^=avc1][filesize<{MAX_MB}M]/bv*[height<={h}][height>=240][filesize<{MAX_MB}M]"
                    f"/bv*[height<={h}][vcodec^=avc1][filesize_approx<{MAX_MB}M]/bv*[height<={h}][filesize_approx<{MAX_MB}M]"
                    f"/b[height<={h}][filesize_approx<{MAX_MB}M]/worst[height>=240]/worst")
        base = {**base_opts(), **js_opts(), "outtmpl": str(Path(tmp) / "piece.%(ext)s"), "ffmpeg_location": ffmpeg,
                "socket_timeout": 20, "retries": 2, "noprogress": True, "overwrites": True}
        with yt_dlp.YoutubeDL({**base, "format": range_fmt}) as ydl:
            info = ydl.extract_info(url, download=False) or {}
            if info.get("_type") == "playlist":
                entries = [e for e in info.get("entries") or [] if e]
                if not entries:
                    return {"ok": False, "error": "playlist without videos"}
                url = entries[0].get("webpage_url") or entries[0].get("url")
                info = ydl.extract_info(url, download=False) or {}
        if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
            return {"ok": False, "error": "live stream"}
        dur = float(info.get("duration") or 0)
        if dur and dur < 3:
            return {"ok": False, "error": f"too short ({dur:.0f}s)"}
        if dur:
            seconds = min(seconds, max(2.0, dur - 1))
            start = max(0.0, min(float(req.get("start", dur * 0.3)), dur - seconds - 0.5))
        else:
            start = float(req.get("start", 0))
        piece_offset = None  # where the downloaded piece starts in the source video
        attempts = []
        for attempt in (1, 2):
            for f in Path(tmp).glob("piece.*"):
                f.unlink(missing_ok=True)
            log(f"fetch {url} {h}p: range {start:.0f}s+{seconds:.0f}s, attempt {attempt}")
            try:
                ro = {**base, "format": range_fmt, "download_ranges": download_range_func(None, [(start, start + seconds + 1)]),
                      "force_keyframes_at_cuts": False}
                with yt_dlp.YoutubeDL(ro) as ydl:
                    got = ydl.extract_info(url, download=True) or {}
                piece_offset = start
                info = {**info, **{k: got.get(k) for k in ("height", "width") if got.get(k)}}
                break
            except Exception as e:  # noqa: BLE001
                msg = str(e)
                attempts.append(msg[-80:])
                if not ("3436169992" in msg or "403" in msg):
                    break
        if piece_offset is None:
            log(f"fetch {url}: range download failed ({'; '.join(attempts)}), full small-file download")
            for f in Path(tmp).glob("piece.*"):
                f.unlink(missing_ok=True)
            fo = {**base, "format": full_fmt, "max_filesize": MAX_MB * 1024 * 1024}
            with yt_dlp.YoutubeDL(fo) as ydl:
                ydl.extract_info(url, download=True)
            piece_offset = 0.0
        pieces = [p for p in Path(tmp).iterdir() if p.name.startswith("piece.") and p.stat().st_size > 0]
        if not pieces:
            return {"ok": False, "error": "download produced no file"}
        log(f"fetch {url}: downloaded {pieces[0].stat().st_size // 1024} KB, trimming")
        part = out.with_name(out.name + ".part.mp4")
        vf = f"scale=-2:'min({h},ih)'"
        r = subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-ss", f"{max(0.0, start - piece_offset):.2f}", "-i", str(pieces[0]), "-t", str(seconds), "-an",
             "-vf", vf, "-c:v", "libx264", "-preset", "veryfast" if h > 480 else "ultrafast", "-crf", "20" if h > 480 else "28",
             "-pix_fmt", "yuv420p", str(part)],
            capture_output=True, text=True, timeout=120,
        )
        if r.returncode != 0 or not part.exists():
            part.unlink(missing_ok=True)
            return {"ok": False, "error": f"re-encode failed: {r.stderr[-200:]}"}
        w, hh = probe_size(ffmpeg, str(part))
        if w and hh and w < hh and not req.get("allow_vertical"):
            part.unlink(missing_ok=True)
            return {"ok": False, "error": "vertical video"}
        part.replace(out)
    return {
        "ok": True,
        "path": str(out),
        "license": "unknown/web" + (f" (page says: {info.get('license')})" if info.get("license") else ""),
        "title": info.get("title") or "",
        "uploader": info.get("uploader") or info.get("channel") or "",
        "uploader_url": info.get("uploader_url") or info.get("channel_url") or "",
        "webpage_url": info.get("webpage_url") or url,
        "duration": dur,
        "start": round(start, 2),
        "seconds": seconds,
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
            op = req.get("op")
            reply = search(req) if op == "search" else fetch_guarded(req) if op == "fetch" else {"ok": False, "error": f"unknown op {op!r}"}
        except DownloadError as e:
            reply = {"ok": False, "error": str(e).replace("ERROR: ", "")[:300]}
        except Exception as e:  # noqa: BLE001
            reply = {"ok": False, "error": f"{type(e).__name__}: {e}"[:300]}
        reply["id"] = rid
        print(json.dumps(reply), flush=True)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "serve":
        serve()
    elif len(sys.argv) > 1 and sys.argv[1] == "fetch-one":
        fetch_one()
    else:
        sys.exit(__doc__)
