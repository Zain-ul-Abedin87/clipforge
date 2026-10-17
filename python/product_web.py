"""Best-effort product media search beyond YouTube (any niche). Never raises; prints ONE JSON line.

  python product_web.py images "<query>" [n]   -> {"ok": true, "images": [{url,width,height,source,title,provider}], "errors": [...]}
  python product_web.py videos "<query>" [n]   -> {"ok": true, "videos": [{url,title,provider,page}], "errors": [...]}

Providers (in order): Amazon (search -> product pages -> gallery hi-res images / product videos),
Google Images / Google Videos (HTML scraping, often blocked), Bing Images / Bing Videos (fallback),
DuckDuckGo images (last fallback). Results are NOT trusted: ClipForge's exact-model + vision check decides.
"""
import html, json, re, sys, time, urllib.parse

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36"
HDR = {"User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"}

try:
    import requests
    _S = requests.Session(); _S.headers.update(HDR)
    def get(url, timeout=20):
        r = _S.get(url, timeout=timeout)
        if r.status_code != 200: raise RuntimeError(f"HTTP {r.status_code} {url[:60]}")
        return r.text
except ImportError:  # pragma: no cover
    import urllib.request
    def get(url, timeout=20):
        req = urllib.request.Request(url, headers=HDR)
        with urllib.request.urlopen(req, timeout=timeout) as r: return r.read().decode("utf-8", "replace")

def toks(q): return [t for t in re.findall(r"[a-z0-9]+", q.lower()) if len(t) > 1]

def polite(): time.sleep(1.2)

# ---------------- Amazon ----------------
def amazon_products(q, limit=3):
    h = get("https://www.amazon.com/s?k=" + urllib.parse.quote_plus(q))
    if "captcha" in h.lower() and "/s?k=" not in h: raise RuntimeError("amazon captcha")
    want = toks(q)
    out, seen = [], set()
    for m in re.finditer(r'href="(/[^"]*?/dp/([A-Z0-9]{10})[^"]*)"[^>]*>(.*?)</a>', h, re.S):
        asin = m.group(2)
        if asin in seen: continue
        text = html.unescape(re.sub(r"<[^>]+>", " ", m.group(3))).lower()
        slugtxt = m.group(1).lower().replace("-", " ")
        hit = sum(t in text or t in slugtxt for t in want)
        if hit < max(2, int(len(want) * 0.6)): continue
        seen.add(asin); out.append(f"https://www.amazon.com/dp/{asin}")
        if len(out) >= limit: break
    return out

def amazon_media(q, n):
    imgs, vids = [], []
    for page in amazon_products(q):
        polite()
        h = get(page)
        title = html.unescape((re.search(r'id="productTitle"[^>]*>(.*?)</span>', h, re.S) or [None, ""])[1]).strip()
        for u in re.findall(r'"hiRes":"(https://[^"]+)"', h) + re.findall(r'"large":"(https://m\.media-amazon\.com/images/I/[^"]+)"', h):
            if u not in [i["url"] for i in imgs]:
                imgs.append({"url": u, "width": 1500, "height": 1500, "source": page, "title": title, "provider": "amazon"})
        for u in re.findall(r'"(https://[^"]+?\.(?:mp4|m3u8))"', h):
            u = u.replace("\\/", "/")
            if "media-amazon" in u and u not in [v["url"] for v in vids]:
                vids.append({"url": u, "title": title, "provider": "amazon", "page": page})
    return imgs[:n], vids[:n]

# ---------------- Google ----------------
def google_images(q, n):
    h = get("https://www.google.com/search?tbm=isch&hl=en&q=" + urllib.parse.quote_plus(q))
    if "/sorry/" in h or "unusual traffic" in h: raise RuntimeError("google blocked")
    out = []
    for m in re.finditer(r'\["(https?://[^"]+?\.(?:jpg|jpeg|png|webp)[^"]*)",(\d+),(\d+)\]', h):
        u = m.group(1).encode().decode("unicode_escape")
        if "gstatic.com" in u: continue
        out.append({"url": u, "height": int(m.group(2)), "width": int(m.group(3)), "source": "", "title": "", "provider": "google"})
        if len(out) >= n: break
    if not out: raise RuntimeError("google: no parsable results")
    return out

def google_videos(q, n):
    h = get("https://www.google.com/search?tbm=vid&hl=en&q=" + urllib.parse.quote_plus(q))
    if "/sorry/" in h or "unusual traffic" in h: raise RuntimeError("google blocked")
    out = []
    for u in re.findall(r'href="(https://(?:www\.)?(?:youtube\.com/watch\?v=[\w-]{11}|vimeo\.com/\d+|dailymotion\.com/video/\w+|[^"]*?\.mp4))', h):
        u = html.unescape(u)
        if u not in [o["url"] for o in out]: out.append({"url": u, "title": "", "provider": "google", "page": u})
        if len(out) >= n: break
    if not out: raise RuntimeError("google videos: no parsable results")
    return out

# ---------------- Bing ----------------
def bing_images(q, n):
    h = get("https://www.bing.com/images/async?q=" + urllib.parse.quote_plus(q) + f"&first=0&count={max(n, 35)}&adlt=moderate")
    out = []
    for m in re.finditer(r'm="(\{[^"]+\})"', h):
        try: d = json.loads(html.unescape(m.group(1)))
        except Exception: continue
        if d.get("murl"):
            out.append({"url": d["murl"], "width": 0, "height": 0, "source": d.get("purl", ""), "title": d.get("t", ""), "provider": "bing"})
        if len(out) >= n: break
    return out

def bing_videos(q, n):
    h = get("https://www.bing.com/videos/search?q=" + urllib.parse.quote_plus(q))
    out = []
    for m in re.finditer(r'vrhm="(\{[^"]+\})"', h):
        try: d = json.loads(html.unescape(m.group(1)))
        except Exception: continue
        u = d.get("pgurl") or d.get("murl")
        if u and u not in [o["url"] for o in out]:
            out.append({"url": u, "title": d.get("vt", "") or d.get("title", ""), "provider": "bing", "page": u})
        if len(out) >= n: break
    if not out:
        for u in re.findall(r'(https://www\.youtube\.com/watch\?v=[\w-]{11})', h):
            if u not in [o["url"] for o in out]: out.append({"url": u, "title": "", "provider": "bing", "page": u})
            if len(out) >= n: break
    return out

def ddg_images(q, n):
    try: from ddgs import DDGS
    except ImportError: from duckduckgo_search import DDGS
    out = []
    with DDGS() as d:
        for r in d.images(q, max_results=n):
            out.append({"url": r.get("image"), "width": r.get("width") or 0, "height": r.get("height") or 0, "source": r.get("url") or "", "title": r.get("title") or "", "provider": "duckduckgo"})
    return out

def main():
    op, q = sys.argv[1], sys.argv[2]
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    errors, imgs, vids = [], [], []
    try:
        a_i, a_v = amazon_media(q, n); imgs += a_i; vids += a_v
    except Exception as e: errors.append(f"amazon: {e}"[:160])
    if op == "images" and not any(i["provider"] == "amazon" for i in imgs):
        # Amazon blocks scripted page loads (503/captcha): find its gallery images via Bing instead.
        try:
            for i in bing_images(f"{q} site:amazon.com", n):
                if "media-amazon" in i["url"] or "amazon." in i["source"]:
                    i["provider"] = "amazon"; i["via"] = "bing site:amazon.com"; imgs.append(i)
        except Exception as e: errors.append(f"amazon via bing: {e}"[:160])
    if op == "videos" and not vids:
        try:
            for v in bing_videos(f"{q} amazon", n):
                if "amazon." in v["url"]: v["provider"] = "amazon"; vids.append(v)
        except Exception as e: errors.append(f"amazon videos via bing: {e}"[:160])
    if op == "images":
        got_google = False
        try: imgs += google_images(q, n); got_google = True
        except Exception as e: errors.append(f"google: {e}"[:160])
        if not got_google or len(imgs) < n:
            try: imgs += bing_images(q, n)
            except Exception as e: errors.append(f"bing: {e}"[:160])
        if len(imgs) < 5:
            try: imgs += ddg_images(q, n)
            except Exception as e: errors.append(f"ddg: {e}"[:160])
        print(json.dumps({"ok": bool(imgs), "images": imgs, "errors": errors, "error": "; ".join(errors) if not imgs else None}))
    else:
        try: vids += google_videos(q, n)
        except Exception as e:
            errors.append(f"google: {e}"[:160])
            try: vids += bing_videos(q, n)
            except Exception as e2: errors.append(f"bing: {e2}"[:160])
        print(json.dumps({"ok": bool(vids), "videos": vids, "errors": errors}))

try:
    main()
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)[:200]}))
