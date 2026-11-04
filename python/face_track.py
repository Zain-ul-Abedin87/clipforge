"""Where is the speaker? Face centres of a clip, for the smart 9:16 / 1:1 crop of long-video Shorts.

Usage: face_track.py <video> <start_s> <duration_s> [step_s]
Prints one JSON line: {"ok": true, "width": W, "height": H, "samples": [{"t": 0.0, "cx": 0.42, "size": 0.18}, ...]}
t is seconds from <start_s>; cx is the centre of the largest face as a share of the frame width (null
when no face is seen); size is that face's width as a share of the frame width.
OpenCV's Haar frontal-face detector (opencv-python-headless < 5: 5.0 removed it).
"""
import json

# Analysis width: 960 px still finds a small face in a wide shot (640 missed one).
AW = 960
import os
import sys


def main() -> int:
    video, start, dur = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
    step = float(sys.argv[4]) if len(sys.argv) > 4 else 0.5
    try:
        import cv2
    except ImportError as e:
        print(json.dumps({"ok": False, "reason": f"OpenCV is not installed ({e}): pip install \"opencv-python-headless>=4.8,<5\""}))
        return 3
    if not hasattr(cv2, "CascadeClassifier"):
        print(json.dumps({"ok": False, "reason": f"OpenCV {cv2.__version__} has no Haar face detector: pip install \"opencv-python-headless>=4.8,<5\""}))
        return 3
    det = cv2.CascadeClassifier(os.path.join(cv2.data.haarcascades, "haarcascade_frontalface_default.xml"))
    cap = cv2.VideoCapture(video)
    if not cap.isOpened():
        print(json.dumps({"ok": False, "reason": "the video could not be opened"}))
        return 2
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    samples = []
    t = 0.0
    while t <= dur + 1e-6:
        cap.set(cv2.CAP_PROP_POS_MSEC, (start + t) * 1000.0)
        ok, frame = cap.read()
        if not ok:
            break
        small = cv2.resize(frame, (AW, max(1, int(AW * h / max(1, w)))))
        gray = cv2.equalizeHist(cv2.cvtColor(small, cv2.COLOR_BGR2GRAY))
        faces = det.detectMultiScale(gray, scaleFactor=1.1, minNeighbors=5, minSize=(28, 28))
        if len(faces):
            x, y, fw, fh = max(faces, key=lambda f: f[2] * f[3])
            samples.append({"t": round(t, 3), "cx": round((x + fw / 2) / AW, 4), "size": round(fw / AW, 4)})
        else:
            samples.append({"t": round(t, 3), "cx": None, "size": 0})
        t += step
    cap.release()
    print(json.dumps({"ok": True, "width": w, "height": h, "samples": samples}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
