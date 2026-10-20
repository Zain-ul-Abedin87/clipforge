"""Rejects web stills that are page screenshots or multi-product grids (shop pages).

Usage: still_check.py <json list of paths>  ->  prints {"ok": true, "results": {path: reason|null}}
Heuristics (no OCR needed): extreme aspect, screen-like size with many text-sized blobs, several
large separate objects on the background (a tile grid), dense small high-contrast specks (text).
If pytesseract is installed, page words ("add to cart", "price", ...) also reject.
"""
import json
import sys

PAGE_WORDS = ("add to cart", "add to basket", "buy now", "in stock", "free shipping", "subscribe", "sign in", "checkout", "results for", "sort by")


def components(mask):
    import numpy as np
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    sizes = []
    for y in range(h):
        for x in range(w):
            if mask[y, x] and not seen[y, x]:
                stack = [(y, x)]
                seen[y, x] = True
                n = 0
                while stack:
                    cy, cx = stack.pop()
                    n += 1
                    for ny, nx in ((cy + 1, cx), (cy - 1, cx), (cy, cx + 1), (cy, cx - 1)):
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                            seen[ny, nx] = True
                            stack.append((ny, nx))
                sizes.append(n)
    return sizes


def check(path):
    import numpy as np
    from PIL import Image
    im = Image.open(path).convert("RGB")
    w, h = im.size
    ar = w / max(1, h)
    if ar > 2.4 or ar < 0.42:
        return f"aspect {ar:.2f}"
    small = np.asarray(im.resize((96, max(8, round(96 / ar)))), dtype=np.int16)
    border = np.concatenate([small[0], small[-1], small[:, 0], small[:, -1]])
    bg = np.median(border, axis=0)
    diff = np.abs(small - bg).sum(axis=2)
    mask = diff > 60
    sizes = components(mask)
    total = mask.size
    big = [s for s in sizes if s > total * 0.02]
    specks = [s for s in sizes if s <= 6]
    border_plain = float((np.abs(border - bg).sum(axis=1) < 40).mean())
    # Tile grid: 4+ separate large objects on a plain background.
    if border_plain > 0.8 and len(big) >= 4:
        return f"grid {len(big)} tiles"
    # Text-heavy page: many tiny high-contrast specks (glyphs) at screenshot-like proportions.
    if len(specks) > 140 and 1.2 < ar < 2.0:
        return f"text-dense ({len(specks)} specks)"
    try:
        import pytesseract  # optional
        txt = pytesseract.image_to_string(im.resize((min(w, 1600), round(min(w, 1600) / ar)))).lower()
        hit = next((p for p in PAGE_WORDS if p in txt), None)
        if hit:
            return f"page text '{hit}'"
        if len(txt.split()) > 60:
            return "text-dense (ocr)"
    except Exception:
        pass
    return None


def main():
    files = json.loads(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].endswith(".json") else json.load(open(sys.argv[1], encoding="utf-8"))
    out = {}
    for f in files:
        try:
            out[f] = check(f)
        except Exception as e:  # unreadable: not usable either
            out[f] = f"unreadable {str(e)[:60]}"
    print(json.dumps({"ok": True, "results": out}))


if __name__ == "__main__":
    main()
