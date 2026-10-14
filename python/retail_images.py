"""Best-effort product image search (DuckDuckGo images via ddgs). Prints one JSON line:
{"ok": true, "images": [{"url","width","height","source","title"}]}. Never raises."""
import json, sys

def main():
    q = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 40
    try:
        try:
            from ddgs import DDGS
        except ImportError:
            from duckduckgo_search import DDGS
        out = []
        with DDGS() as d:
            for r in d.images(q, max_results=n):
                out.append({"url": r.get("image"), "width": r.get("width") or 0, "height": r.get("height") or 0,
                            "source": r.get("url") or "", "title": r.get("title") or ""})
        print(json.dumps({"ok": True, "images": out}))
    except Exception as e:  # blocked / rate-limited / missing package: skip gracefully
        print(json.dumps({"ok": False, "error": str(e)[:200]}))

main()
