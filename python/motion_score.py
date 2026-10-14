"""Motion score per frame, auto-editor style (idea from WyattBlue/auto-editor, Unlicense).

Each frame is scaled to 400 px wide, turned grey and blurred (gblur sigma 9); its motion value is
the share of pixels that differ from the previous frame. A frame counts as "moving" above 2%.
A window is "static" when more than half of its frames are below that threshold.

  python motion_score.py --video clip.mp4 [--start 0] [--dur 0] [--window 2.5] [--step 0.5]
                         [--threshold 0.02] [--ffmpeg ffmpeg]
Prints one JSON line: {"ok": true, "fps": 10, "motion": [...], "windows": [{"start", "end", "moving", "static"}]}

Also importable: motion_series(ffmpeg, video, start, dur) -> list[float].
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys

import numpy as np

W = 400
SAMPLE_FPS = 10
# auto-editor counts exactly-equal grey bytes; a 2-level tolerance keeps codec noise on still
# shots from looking like motion.
TOL = 2


def motion_series(ffmpeg: str, video: str, start: float = 0.0, dur: float = 0.0, fps: int = SAMPLE_FPS) -> list:
    args = [ffmpeg, "-v", "error"]
    if start > 0:
        args += ["-ss", f"{start:.3f}"]
    args += ["-i", video]
    if dur > 0:
        args += ["-t", f"{dur:.3f}"]
    args += ["-an", "-vf", f"fps={fps},scale={W}:-2,format=gray,gblur=sigma=9", "-f", "rawvideo", "-pix_fmt", "gray", "-"]
    # Height from a probe-free route: decode once, infer from byte count with a 16:9 guess fallback.
    r = subprocess.run(args, capture_output=True, timeout=300)
    raw = r.stdout
    if r.returncode != 0 or not raw:
        return []
    h = _height(ffmpeg, video)
    frame = W * h
    n = len(raw) // frame if frame else 0
    if n < 2:
        return [0.0] * n
    a = np.frombuffer(raw[: n * frame], dtype=np.uint8).reshape(n, h, W).astype(np.int16)
    d = np.abs(np.diff(a, axis=0)) > TOL
    vals = d.reshape(n - 1, -1).mean(axis=1)
    return [float(vals[0])] + [round(float(v), 4) for v in vals]


_H = {}


def _height(ffmpeg: str, video: str) -> int:
    if video in _H:
        return _H[video]
    r = subprocess.run([ffmpeg, "-v", "error", "-i", video, "-frames:v", "1", "-vf", f"scale={W}:-2,format=gray", "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True, timeout=60)
    h = max(2, len(r.stdout) // W) if r.stdout else 226
    _H[video] = h
    return h


def windows(motion: list, fps: int, win: float, step: float, threshold: float) -> list:
    out = []
    total = len(motion) / fps if fps else 0
    t = 0.0
    while t + win <= total + 1e-6 or (not out and total > 0):
        a, b = int(t * fps), max(int(t * fps) + 1, int(min(total, t + win) * fps))
        seg = motion[a:b]
        moving = sum(1 for v in seg if v > threshold) / max(1, len(seg))
        out.append({"start": round(t, 2), "end": round(min(total, t + win), 2), "moving": round(moving, 3), "static": moving < 0.5})
        t += step
        if t + win > total + 1e-6:
            break
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--start", type=float, default=0.0)
    ap.add_argument("--dur", type=float, default=0.0)
    ap.add_argument("--window", type=float, default=2.5)
    ap.add_argument("--step", type=float, default=0.5)
    ap.add_argument("--threshold", type=float, default=0.02)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    a = ap.parse_args()
    m = motion_series(a.ffmpeg, a.video, a.start, a.dur)
    if not m:
        print(json.dumps({"ok": False, "error": "could not decode video"}))
        return 1
    print(json.dumps({"ok": True, "fps": SAMPLE_FPS, "motion": m, "windows": windows(m, SAMPLE_FPS, a.window, a.step, a.threshold)}))
    return 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)
