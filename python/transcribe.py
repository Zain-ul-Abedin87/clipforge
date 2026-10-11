"""ClipForge step 1: faster-whisper transcription with word timestamps.

Writes words.json: [{"word", "start", "end", "prob"}] plus segments.json.
Progress is printed as JSON lines on stdout so the Node orchestrator can relay it.
"""

import argparse
import json
import os
import sys
import time
from pathlib import Path


def add_cuda_dll_dirs() -> None:
    """pip's nvidia-* wheels ship DLLs that Windows will not find on its own."""
    if os.name != "nt":
        return
    import importlib.util

    for pkg in ("nvidia.cublas", "nvidia.cudnn", "nvidia.cuda_runtime"):
        try:
            spec = importlib.util.find_spec(pkg)
        except ModuleNotFoundError:
            continue
        if spec and spec.submodule_search_locations:
            bin_dir = Path(list(spec.submodule_search_locations)[0]) / "bin"
            if bin_dir.is_dir():
                os.add_dll_directory(str(bin_dir))
                os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ["PATH"]


def emit(event: str, **data) -> None:
    print(json.dumps({"event": event, **data}), flush=True)


def peak_ram_mb() -> float | None:
    """Peak working set of this process (Windows only)."""
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    class PMC(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (n, ctypes.c_size_t)
            for n in ("PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage",
                      "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage")
        ]

    pmc = PMC()
    pmc.cb = ctypes.sizeof(PMC)
    k32 = ctypes.WinDLL("kernel32")
    k32.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi")
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD]
    if not psapi.GetProcessMemoryInfo(k32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
        return None
    return round(pmc.PeakWorkingSetSize / 1024 / 1024, 1)


def load_glossary(path: str | None) -> list[str]:
    if not path or not Path(path).is_file():
        return []
    terms = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            terms.append(line)
    return terms


SR = 16000


def plan_chunks(audio, target_s: float) -> list[tuple[float, float]]:
    """Cut points near every `target_s` seconds, snapped to the quietest 0.3 s within +-15 s."""
    import numpy as np

    total = len(audio) / SR
    if total <= target_s * 1.3:
        return [(0.0, total)]
    win = int(0.3 * SR)
    cuts = [0.0]
    t = target_s
    while t < total - target_s * 0.3:
        lo, hi = int(max(0, t - 15) * SR), int(min(total, t + 15) * SR)
        seg = audio[lo:hi]
        n = len(seg) // win
        rms = np.sqrt((seg[: n * win].reshape(n, win) ** 2).mean(axis=1))
        best = lo + int(np.argmin(rms)) * win + win // 2
        cuts.append(best / SR)
        t = best / SR + target_s
    cuts.append(total)
    return [(round(a, 3), round(b, 3)) for a, b in zip(cuts, cuts[1:])]


def refine_onsets(words: list[dict], audio) -> int:
    """Snap word starts that follow a pause to the real voice onset.

    Whisper (with VAD padding) puts the first word after a pause ~0.3 s early: the word absorbs
    the leading silence. We move such starts forward to where the audio energy actually rises.
    Starts only ever move later, never past the word's end.
    """
    import numpy as np

    hop = int(0.01 * SR)
    n = len(audio) // hop
    rms = np.sqrt((audio[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    noise = float(np.percentile(rms, 10))
    speech = float(np.percentile(rms, 90))
    thr = max(noise * 4, noise + 0.12 * (speech - noise), 1e-4)

    moved = 0
    for k, w in enumerate(words):
        prev_end = words[k - 1]["end"] if k else 0.0
        # Whisper often stretches the previous word over the pause, so a sentence-initial word
        # (previous word ends in punctuation) is checked even when the word times touch.
        after_punct = k > 0 and words[k - 1]["word"][-1:] in ".!?,;:"
        stretched = w["end"] - w["start"] > 0.6
        if k and w["start"] - prev_end < 0.08 and not (after_punct or stretched):
            continue  # continuous speech: no silence to absorb
        lo = int(w["start"] / 0.01)
        hi = min(n - 2, int(min(w["end"] - 0.05, w["start"] + 1.2) / 0.01))
        # The word may begin inside the previous word's tail; the real onset is the first
        # silence(>=120 ms)->voice edge. A start already at the onset (silence before it) has no
        # such edge inside the word and is left alone.
        silent = 12 if k == 0 or w["start"] - prev_end >= 0.12 else 0
        for f in range(lo, hi):
            if rms[f] > thr and rms[f + 1] > thr:
                if silent >= 12:
                    onset = round(max(w["start"], f * 0.01 - 0.02), 3)
                    if onset > w["start"] + 0.02:
                        w["start"] = onset
                        moved += 1
                    break
                silent = 0
            else:
                silent += 1
    return moved


def find_skipped_spans(words: list[dict], audio, duration: float) -> list[tuple[float, float]]:
    """Spans where Whisper skipped speech: a word stretched over 3 s+, or a 3 s+ gap between words,
    while the audio there is mostly voiced. (Whisper sometimes jumps its timestamps past a passage.)"""
    import numpy as np

    hop = int(0.01 * SR)
    n = len(audio) // hop
    rms = np.sqrt((audio[: n * hop].reshape(n, hop) ** 2).mean(axis=1))
    noise = float(np.percentile(rms, 10))
    speech = float(np.percentile(rms, 90))
    thr = max(noise * 4, noise + 0.12 * (speech - noise), 1e-4)

    def voiced(a: float, b: float) -> float:
        seg = rms[int(a / 0.01): max(int(a / 0.01) + 1, int(b / 0.01))]
        return float((seg > thr).mean()) if len(seg) else 0.0

    spans: list[tuple[float, float]] = []
    edges = [(0.0, words[0]["start"] if words else duration)]
    edges += [(w["start"], w["end"]) for w in words if w["end"] - w["start"] > 3.0]
    edges += [(a["end"], b["start"]) for a, b in zip(words, words[1:]) if b["start"] - a["end"] > 3.0]
    if words:
        edges.append((words[-1]["end"], duration))
    for i, (a, b) in enumerate(edges):
        # The very start is checked from 1.5 s: a skipped opening line is the most visible miss.
        if b - a > (1.5 if i == 0 else 3.0) and voiced(a, b) > 0.35:
            spans.append((max(0.0, a - 0.3), min(duration, b + 0.3)))
    return spans


def repair_skips(words: list[dict], audio, duration: float, get_model, language: str, prompt: str | None) -> int:
    """Re-transcribes skipped spans on their own (CPU, so a flaky GPU cannot abort the run) and
    splices the recovered words in. Returns how many spans were repaired."""
    spans = find_skipped_spans(words, audio, duration)
    repaired = 0
    for a, b in spans:
        model = get_model("cpu")
        segs, _ = model.transcribe(
            audio[int(a * SR): int(b * SR)],
            language=language,
            word_timestamps=True,
            vad_filter=False,
            initial_prompt=prompt,
            condition_on_previous_text=False,
            beam_size=5,
        )
        new = [
            {"word": w.word.strip(), "start": round(w.start + a, 3), "end": round(w.end + a, 3), "prob": round(w.probability, 3)}
            for s in segs for w in (s.words or []) if w.word.strip()
        ]
        if len(new) < 2:
            continue
        # Drop old words inside the span (and the stretched word that covered it), insert the new ones.
        kept = [w for w in words if w["end"] <= a + 0.05 or w["start"] >= b - 0.05]
        words[:] = sorted(kept + new, key=lambda w: w["start"])
        repaired += 1
        emit("repaired_span", start=round(a, 1), end=round(b, 1), words=len(new))
    return repaired


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--glossary")
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--compute-type", default="int8_float16")
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--language", default="en")
    ap.add_argument("--chunk-seconds", type=float, default=300)
    ap.add_argument("--cpu-chunks", default="", help="comma list of chunk indexes to run on CPU")
    ap.add_argument("--condition-on-previous", action="store_true",
                    help="feed previous text as context (keeps names consistent, small loop risk)")
    args = ap.parse_args()

    # cuda_malloc_async (the CT2 default) aborted the process on this laptop; the caching allocator is stable.
    os.environ.setdefault("CT2_CUDA_ALLOCATOR", "cub_caching")
    add_cuda_dll_dirs()
    from faster_whisper import WhisperModel, decode_audio

    terms = load_glossary(args.glossary)
    # Whisper's prompt window is ~224 tokens; keep the glossary hint well under that.
    glossary_hint = ", ".join(terms)[:600] if terms else None
    initial_prompt = (
        f"A product review video about guns, hunting and survival gear. Products: {glossary_hint}."
        if glossary_hint
        else None
    )

    t0 = time.time()
    out = Path(args.out_dir)
    chunk_dir = out / "chunks"
    chunk_dir.mkdir(parents=True, exist_ok=True)

    audio = decode_audio(args.audio, sampling_rate=SR)
    duration = len(audio) / SR

    # The chunk plan is saved so a restarted process cuts at exactly the same places.
    plan_file = chunk_dir / "plan.json"
    plan_key = {"audio": os.path.getsize(args.audio), "chunk_seconds": args.chunk_seconds}
    plan = json.loads(plan_file.read_text()) if plan_file.exists() else None
    if not plan or plan.get("key") != plan_key:
        for old in chunk_dir.glob("chunk_*.json"):
            old.unlink()
        plan = {"key": plan_key, "chunks": plan_chunks(audio, args.chunk_seconds)}
        plan_file.write_text(json.dumps(plan))
    chunks = plan["chunks"]
    cpu_chunks = {int(x) for x in args.cpu_chunks.split(",") if x.strip()}

    todo = [i for i in range(len(chunks)) if not (chunk_dir / f"chunk_{i:03d}.json").exists()]
    emit("plan", chunks=len(chunks), remaining=len(todo), duration=round(duration, 1))

    models: dict[str, object] = {}

    def get_model(device: str):
        if device not in models:
            ctype = args.compute_type if device == "cuda" else "int8"
            emit("loading_model", model=args.model, device=device, compute_type=ctype)
            t = time.time()
            models[device] = WhisperModel(args.model, device=device, compute_type=ctype, download_root=args.models_dir)
            emit("model_loaded", device=device, seconds=round(time.time() - t, 1))
        return models[device]

    for i in todo:
        start, end = chunks[i]
        device = "cpu" if i in cpu_chunks or args.device == "cpu" else "cuda"
        emit("chunk_start", index=i, start=start, end=end, device=device)
        model = get_model(device)
        segs, _ = model.transcribe(
            audio[int(start * SR): int(end * SR)],
            language=args.language,
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 500},
            # The glossary prompt is re-applied at the start of every chunk.
            initial_prompt=initial_prompt,
            # No `hotwords`: with ctranslate2 4.8 on Windows it aborted the process mid-file.
            condition_on_previous_text=args.condition_on_previous,
            beam_size=5,
        )
        words, segments = [], []
        for seg in segs:
            segments.append({"start": round(seg.start + start, 3), "end": round(seg.end + start, 3), "text": seg.text.strip()})
            for w in seg.words or []:
                text = w.word.strip()
                if text:
                    words.append({"word": text, "start": round(w.start + start, 3), "end": round(w.end + start, 3),
                                  "prob": round(w.probability, 3)})
        # Written only after the whole chunk succeeded, so a crash never leaves a half chunk.
        tmp = chunk_dir / f"chunk_{i:03d}.tmp"
        tmp.write_text(json.dumps({"words": words, "segments": segments}), encoding="utf-8")
        tmp.replace(chunk_dir / f"chunk_{i:03d}.json")
        emit("progress", position=round(end, 1), duration=round(duration, 1), chunk=i, device=device)

    words, segments = [], []
    for i in range(len(chunks)):
        data = json.loads((chunk_dir / f"chunk_{i:03d}.json").read_text(encoding="utf-8"))
        words += data["words"]
        segments += data["segments"]
    repaired = repair_skips(words, audio, duration, get_model, args.language, initial_prompt)
    if repaired:
        emit("skips_repaired", spans=repaired)
    moved = refine_onsets(words, audio)
    emit("onsets_refined", words_moved=moved)
    (out / "words.json").write_text(json.dumps(words, indent=1), encoding="utf-8")
    (out / "segments.json").write_text(json.dumps(segments, indent=1), encoding="utf-8")

    emit(
        "done",
        words=len(words),
        segments=len(segments),
        audio_seconds=round(duration, 1),
        elapsed_seconds=round(time.time() - t0, 1),
        peak_ram_mb=peak_ram_mb(),
    )
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except RuntimeError as err:
        # CUDA errors poison the context; report and let the orchestrator restart a fresh process.
        emit("cuda_error" if "cuda" in str(err).lower() else "error", message=str(err)[:300])
        code = 3
    sys.stdout.flush()
    # Skip interpreter teardown: CUDA library unload can crash on Windows after the work is done.
    os._exit(code)
