"""Builds a synthetic Top-5 voiceover with KNOWN sentence timings, for measuring M1 drift.

Uses the Windows built-in SAPI voice (no internet, no extra installs). Output in --out-dir:
  script.txt      the exact script (for script mode)
  voiceover.mp3   the narration
  truth.json      ground-truth start/end of every sentence
This is test data only, never content for a real video.
"""

import argparse
import json
import random
import re
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import numpy as np

SR = 22050

FEATURES = [
    "a smooth action", "a rugged polymer stock", "a crisp trigger", "excellent reliability",
    "a corrosion-resistant finish", "solid build quality", "a comfortable grip", "low recoil",
    "a lightweight frame", "simple maintenance", "great accuracy out of the box", "a lifetime warranty",
]
USES = ["home defense", "deer season", "duck hunting", "a bug-out bag", "backcountry camping",
        "range days", "upland birds", "emergency preparedness", "long hikes", "the truck"]

INTRO = [
    "Welcome back to the channel.",
    "Today we are counting down the five best pieces of gear for hunters and preppers this year.",
    "We tested every item in this list for reliability, value, and real-world performance.",
    "Links to every product are in the description below.",
    "If you find this video helpful, consider subscribing so you never miss a review.",
]
BODY = [
    "The {p} stands out because of {f}.",
    "Many owners say the {p} feels like it costs twice as much.",
    "At around {price} dollars, it offers serious value for the money.",
    "If you need something for {u}, this is a strong pick.",
    "One thing we noticed during testing was {f}.",
    "It also comes with {f}, which beginners will appreciate.",
    "Compared to the competition, the {p} holds up really well.",
    "After several weeks of use, we did not see any major problems.",
    "The only downside is that it can be hard to find in stock.",
    "Some users wish it had {f}, but that is a minor complaint.",
    "For {u}, it is honestly hard to beat.",
    "The fit and finish are better than we expected at this price.",
    "You can pick one up for roughly {price} dollars right now.",
    "We took the {p} out for {u}, and it performed without a hiccup.",
    "Its biggest strength is {f}, and it shows every time you use it.",
    "Experienced users will appreciate {f}.",
    "That makes it a great choice for anyone getting serious about {u}.",
    "Overall, the {p} earns its spot on this list.",
]
OUTRO = [
    "And that wraps up our list of the top five.",
    "Let us know in the comments which one you would pick.",
    "Thanks for watching, and stay safe out there.",
]
NUM_WORDS = {5: "five", 4: "four", 3: "three", 2: "two", 1: "one"}

# How SAPI should pronounce things the script writes as symbols.
SPEAK_AS = {"10/22": "ten twenty-two", "M&P": "M and P", "P365": "P three sixty-five", "M4": "M four"}


def build_script(products: list[str], minutes: float, rng: random.Random) -> list[list[str]]:
    target_words = int(minutes * 60 * 2.5)
    picks = rng.sample(products, 5)
    per_item = (target_words - 120) // 5
    paragraphs = [INTRO[:]]
    for n, product in zip([5, 4, 3, 2, 1], picks):
        paragraphs.append([f"Number {NUM_WORDS[n]}. The {product}."])
        words = 0
        recent: list[str] = []
        while words < per_item:
            para = []
            for _ in range(rng.randint(3, 6)):
                # Real narration does not repeat the same sentence back to back; Whisper drops such repeats.
                template = rng.choice([b for b in BODY if b not in recent])
                recent = (recent + [template])[-8:]
                s = template.format(p=product, f=rng.choice(FEATURES), u=rng.choice(USES),
                                           price=rng.choice([199, 249, 329, 399, 449, 499, 549, 699, 899]))
                para.append(s)
                words += len(s.split())
            paragraphs.append(para)
    paragraphs.append(OUTRO[:])
    return paragraphs


def speak_text(s: str) -> str:
    for k, v in SPEAK_AS.items():
        s = s.replace(k, v)
    return s


def synthesize(sentences: list[str], tts_dir: Path) -> None:
    """One PowerShell process renders every sentence to its own wav via System.Speech."""
    tts_dir.mkdir(parents=True, exist_ok=True)
    lst = tts_dir / "sentences.json"
    lst.write_text(json.dumps([speak_text(s) for s in sentences]), encoding="utf-8")
    ps = f"""
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.Rate = 1
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo({SR}, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$items = Get-Content -Raw -Encoding UTF8 '{lst}' | ConvertFrom-Json
for ($i = 0; $i -lt $items.Count; $i++) {{
  $s.SetOutputToWaveFile((Join-Path '{tts_dir}' ('s{{0:D4}}.wav' -f $i)), $fmt)
  $s.Speak($items[$i])
}}
$s.SetOutputToNull()
"""
    script = tts_dir / "synth.ps1"
    script.write_text(ps, encoding="utf-8-sig")
    subprocess.run(["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script)], check=True)


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--glossary", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--ffmpeg", required=True)
    ap.add_argument("--minutes", type=float, default=25)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    products = [l.strip() for l in Path(args.glossary).read_text(encoding="utf-8").splitlines()
                if l.strip() and not l.startswith("#")]
    paragraphs = build_script(products, args.minutes, rng)

    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    (out / "script.txt").write_text("\n\n".join(" ".join(p) for p in paragraphs) + "\n", encoding="utf-8")

    flat = [(s, pi) for pi, p in enumerate(paragraphs) for s in p]
    print(f"Synthesizing {len(flat)} sentences with Windows SAPI ...", flush=True)
    with tempfile.TemporaryDirectory() as tmp:
        tts_dir = Path(tmp)
        synthesize([s for s, _ in flat], tts_dir)

        thresh = int(0.02 * 32767)
        chunks: list[np.ndarray] = []
        truth = []
        pos = int(0.8 * SR)  # lead-in silence
        chunks.append(np.zeros(pos, dtype=np.int16))
        for i, (text, para) in enumerate(flat):
            clip = read_wav(tts_dir / f"s{i:04d}.wav")
            loud = np.nonzero(np.abs(clip.astype(np.int32)) > thresh)[0]
            on, off = int(loud[0]), int(loud[-1])
            clip = clip[max(0, on - int(0.01 * SR)): off + int(0.05 * SR)]
            start = pos + min(on, int(0.01 * SR))
            truth.append({"id": i, "text": text, "paragraph": para,
                          "start": round(start / SR, 3), "end": round((start + off - on) / SR, 3)})
            chunks.append(clip)
            pos += len(clip)
            next_para = i + 1 < len(flat) and flat[i + 1][1] != para
            gap = int(rng.uniform(0.9, 1.6) * SR) if next_para else int(rng.uniform(0.25, 0.7) * SR)
            chunks.append(np.zeros(gap, dtype=np.int16))
            pos += gap

    audio = np.concatenate(chunks).astype(np.float32)
    # Quiet room-noise floor (~-55 dBFS) so silence is not perfect digital zero.
    audio += np.random.default_rng(args.seed).normal(0, 32767 * 10 ** (-55 / 20), audio.shape).astype(np.float32)
    audio = np.clip(audio, -32768, 32767).astype(np.int16)

    wav_path = out / "voiceover_test.wav"
    with wave.open(str(wav_path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(audio.tobytes())
    mp3_path = out / "voiceover.mp3"
    subprocess.run([args.ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(wav_path),
                    "-c:a", "libmp3lame", "-b:a", "192k", str(mp3_path)], check=True)
    wav_path.unlink()

    duration = len(audio) / SR
    (out / "truth.json").write_text(json.dumps({"duration": round(duration, 3), "sentences": truth}, indent=1),
                                    encoding="utf-8")
    words = sum(len(s.split()) for s, _ in flat)
    print(f"Done: {duration / 60:.1f} min, {len(flat)} sentences, {words} words -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
