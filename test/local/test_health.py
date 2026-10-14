import time
import unittest

from helpers import FakeWorker
from memory_kit.health import HealthProbe, hook_outdated, parse_version


class Versions(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(parse_version("0.1.10"), (0, 1, 10))
        self.assertIsNone(parse_version("v1"))
        self.assertIsNone(parse_version(""))

    def test_outdated(self):
        self.assertTrue(hook_outdated("0.1.0", "0.2.0"))
        self.assertTrue(hook_outdated("0.1", "0.1.1"))
        self.assertFalse(hook_outdated("0.1.0", "0.1"))
        self.assertFalse(hook_outdated("0.2.0", "0.1.9"))
        self.assertFalse(hook_outdated("0.1.0", "garbage"))


class Probe(unittest.TestCase):
    def probe(self, mode):
        w = FakeWorker(mode)
        self.addCleanup(w.close)
        return HealthProbe(w.url, 1.0).result()

    def test_kinds(self):
        self.assertEqual(self.probe("ok").kind, "ok")
        self.assertEqual(self.probe("ok").min_hook_version, "0.1.0")
        self.assertEqual(self.probe("429").kind, "daily_limit")
        self.assertEqual(self.probe("1027").kind, "daily_limit")
        r = self.probe("500")
        self.assertEqual((r.kind, r.status), ("http_error", 500))
        self.assertEqual(self.probe("garbage").kind, "bad_response")
        self.assertEqual(HealthProbe("http://127.0.0.1:9", 1.0).result().kind, "unreachable")

    def test_blackhole_respects_the_deadline(self):
        t = time.monotonic()
        self.assertEqual(self.probe("blackhole").kind, "unreachable")
        self.assertLess(time.monotonic() - t, 1.2)


if __name__ == "__main__":
    unittest.main()
