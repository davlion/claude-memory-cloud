import socket
import time
import unittest
from unittest import mock

from helpers import FakeWorker
from memory_kit.health import HealthProbe, HealthResult, hook_outdated, parse_version
from memory_kit.session import health_line


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

    def test_dns_failure_is_its_own_kind(self):
        # Fake the lookup failure rather than resolving a real name: on macOS, once a process has done a failed
        # lookup, its later fork()s can segfault in the child (Network framework's atfork handler), and every
        # subprocess test after this one would crash.
        def fail(*a, **k):
            raise socket.gaierror(8, "nodename nor servname provided, or not known")
        with mock.patch("socket.getaddrinfo", fail):
            self.assertEqual(HealthProbe("http://claude-memory.example.workers.dev", 1.0).result().kind, "dns")

    def test_dns_line_names_the_host_and_the_fix(self):
        line = health_line("https://claude-memory.example.workers.dev", HealthResult("dns"))
        self.assertIn("Can't look up the memory server's address claude-memory.example.workers.dev (DNS failed)", line)
        self.assertIn("`! sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`", line)
        self.assertIn("Saves will be queued in the outbox.", line)

    def test_deeply_nested_json_is_bad_response_without_traceback(self):
        import io
        import contextlib
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            r = self.probe("deep")
        self.assertEqual(r.kind, "bad_response")
        self.assertEqual(err.getvalue(), "")

    def test_redirect_is_not_followed(self):
        r = self.probe("302")
        self.assertEqual((r.kind, r.status), ("http_error", 302))

    def test_blackhole_respects_the_deadline(self):
        t = time.monotonic()
        self.assertEqual(self.probe("blackhole").kind, "unreachable")
        self.assertLess(time.monotonic() - t, 1.2)


if __name__ == "__main__":
    unittest.main()
