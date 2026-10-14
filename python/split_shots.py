"""Splits a video into shots with PySceneDetect (ContentDetector) and grabs frames per shot.

  python split_shots.py --video in.mp4 --out-dir frames/ [--min-shot 1.5] [--frames 3]
         [--threshold 27] [--ffmpeg ffmpeg.exe]

Prints one JSON line: {"ok": true, "duration": 45.0, "shots": [{"start", "end", "frames": [jpg, ...]}, ...]}
Shots shorter than --min-shot seconds are dropped. A video without cuts is one shot.
Frames are taken at 20/50/80% of each shot (fewer for short shots), 384 px wide JPEGs.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


def secs(tc) -> float:
    v = getattr(tc, "seconds", None)
    return float(v) if v is not None and not callable(v) else float(tc.get_seconds())


def grab(ffmpeg: str, video: str, t: float, out: Path) -> bool:
    if out.exists() and out.stat().st_size > 0:
        return True
    r = subprocess.run([ffmpeg, "-v", "error", "-y", "-ss", f"{t:.2f}", "-i", video, "-frames:v", "1",
                        "-vf", "scale=384:-2", "-q:v", "5", str(out)], capture_output=True, timeout=60)
    return r.returncode == 0 and out.exists()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--min-shot", type=float, default=1.5)
    ap.add_argument("--frames", type=int, default=3)
    ap.add_argument("--threshold", type=float, default=27.0)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    a = ap.parse_args()
    try:
        from scenedetect import ContentDetector, SceneManager, open_video
    except ImportError:
        print(json.dumps({"ok": False, "error": "missing packages: scenedetect / opencv (pip install -r python/requirements.txt)"}))
        return 2

    video = open_video(a.video)
    duration = secs(video.duration) if video.duration else 0.0
    sm = SceneManager()
    sm.add_detector(ContentDetector(threshold=a.threshold, min_scene_len=int(max(1, round(a.min_shot * (video.frame_rate or 30)) // 2))))
    sm.detect_scenes(video, show_progress=False)
    spans = [(secs(s), secs(e)) for s, e in sm.get_scene_list()]
    if not spans:
        spans = [(0.0, duration)]
    out_dir = Path(a.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = Path(a.video).stem
    shots = []
    for i, (s, e) in enumerate(spans):
        if e - s < a.min_shot:
            continue
        n = max(1, min(a.frames, int((e - s) // 1.0)))
        fracs = [0.5] if n == 1 else [0.2, 0.8] if n == 2 else [0.2, 0.5, 0.8][:n]
        frames = []
        for k, f in enumerate(fracs):
            out = out_dir / f"{stem}_s{i:03d}_{k}.jpg"
            if grab(a.ffmpeg, a.video, s + (e - s) * f, out):
                frames.append(str(out))
        if frames:
            shots.append({"start": round(s, 2), "end": round(e, 2), "frames": frames})
    print(json.dumps({"ok": True, "duration": round(duration, 2), "shots": shots}))
    return 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)
