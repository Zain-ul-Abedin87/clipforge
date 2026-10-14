"""Scores how well candidate images match scene text with CLIP (ONNX via fastembed, no torch).

Input  (--job file):  {"texts": {key: text}, "images": {key: path | [path, ...]}, "pairs": [[text_key, image_key], ...],
                       "vectors": {key: [float, ...]}       (optional: pre-computed image embeddings, e.g. footage library),
                       "return_text_embeddings": bool, "return_image_embeddings": bool}   (optional)
Output (--out file):  {"scores": {"text_key|image_key": cosine_similarity}, "model": "...",
                       "text_embeddings"?: {key: [...]}, "image_embeddings"?: {key: [...]}}
An image key may list up to 3 frames: the score is the best frame (max); its embedding is the
normalised mean of its frames. A plain path still works (backward compatible).
CLIP_MODEL env picks the fastembed model pair: "clip-ViT-B-32" (default) or "jina-clip-v1", or an
explicit "text_model,vision_model".
Progress is printed as JSON lines.
"""

import argparse
import json
import os
import sys
import time

import numpy as np

MODELS = {
    "clip-vit-b-32": ("Qdrant/clip-ViT-B-32-text", "Qdrant/clip-ViT-B-32-vision"),
    "jina-clip-v1": ("jinaai/jina-clip-v1", "jinaai/jina-clip-v1"),
}
MAX_FRAMES = 3


def emit(event: str, **data) -> None:
    print(json.dumps({"event": event, **data}), flush=True)


def model_pair() -> tuple:
    raw = os.environ.get("CLIP_MODEL", "").strip()
    if "," in raw:
        t, v = [x.strip() for x in raw.split(",", 1)]
        return t, v
    return MODELS.get(raw.lower(), MODELS["clip-vit-b-32"])


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--models-dir", required=True)
    args = ap.parse_args()

    # Same reason as the Whisper download: the xet backend stalled on this network.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    from fastembed import ImageEmbedding, TextEmbedding

    job = json.load(open(args.job, encoding="utf-8-sig"))
    t0 = time.time()
    text_name, image_name = model_pair()
    emit("loading_model", text=text_name, vision=image_name)
    text_model = TextEmbedding(text_name, cache_dir=args.models_dir)
    image_model = None
    emit("model_loaded", seconds=round(time.time() - t0, 1))

    def norm(v):
        v = np.asarray(v, dtype=np.float32)
        return v / (np.linalg.norm(v) + 1e-9)

    text_keys = list(job.get("texts", {}).keys())
    texts = {k: norm(v) for k, v in zip(text_keys, text_model.embed([job["texts"][k] for k in text_keys], batch_size=32))} if text_keys else {}

    # key -> list of frame paths (max 3)
    frames_of = {}
    for k, p in (job.get("images") or {}).items():
        lst = [p] if isinstance(p, str) else list(p or [])
        lst = [x for x in lst if isinstance(x, str) and os.path.exists(x)][:MAX_FRAMES]
        if lst:
            frames_of[k] = lst
    flat = [(k, f) for k, fs in frames_of.items() for f in fs]
    frame_vecs = {}
    if flat:
        image_model = ImageEmbedding(image_name, cache_dir=args.models_dir)
    # Small batches keep RAM low; a broken image file is skipped instead of failing the run.
    for i in range(0, len(flat), 16):
        batch = flat[i : i + 16]
        try:
            for (k, f), v in zip(batch, image_model.embed([f for _, f in batch], batch_size=16)):
                frame_vecs.setdefault(k, []).append(norm(v))
        except Exception:
            for k, f in batch:
                try:
                    for v in image_model.embed([f]):
                        frame_vecs.setdefault(k, []).append(norm(v))
                except Exception:
                    pass
        emit("progress", images=min(i + 16, len(flat)), total=len(flat))

    for k, v in (job.get("vectors") or {}).items():
        if k not in frame_vecs and v:
            frame_vecs[k] = [norm(v)]

    scores = {}
    for tk, ik in job.get("pairs", []):
        if tk in texts and ik in frame_vecs:
            scores[f"{tk}|{ik}"] = round(max(float(np.dot(texts[tk], fv)) for fv in frame_vecs[ik]), 4)
    out = {"scores": scores, "model": f"{text_name}|{image_name}"}
    if job.get("return_text_embeddings"):
        out["text_embeddings"] = {k: [round(float(x), 5) for x in v] for k, v in texts.items()}
    if job.get("return_image_embeddings"):
        out["image_embeddings"] = {
            k: [round(float(x), 5) for x in norm(np.mean(vs, axis=0))] for k, vs in frame_vecs.items() if k in frames_of
        }
    json.dump(out, open(args.out, "w", encoding="utf-8"))
    emit("done", pairs=len(scores), seconds=round(time.time() - t0, 1))
    return 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)
