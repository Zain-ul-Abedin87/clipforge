"""
Open-web Creative Commons clip finder for ClipForge (stock source "web_cc"; last-resort fallback).

  python web_crawler.py --keyword "1980s ibm server racks" --out-dir <workspace> --scene-id 12
                        [--seconds 5] [--ffmpeg C:/.../ffmpeg.exe] [--deadline 55]

1. Sanitizes the keyword and searches DuckDuckGo videos (Creative Commons filter first), shortening
   the query word by word when an obscure niche returns nothing.
2. For each hit, yt-dlp reads ONLY the page metadata first. A clip is downloaded only when the page
   itself says Creative Commons (no NC / ND) or public domain; DDG's filter alone is not proof.
3. Downloads just a short range of that video (never the whole upload), checks it with moviepy,
   cuts a random `seconds` piece, drops the audio and writes <out-dir>/web_<scene>_<hash>.mp4.
4. Writes <clip>.json next to it (licence, page URL, author, title) for the licence log.

stdout: exactly one line, `SUCCESS:<absolute path>`; exit code 1 otherwise. Progress goes to stderr.
Temporary files live in <out-dir>/tmp_web_* and are removed in `finally` (and stale ones on start).
Proxy: YTDLP_PROXY is honoured like youtube_cc.py.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shutil
import sys
import tempfile
import time
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit

try:
    import yt_dlp
    from yt_dlp.utils import download_range_func
except ImportError:
    yt_dlp = None

# `duckduckgo_search` was renamed to `ddgs` in 2025; accept either.
try:
    from ddgs import DDGS
except ImportError:
    try:
        from duckduckgo_search import DDGS
    except ImportError:
        DDGS = None

MIN_SOURCE = 8.0  # shorter videos are usually logos / intros
MAX_SOURCE = 4 * 3600.0
MAX_HITS = 15
# Sites whose pages never carry a usable licence field, or whose hits are vertical shorts.
SKIP_HOSTS = ("tiktok.com", "instagram.com", "facebook.com", "fb.watch", "x.com", "twitter.com", "pinterest.")


def log(msg: str) -> None:
    print(f"[web_cc] {msg}", file=sys.stderr, flush=True)


def sanitize(keyword: str) -> str:
    """Letters, digits, spaces and hyphens only; DDG operators (site:, quotes, -x) are stripped."""
    text = unicodedata.normalize("NFKC", keyword or "")
    text = re.sub(r"\b\w+:\S+", " ", text)  # site:x.com, filetype:mp4, intitle:x ...
    text = re.sub(r"[^\w\s-]", " ", text, flags=re.UNICODE).replace("_", " ")
    text = re.sub(r"(^|\s)-+", " ", text)  # leading minus = exclusion operator
    words = [w for w in text.lower().split() if w.strip("-")]
    return " ".join(words[:8])[:120]


def query_variants(q: str) -> list[str]:
    """Full query first, then shorter ones (drop trailing words) so obscure niches still return hits."""
    words = q.split()
    out = [" ".join(words[:n]) for n in range(len(words), 1, -1)]
    if len(words) >= 3:
        out.insert(1, " ".join(words[-3:]))  # "1980s ibm server racks" -> also "ibm server racks"
    return list(dict.fromkeys(out)) or [q]


def ddg_videos(query: str, cc_only: bool, deadline: float) -> list[dict]:
    """One DDG video search with backoff on rate limits (DDG answers 202/429 when throttled)."""
    for attempt in range(3):
        if time.monotonic() > deadline:
            return []
        try:
            kwargs = {"safesearch": "moderate", "max_results": MAX_HITS}
            if cc_only:
                kwargs["license_videos"] = "creativeCommon"
            with DDGS(timeout=15) as ddgs:
                try:
                    return list(ddgs.videos(query, **kwargs) or [])
                except TypeError:  # ddgs >= 9 takes the query as `query`, older ones as `keywords`
                    return list(ddgs.videos(query=query, **kwargs) or [])
        except Exception as e:  # RatelimitException / TimeoutException / DDGSException
            name = type(e).__name__
            if "ratelimit" in name.lower() or "202" in str(e) or "429" in str(e):
                wait = 2 ** attempt + random.random()
                log(f"DuckDuckGo rate limit; waiting {wait:.1f} s")
                time.sleep(wait)
                continue
            if "noresults" in name.lower() or "no results" in str(e).lower():
                return []
            log(f"search '{query}' failed: {name}: {str(e)[:150]}")
            return []
    return []


# Text-search fallback: sites whose video pages yt-dlp reads with a licence field, without login.
# (Vimeo is left out: yt-dlp needs account cookies for it now.)
VIDEO_SITES = [
    ("site:archive.org/details", re.compile(r"^https?://(www\.)?archive\.org/details/")),
    ("site:commons.wikimedia.org video", re.compile(r"^https?://commons\.wikimedia\.org/wiki/File:.+\.(webm|ogv|mp4|mpg|mpeg)$", re.I)),
    ("creative commons site:youtube.com", re.compile(r"^https?://(www\.)?youtube\.com/watch\?v=[\w-]{11}")),
]


def ddg_text_videos(query: str, deadline: float) -> list[dict]:
    """DDG's video endpoint is often empty or throttled; plain web search for video pages works."""
    out: list[dict] = []
    for site, pattern in VIDEO_SITES:
        for attempt in range(2):
            if time.monotonic() > deadline:
                return out
            try:
                with DDGS(timeout=15) as ddgs:
                    rows = ddgs.text(f"{query} {site}", max_results=8) or []
                out += [{"content": r.get("href", ""), "title": r.get("title", ""), "publisher": site}
                        for r in rows if pattern.match(r.get("href", ""))]
                break
            except Exception as e:
                if "ratelimit" in type(e).__name__.lower() or "202" in str(e) or "429" in str(e):
                    time.sleep(2 ** attempt + random.random())
                    continue
                break  # "No results found." and network errors: next site
    return out


def search(keyword: str, deadline: float) -> list[dict]:
    seen: set[str] = set()
    hits: list[dict] = []
    # DDG's video endpoint often answers "No results" for everything, so it gets one try before the
    # text search; licences are verified per page anyway, later modes only widen the pool.
    for mode in ("cc", "text", "any"):
        for q in query_variants(keyword)[: 2 if mode == "text" else 1]:
            rows = ddg_text_videos(q, deadline) if mode == "text" else ddg_videos(q, mode == "cc", deadline)
            for r in rows:
                url = (r.get("content") or "").strip()
                host = urlsplit(url).hostname or ""
                if not url.startswith("http") or url in seen or any(s in host for s in SKIP_HOSTS):
                    continue
                if "/shorts/" in url:
                    continue
                seen.add(url)
                hits.append({"url": url, "title": r.get("title") or "", "publisher": r.get("publisher") or ""})
            if len(hits) >= MAX_HITS:
                return hits
        if hits:
            return interleave(hits)
    return interleave(hits)


def interleave(hits: list[dict]) -> list[dict]:
    """Round-robin by site, so ten Archive.org scans of manuals cannot use up the whole deadline."""
    by_host: dict[str, list[dict]] = {}
    for h in hits:
        by_host.setdefault(urlsplit(h["url"]).hostname or "", []).append(h)
    queues = list(by_host.values())
    out: list[dict] = []
    while any(queues):
        for q in queues:
            if q:
                out.append(q.pop(0))
    return out


def licence_ok(lic: str) -> bool:
    """Commercial reuse with edits must be allowed: CC BY / BY-SA / CC0 / public domain, never NC or ND."""
    # yt-dlp reports e.g. "by-sa" (Vimeo), ".../licenses/by-nc-nd/3.0/" (URLs),
    # "Attribution - Share Alike" (PeerTube), "Creative Commons Attribution license (reuse allowed)".
    s = re.sub(r"[-_/]", " ", lic.lower()).strip()
    if not s:
        return False
    if "noncommercial" in s or "non commercial" in s or re.search(r"\bnc\b", s):
        return False
    if "noderiv" in s or "no deriv" in s or re.search(r"\bnd\b", s):
        return False
    if re.fullmatch(r"(cc )?by( sa)?( [\d.]+)?", s):
        return True
    return any(k in s for k in ("creative commons", "creativecommons", "cc by", "cc0",
                                "public domain", "publicdomain", "pdm", "attribution"))


class QuietLogger:
    def debug(self, msg: str) -> None:
        pass

    def info(self, msg: str) -> None:
        pass

    def warning(self, msg: str) -> None:
        pass

    def error(self, msg: str) -> None:
        pass


def proxy_url() -> str | None:
    raw = os.environ.get("YTDLP_PROXY", "").strip()
    if not raw:
        return None
    return raw if "://" in raw else "http://" + raw


def ydl_opts(tmp: Path, ffmpeg: str | None) -> dict:
    opts = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "noplaylist": True,
        "playlistend": 1,
        "ignoreerrors": False,  # errors are caught per candidate so the next one is tried
        "logger": QuietLogger(),  # yt-dlp prints ERROR lines even when quiet; they arrive as exceptions
        "retries": 2,
        "fragment_retries": 2,
        "extractor_retries": 1,
        "socket_timeout": 20,
        "max_filesize": 300 * 1024 * 1024,
        "outtmpl": str(tmp / "raw.%(ext)s"),
        # Video only, small: the narration replaces the audio and the link is slow.
        "format": "bv*[height<=720][ext=mp4]/bv*[height<=720]/b[height<=720][ext=mp4]/b[height<=720]/bv*/b",
    }
    if ffmpeg:
        opts["ffmpeg_location"] = ffmpeg
    proxy = proxy_url()
    if proxy:
        opts["proxy"] = proxy
    return opts


def probe(ydl, url: str) -> dict | None:
    info = ydl.extract_info(url, download=False)
    if not info:
        return None
    if info.get("_type") == "playlist" or info.get("entries"):
        return None  # channel / gallery pages, not one video
    return info


def load_clip(path: str):
    try:
        from moviepy.editor import VideoFileClip  # moviepy 1.x
    except ImportError:
        from moviepy import VideoFileClip  # moviepy 2.x
    return VideoFileClip(path, audio=False)


def cut(clip, start: float, end: float):
    return clip.subclip(start, end) if hasattr(clip, "subclip") else clip.subclipped(start, end)


def make_clip(raw: Path, out: Path, seconds: float) -> tuple[int, int]:
    """Validates the download and writes a muted `seconds` piece; raises ValueError when unusable."""
    clip = piece = None
    try:
        clip = load_clip(str(raw))
        dur = float(clip.duration or 0)
        w, h = clip.size
        if dur < seconds + 0.2:
            raise ValueError(f"download too short ({dur:.1f}s)")
        if not w or not h or w < 480:
            raise ValueError(f"too small ({w}x{h})")
        if w < h:
            raise ValueError("vertical video")
        clip.get_frame(min(dur - 0.1, 1.0))  # corrupt files fail here, not halfway through the encode
        start = random.uniform(0, max(0.0, dur - seconds - 0.1))
        piece = cut(clip, start, start + seconds).without_audio()
        part = out.with_name(out.stem + ".part.mp4")
        piece.write_videofile(
            str(part), codec="libx264", audio=False, preset="veryfast",
            ffmpeg_params=["-crf", "20", "-pix_fmt", "yuv420p"], logger=None,
        )
        if not part.exists() or part.stat().st_size < 10_000:
            part.unlink(missing_ok=True)
            raise ValueError("encode produced no usable file")
        part.replace(out)
        return int(w), int(h)
    finally:
        for c in (piece, clip):
            try:
                if c is not None:
                    c.close()
            except Exception:
                pass


def try_candidate(hit: dict, out: Path, seconds: float, ffmpeg: str | None, workdir: Path) -> dict | None:
    tmp = Path(tempfile.mkdtemp(prefix="tmp_web_", dir=workdir))
    try:
        with yt_dlp.YoutubeDL(ydl_opts(tmp, ffmpeg)) as ydl:
            info = probe(ydl, hit["url"])
            if not info:
                log(f"skip {hit['url']}: not a single video")
                return None
            lic = str(info.get("license") or "")
            if not licence_ok(lic):
                log(f"skip {hit['url']}: licence '{lic or 'none stated'}'")
                return None
            if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
                return None
            dur = float(info.get("duration") or 0)
            if dur and not (MIN_SOURCE <= dur <= MAX_SOURCE):
                log(f"skip {hit['url']}: length {dur:.0f}s")
                return None
            if dur:
                # Only a piece around a random point (past intros/outros) is downloaded.
                lo, hi = dur * 0.15, max(dur * 0.15, dur * 0.8 - seconds - 2)
                start = random.uniform(lo, hi) if dur > seconds * 3 else 0.0
                ydl.params["download_ranges"] = download_range_func(None, [(start, min(dur, start + seconds + 3))])
                ydl.params["force_keyframes_at_cuts"] = False
            log(f"downloading from {hit['url']} ({lic})")
            ydl.process_ie_result(info, download=True)
        raws = [p for p in tmp.iterdir() if p.name.startswith("raw.") and not p.name.endswith(".part") and p.stat().st_size > 0]
        if not raws:
            log(f"skip {hit['url']}: download produced no file")
            return None
        w, h = make_clip(raws[0], out, seconds)
        return {
            "license": lic,
            "url": info.get("webpage_url") or hit["url"],
            "title": info.get("title") or hit["title"],
            "author": info.get("uploader") or info.get("channel") or hit["publisher"],
            "author_url": info.get("uploader_url") or info.get("channel_url") or "",
            "extractor": info.get("extractor_key") or "",
            "width": w,
            "height": h,
            "duration": seconds,
        }
    except ValueError as e:
        log(f"skip {hit['url']}: {e}")
        return None
    except Exception as e:  # DownloadError, blocked pages, corrupt containers, moviepy/ffmpeg errors
        log(f"skip {hit['url']}: {type(e).__name__}: {str(e).replace('ERROR: ', '')[:160]}")
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def clear_stale(workdir: Path) -> None:
    """A crawler killed by the Node timeout cannot run `finally`: remove its leftovers later."""
    for old in workdir.glob("tmp_web_*"):
        try:
            if old.is_dir() and time.time() - old.stat().st_mtime > 600:
                shutil.rmtree(old, ignore_errors=True)
        except OSError:
            pass
    for part in workdir.glob("web_*.part.mp4"):
        try:
            if time.time() - part.stat().st_mtime > 600:
                part.unlink()
        except OSError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Find one Creative Commons / public-domain web clip for a keyword.")
    ap.add_argument("--keyword", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--scene-id", required=True)
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--ffmpeg", default="")
    ap.add_argument("--deadline", type=float, default=55.0, help="stop trying new videos after this many seconds")
    args = ap.parse_args()

    if yt_dlp is None or DDGS is None:
        log("missing packages: pip install -r python/requirements.txt (yt-dlp, ddgs, moviepy)")
        return 1
    if args.ffmpeg and Path(args.ffmpeg).exists():
        os.environ.setdefault("IMAGEIO_FFMPEG_EXE", args.ffmpeg)  # moviepy uses the pinned FFmpeg
    keyword = sanitize(args.keyword)
    if not keyword:
        log("keyword is empty after sanitizing")
        return 1
    scene = re.sub(r"[^\w-]", "", str(args.scene_id))[:40] or "x"
    seconds = max(1.0, min(args.seconds, 30.0))
    workdir = Path(args.out_dir).resolve()
    workdir.mkdir(parents=True, exist_ok=True)
    clear_stale(workdir)
    deadline = time.monotonic() + max(5.0, args.deadline)

    out = workdir / f"web_{scene}_{hashlib.sha1(keyword.encode()).hexdigest()[:10]}.mp4"
    meta_file = out.with_suffix(".json")
    if out.exists() and meta_file.exists() and out.stat().st_size > 10_000:
        print(f"SUCCESS:{out}", flush=True)
        return 0

    try:
        hits = search(keyword, deadline)
        log(f"'{keyword}': {len(hits)} video page(s) found")
        for hit in hits:
            if time.monotonic() > deadline:
                log("deadline reached")
                break
            meta = try_candidate(hit, out, seconds, args.ffmpeg or None, workdir)
            if meta:
                meta["keyword"] = keyword
                meta_file.write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")
                print(f"SUCCESS:{out}", flush=True)
                return 0
        log("no Creative Commons / public-domain clip found")
        return 1
    except KeyboardInterrupt:
        return 1
    except Exception as e:
        log(f"failed: {type(e).__name__}: {e}")
        return 1
    finally:
        if not meta_file.exists():
            out.unlink(missing_ok=True)
        out.with_name(out.stem + ".part.mp4").unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
