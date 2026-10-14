"""Per-shot QA: PySceneDetect (AdaptiveDetector, BSD-3) + CLIP zero-shot shot labels + motion.

Every file is cut into shots; each shot gets 3 frames (25/50/75%), CLIP probabilities over the
prompts below (softmax of 100*cos, averaged over the frames), a mean image embedding (for repeat
detection), the share of moving frames (motion_score.py) and a verdict:
  talking   p(talking) >= 0.45, or p(talking)+p(range) >= 0.8 with a face found  -> reject
  static    fewer than half of the frames move (>2% pixels changed)               -> reject
  text      p(text) >= 0.6, or a text-card look (high edge density)              -> flag
  closeup   p(closeup) >= 0.6, or p(closeup)+p(table) >= 0.7
  uncertain best label below 0.5                                                  -> ask Haiku
  accept    otherwise (label = best prompt; "confident" when >= 0.6)

  python shot_qa.py --job job.json --out out.json --models-dir models/fastembed [--ffmpeg ffmpeg]
job: {"category": "pistol", "files": [{"key": "...", "path": "..."}], "cache_dir": "...",
      "min_scene_len": 12, "embeddings": true}
out: {"files": {key: {"duration", "shots": [{start,end,label,probs,verdict,moving,face,edge,emb?}],
      "talking_share", "static_share", "closeup_share"}}}
Results are cached per file (path + size + mtime) in cache_dir.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from motion_score import SAMPLE_FPS, motion_series  # noqa: E402

VERSION = "shotqa-1"
LABELS = ["closeup", "talking", "range", "hands", "table", "text"]


def prompts(cat: str) -> dict:
    c = cat or "product"
    gun = c in ("pistol", "handgun", "gun", "revolver", "rifle", "shotgun")
    return {
        "closeup": f"a close-up photo of a {c}",
        "talking": "a person talking to the camera",
        "range": f"a person shooting a {c} at a shooting range" if gun else f"a person using a {c} outdoors",
        "hands": f"hands holding a {c}",
        "table": f"a {c} lying on a table",
        "text": "a screen with text graphics or a title card",
    }


def emit(event: str, **d) -> None:
    print(json.dumps({"event": event, **d}), flush=True)


def secs(tc) -> float:
    v = getattr(tc, "seconds", None)
    return float(v) if v is not None and not callable(v) else float(tc.get_seconds())


def detect_shots(path: str, min_len: int) -> tuple:
    from scenedetect import AdaptiveDetector, SceneManager, open_video

    video = open_video(path)
    dur = secs(video.duration) if video.duration else 0.0
    sm = SceneManager()
    sm.add_detector(AdaptiveDetector(min_scene_len=min_len))
    sm.detect_scenes(video, show_progress=False)
    spans = [(secs(s), secs(e)) for s, e in sm.get_scene_list()]
    return (spans or [(0.0, dur)]), dur


def grab(ffmpeg: str, video: str, t: float, out: Path) -> bool:
    if out.exists() and out.stat().st_size > 0:
        return True
    r = subprocess.run([ffmpeg, "-v", "error", "-y", "-ss", f"{max(0, t):.2f}", "-i", video, "-frames:v", "1", "-vf", "scale=384:-2", "-q:v", "5", str(out)], capture_output=True, timeout=60)
    return r.returncode == 0 and out.exists()


_FACE = None


def face_and_edges(frame: str) -> tuple:
    global _FACE
    try:
        import cv2
    except ImportError:
        return False, 0.0
    img = cv2.imread(frame)
    if img is None:
        return False, 0.0
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    edge = float((cv2.Canny(g, 100, 200) > 0).mean())
    if _FACE is None:
        try:
            _FACE = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
        except Exception:  # some opencv builds ship without the Haar cascades
            _FACE = False
    if not _FACE or _FACE.empty():
        return False, edge
    faces = _FACE.detectMultiScale(g, 1.1, 5, minSize=(max(24, g.shape[1] // 14),) * 2)
    return len(faces) > 0, edge


def verdict(p: dict, face: bool, moving: float, edge: float) -> tuple:
    best = max(LABELS, key=lambda k: p[k])
    if p["talking"] >= 0.45 or (p["talking"] + p["range"] >= 0.8 and face and p["talking"] >= 0.2):
        return "talking", "talking"
    if moving < 0.5:
        return best, "static"
    if p["text"] >= 0.6 or (edge >= 0.14 and p["text"] >= 0.25):
        return "text", "text"
    if p["closeup"] >= 0.6 or p["closeup"] + p["table"] >= 0.7:
        return "closeup", "closeup"
    if p[best] < 0.5:
        return best, "uncertain"
    return best, "accept"


def file_key(path: str) -> str:
    st = os.stat(path)
    return hashlib.sha1(f"{VERSION}|{os.path.abspath(path)}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:16]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    a = ap.parse_args()
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    job = json.load(open(a.job, encoding="utf-8-sig"))
    cache = Path(job.get("cache_dir") or "cache/shot_qa")
    (cache / "frames").mkdir(parents=True, exist_ok=True)
    min_len = int(job.get("min_scene_len", 12))
    want_emb = bool(job.get("embeddings", True))
    texts = prompts(job.get("category", ""))
    t0 = time.time()
    results, todo = {}, []
    for f in job.get("files", []):
        p = f["path"]
        if not os.path.exists(p):
            continue
        ck = cache / f"{file_key(p)}.json"
        if ck.exists():
            results[f["key"]] = json.load(open(ck, encoding="utf-8"))
        else:
            todo.append((f["key"], p, ck))
    emit("start", cached=len(results), todo=len(todo))
    if todo:
        from fastembed import ImageEmbedding, TextEmbedding

        tm = TextEmbedding("Qdrant/clip-ViT-B-32-text", cache_dir=a.models_dir)
        im = ImageEmbedding("Qdrant/clip-ViT-B-32-vision", cache_dir=a.models_dir)
        tv = np.stack([np.asarray(v, dtype=np.float32) for v in tm.embed([texts[k] for k in LABELS])])
        tv /= np.linalg.norm(tv, axis=1, keepdims=True) + 1e-9
        for n, (key, path, ck) in enumerate(todo):
            try:
                spans, dur = detect_shots(path, min_len)
            except Exception as e:  # unreadable file: report, keep going
                results[key] = {"error": str(e)[:200], "shots": []}
                continue
            motion = motion_series(a.ffmpeg, path)
            stem = hashlib.sha1(path.encode()).hexdigest()[:10]
            shots = []
            for i, (s, e) in enumerate(spans):
                frames = []
                for k, fr in enumerate((0.25, 0.5, 0.75)):
                    out = cache / "frames" / f"{stem}_{i:03d}_{k}.jpg"
                    if grab(a.ffmpeg, path, s + (e - s) * fr, out):
                        frames.append(str(out))
                if not frames:
                    continue
                vecs = np.stack([np.asarray(v, dtype=np.float32) for v in im.embed(frames)])
                vecs /= np.linalg.norm(vecs, axis=1, keepdims=True) + 1e-9
                logits = 100.0 * vecs @ tv.T
                ex = np.exp(logits - logits.max(axis=1, keepdims=True))
                probs = (ex / ex.sum(axis=1, keepdims=True)).mean(axis=0)
                p = {k: round(float(v), 3) for k, v in zip(LABELS, probs)}
                fe = [face_and_edges(fr) for fr in frames]
                face = sum(1 for x in fe if x[0]) >= 2 or (len(fe) == 1 and fe[0][0])
                edge = float(np.mean([x[1] for x in fe]))
                seg = motion[int(s * SAMPLE_FPS): max(int(s * SAMPLE_FPS) + 1, int(e * SAMPLE_FPS))]
                moving = (sum(1 for v in seg[1:] if v > 0.02) / max(1, len(seg) - 1)) if len(seg) > 1 else 1.0
                label, v = verdict(p, face, moving, edge)
                shot = {"start": round(s, 2), "end": round(e, 2), "label": label, "verdict": v, "probs": p, "moving": round(moving, 3), "face": bool(face), "edge": round(edge, 3), "frames": frames}
                if want_emb:
                    m = vecs.mean(axis=0)
                    shot["emb"] = [round(float(x), 4) for x in m / (np.linalg.norm(m) + 1e-9)]
                shots.append(shot)
            tot = sum(x["end"] - x["start"] for x in shots) or 1.0
            share = lambda v: round(sum(x["end"] - x["start"] for x in shots if x["verdict"] == v) / tot, 3)  # noqa: E731
            res = {"duration": round(dur, 2), "shots": shots, "motion_fps": SAMPLE_FPS, "motion": motion,
                   "talking_share": share("talking"), "static_share": share("static"), "closeup_share": share("closeup")}
            json.dump(res, open(ck, "w", encoding="utf-8"))
            results[key] = res
            emit("progress", done=n + 1, total=len(todo))
    json.dump({"files": results, "labels": LABELS, "prompts": texts, "version": VERSION}, open(a.out, "w", encoding="utf-8"))
    emit("done", files=len(results), seconds=round(time.time() - t0, 1))
    return 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)
