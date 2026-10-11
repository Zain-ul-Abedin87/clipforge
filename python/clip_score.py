"""Scores how well candidate images match scene text with CLIP (ONNX via fastembed, no torch).

Input  (--job file):  {"texts": {key: text}, "images": {key: path}, "pairs": [[text_key, image_key], ...]}
Output (--out file):  {"scores": {"text_key|image_key": cosine_similarity}}
Progress is printed as JSON lines.
"""

import argparse
import json
import os
import sys
import time

import numpy as np


def emit(event: str, **data) -> None:
    print(json.dumps({"event": event, **data}), flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--models-dir", required=True)
    args = ap.parse_args()

    # Same reason as the Whisper download: the xet backend stalled on this network.
    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    from fastembed import ImageEmbedding, TextEmbedding

    job = json.load(open(args.job, encoding="utf-8"))
    t0 = time.time()
    emit("loading_model")
    text_model = TextEmbedding("Qdrant/clip-ViT-B-32-text", cache_dir=args.models_dir)
    image_model = ImageEmbedding("Qdrant/clip-ViT-B-32-vision", cache_dir=args.models_dir)
    emit("model_loaded", seconds=round(time.time() - t0, 1))

    def unit(vecs) -> dict:
        return {k: v / (np.linalg.norm(v) + 1e-9) for k, v in vecs}

    text_keys = list(job["texts"].keys())
    texts = unit(zip(text_keys, text_model.embed([job["texts"][k] for k in text_keys], batch_size=32)))

    image_keys = [k for k, p in job["images"].items() if os.path.exists(p)]
    images = {}
    # Small batches keep RAM low; a broken image file is skipped instead of failing the run.
    for i in range(0, len(image_keys), 16):
        batch = image_keys[i : i + 16]
        try:
            images.update(unit(zip(batch, image_model.embed([job["images"][k] for k in batch], batch_size=16))))
        except Exception:
            for k in batch:
                try:
                    images.update(unit(zip([k], image_model.embed([job["images"][k]]))))
                except Exception:
                    pass
        emit("progress", images=min(i + 16, len(image_keys)), total=len(image_keys))

    scores = {}
    for tk, ik in job["pairs"]:
        if tk in texts and ik in images:
            scores[f"{tk}|{ik}"] = round(float(np.dot(texts[tk], images[ik])), 4)
    json.dump({"scores": scores}, open(args.out, "w", encoding="utf-8"))
    emit("done", pairs=len(scores), seconds=round(time.time() - t0, 1))
    return 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    os._exit(code)
