"""Unit tests for python/web_crawler.py (no network): python -m unittest tests/test_web_crawler.py"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "python"))
import web_crawler as wc  # noqa: E402


class Sanitize(unittest.TestCase):
    def test_strips_operators(self):
        self.assertEqual(wc.sanitize('site:x.com "IBM" -ads 1980s server_racks!'), "ibm 1980s server racks")

    def test_caps_words(self):
        self.assertEqual(len(wc.sanitize(" ".join(f"w{i}" for i in range(20))).split()), 8)

    def test_variants_shorten(self):
        self.assertEqual(wc.query_variants("1980s ibm server racks"),
                         ["1980s ibm server racks", "ibm server racks", "1980s ibm server", "1980s ibm"])


class Licence(unittest.TestCase):
    def test_allowed(self):
        for s in ("by-sa", "CC BY 4.0", "Creative Commons Attribution license (reuse allowed)", "Public Domain", "cc0"):
            self.assertTrue(wc.licence_ok(s), s)

    def test_refused(self):
        for s in ("", "by-nc", "https://creativecommons.org/licenses/by-nc-nd/3.0/", "by-nd", "Standard YouTube License"):
            self.assertFalse(wc.licence_ok(s), s)


class Interleave(unittest.TestCase):
    def test_round_robin(self):
        hits = [{"url": f"https://a.org/{i}"} for i in range(3)] + [{"url": "https://b.org/1"}]
        self.assertEqual([h["url"] for h in wc.interleave(hits)][:2], ["https://a.org/0", "https://b.org/1"])


class Robots(unittest.TestCase):
    def setUp(self):
        wc._robots.clear()
        os.environ.pop("WEBCC_ROBOTS", None)

    def test_disallowed_path(self):
        fetch = lambda url: (200, "User-agent: *\nDisallow: /private/\n")
        self.assertFalse(wc.robots_allowed("https://s.org/private/v1", fetch))
        self.assertTrue(wc.robots_allowed("https://s.org/details/v1", fetch))

    def test_rfc9309_status_rules(self):
        self.assertTrue(wc.robots_allowed("https://four.org/x", lambda u: (404, "")))
        self.assertFalse(wc.robots_allowed("https://five.org/x", lambda u: (503, "")))

    def test_unreachable_is_allowed_and_cached(self):
        calls = []

        def boom(url):
            calls.append(url)
            raise OSError("proxy")

        self.assertTrue(wc.robots_allowed("https://down.org/a", boom))
        self.assertTrue(wc.robots_allowed("https://down.org/b", boom))
        self.assertEqual(len(calls), 1)

    def test_off_switch(self):
        os.environ["WEBCC_ROBOTS"] = "off"
        self.assertTrue(wc.robots_allowed("https://s.org/private/v1", lambda u: (200, "User-agent: *\nDisallow: /\n")))


class HostPause(unittest.TestCase):
    def test_waits_only_for_the_same_host(self):
        wc._last_hit.clear()
        now = [100.0]
        slept = []
        clock = lambda: now[0]

        def sleep(s):
            slept.append(round(s, 2))
            now[0] += s

        wc.host_pause("https://a.org/1", 1.5, sleep, clock)
        wc.host_pause("https://b.org/1", 1.5, sleep, clock)
        now[0] += 0.5
        wc.host_pause("https://a.org/2", 1.5, sleep, clock)
        self.assertEqual(slept, [1.0])


class Cache(unittest.TestCase):
    def test_short_cached_clip_is_not_reused(self):
        with tempfile.TemporaryDirectory() as d:
            out, meta = Path(d) / "web_1_x.mp4", Path(d) / "web_1_x.json"
            out.write_bytes(b"\0" * 20_000)
            meta.write_text(json.dumps({"duration": 7}))
            self.assertTrue(wc.cached_ok(out, meta, 7))
            self.assertFalse(wc.cached_ok(out, meta, 8))
            meta.write_text("not json")
            self.assertFalse(wc.cached_ok(out, meta, 5))


if __name__ == "__main__":
    unittest.main()
