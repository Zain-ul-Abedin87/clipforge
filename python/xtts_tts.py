"""XTTS-v2 worker for ClipForge: YOUR OWN voice only (a recording of you in channels/<id>/voice/).

Install once (in the ClipForge .venv, GPU build of torch recommended):
    pip install coqui-tts soundfile
The XTTS-v2 model (Coqui Public Model License: non-commercial unless licensed) downloads on first use.

Protocol: same as kokoro_tts.py.
    argv: <speaker_wav> [language]
    stdin:  {"text": "...", "out": "x.wav"}
"""
import json
import os
import sys


def main() -> int:
    speaker = sys.argv[1] if len(sys.argv) > 1 else ""
    language = sys.argv[2] if len(sys.argv) > 2 else "en"
    if not speaker or not os.path.exists(speaker):
        print(json.dumps({"ready": False, "error": f"speaker sample missing: {speaker}"}), flush=True)
        return 2
    try:
        import torch
        from TTS.api import TTS
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ready": False, "error": f"coqui-tts not installed: {e} (pip install coqui-tts)"}), flush=True)
        return 2
    device = "cuda" if torch.cuda.is_available() else "cpu"
    tts = TTS("tts_models/multilingual/multi-dataset/xtts_v2").to(device)
    print(json.dumps({"ready": True, "device": device}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
            tts.tts_to_file(text=job["text"], speaker_wav=speaker, language=language, file_path=job["out"])
            print(json.dumps({"ok": True}), flush=True)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": str(e)[:300]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
