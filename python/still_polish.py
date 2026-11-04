"""Cuts a product photo out of its background (rembg) and reports how much of the picture it kept.

Usage: still_polish.py <in> <out.png> <model> <min_cover> <max_cover>
Prints one JSON line: {"ok": true, "cover": 0.42} or {"ok": false, "cover": 0.97, "reason": "..."}.
A cut fails (no file is written) when it keeps almost nothing or almost everything, when the model
was unsure about much of the picture (MAX_SOFT of it half-transparent), or when the kept part has the
same colour as what was removed (MIN_CONTRAST): measured on a real u2net run, a product on a studio
background gave 0.9% unsure / colour distance 310, an empty background 99% / 0.
Models: u2net (default, code Apache-2.0), isnet-general-use, birefnet-general ... Never bria-rmbg on
a monetised channel: its weights need a paid licence for commercial use (rembg README).
"""
import json
import sys

MAX_SOFT = 0.25
MIN_CONTRAST = 12.0


def colour_distance(img, alpha) -> float:
    """Distance between the mean colours of the kept and the removed pixels (0-441)."""
    from PIL import ImageStat
    rgb = img.convert("RGB")
    keep = alpha.point(lambda a: 255 if a >= 128 else 0)
    drop = alpha.point(lambda a: 255 if a < 128 else 0)
    if not keep.getbbox() or not drop.getbbox():
        return 0.0
    k = ImageStat.Stat(rgb, keep).mean
    d = ImageStat.Stat(rgb, drop).mean
    return sum((x - y) ** 2 for x, y in zip(k, d)) ** 0.5


def main() -> int:
    src, out, model = sys.argv[1], sys.argv[2], sys.argv[3]
    lo, hi = float(sys.argv[4]), float(sys.argv[5])
    try:
        from PIL import Image
        from rembg import new_session, remove
    except ImportError as e:
        print(json.dumps({"ok": False, "reason": f"rembg is not installed ({e}): pip install \"rembg[cpu]\" (or rembg[gpu])"}))
        return 3
    img = Image.open(src).convert("RGBA")
    cut = remove(img, session=new_session(model))
    alpha = cut.getchannel("A")
    hist = alpha.histogram()
    total = img.width * img.height
    cover = sum(hist[128:]) / max(1, total)
    if cover < lo or cover > hi:
        print(json.dumps({"ok": False, "cover": round(cover, 4), "reason": f"cut kept {cover:.0%} of the picture (allowed {lo:.0%}-{hi:.0%})"}))
        return 0
    soft = sum(hist[17:240]) / max(1, total)
    if soft > MAX_SOFT:
        print(json.dumps({"ok": False, "cover": round(cover, 4), "reason": f"the model was unsure about {soft:.0%} of the picture"}))
        return 0
    contrast = colour_distance(img, alpha)
    if contrast < MIN_CONTRAST:
        print(json.dumps({"ok": False, "cover": round(cover, 4), "reason": f"the kept part looks like its background (colour distance {contrast:.0f})"}))
        return 0
    # Trim the empty border so the product fills its box in the showcase.
    box = alpha.point(lambda a: 255 if a >= 16 else 0).getbbox()
    if box:
        cut = cut.crop(box)
    cut.save(out)
    print(json.dumps({"ok": True, "cover": round(cover, 4)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
