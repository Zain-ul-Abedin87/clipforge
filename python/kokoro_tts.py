"""Kokoro TTS worker for ClipForge (local, free, Apache-2.0 model).

Install once (in the ClipForge .venv):
    pip install kokoro-onnx soundfile
and download the model files (https://github.com/thewh1teagle/kokoro-onnx/releases):
    kokoro-v1.0.onnx  and  voices-v1.0.bin   -> models/kokoro/

Protocol (one process for the whole script, the model loads once):
    stdout first line: {"ready": true, "voices": [...]}
    stdin, one JSON per line: {"text": "...", "out": "C:/.../x.wav", "voice": "am_michael", "speed": 1.0}
    stdout, one JSON per line: {"ok": true, "seconds": 3.2} or {"ok": false, "error": "..."}
"""
import json
import os
import sys


def main() -> int:
    model = sys.argv[1] if len(sys.argv) > 1 else os.path.join("models", "kokoro", "kokoro-v1.0.onnx")
    voices = sys.argv[2] if len(sys.argv) > 2 else os.path.join("models", "kokoro", "voices-v1.0.bin")
    try:
        import soundfile as sf
        from kokoro_onnx import Kokoro
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ready": False, "error": f"kokoro-onnx / soundfile not installed: {e} (pip install kokoro-onnx soundfile)"}), flush=True)
        return 2
    if not os.path.exists(model) or not os.path.exists(voices):
        print(json.dumps({"ready": False, "error": f"model files missing: {model} / {voices}"}), flush=True)
        return 2
    kokoro = Kokoro(model, voices)
    try:
        names = sorted(kokoro.get_voices())
    except Exception:  # noqa: BLE001
        names = []
    print(json.dumps({"ready": True, "voices": names}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            job = json.loads(line)
            samples, rate = kokoro.create(job["text"], voice=job.get("voice", "am_michael"), speed=float(job.get("speed", 1.0)), lang=job.get("lang", "en-us"))
            sf.write(job["out"], samples, rate)
            print(json.dumps({"ok": True, "seconds": round(len(samples) / rate, 3)}), flush=True)
        except Exception as e:  # noqa: BLE001
            print(json.dumps({"ok": False, "error": str(e)[:300]}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
