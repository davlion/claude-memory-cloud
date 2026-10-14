"""The Worker's unauthenticated /health probe (spec §7 F local half): one GET, hard 1 s cap."""
from __future__ import annotations

import json
import re
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional, Tuple


@dataclass
class HealthResult:
    kind: str                 # ok | unreachable | daily_limit | http_error | bad_response
    status: int = 0
    version: str = ""
    min_hook_version: str = ""


def _get(url: str, timeout: float) -> HealthResult:
    req = urllib.request.Request(url.rstrip("/") + "/health", headers={"user-agent": "claude-memory-kit"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            status, body = r.status, r.read(4096)
    except urllib.error.HTTPError as e:
        body = e.read(4096) if e.fp is not None else b""
        e.close()
        # Cloudflare answers 429 (error 1027 on Workers Free) once a daily request limit is hit.
        return HealthResult("daily_limit" if e.code == 429 or b"1027" in body else "http_error", e.code)
    except Exception:  # noqa: BLE001 — DNS, refused, TLS, timeout: all mean "can't reach"
        return HealthResult("unreachable")
    try:
        d = json.loads(body)
    except ValueError:
        return HealthResult("bad_response", status)
    if not isinstance(d, dict) or d.get("ok") is not True:
        return HealthResult("bad_response", status)
    return HealthResult("ok", status, str(d.get("version", "")), str(d.get("min_hook_version", "")))


class HealthProbe:
    """Starts the GET at construction so it overlaps the local checks; result() never waits past the deadline."""

    def __init__(self, url: str, timeout: float = 1.0) -> None:
        self._deadline = time.monotonic() + timeout
        self._result: Optional[HealthResult] = None
        self._timeout = timeout
        self._thread = threading.Thread(target=self._run, args=(url,), daemon=True)
        self._thread.start()

    def _run(self, url: str) -> None:
        self._result = _get(url, self._timeout)

    def result(self) -> HealthResult:
        self._thread.join(max(0.0, self._deadline - time.monotonic()))
        return self._result if self._result is not None else HealthResult("unreachable")


def parse_version(s: str) -> Optional[Tuple[int, ...]]:
    return tuple(int(x) for x in s.split(".")) if re.fullmatch(r"\d+(\.\d+)*", s or "") else None


def hook_outdated(installed: str, minimum: str) -> bool:
    """True when `installed` < `minimum`. An unparseable or empty minimum never warns."""
    a, b = parse_version(installed), parse_version(minimum)
    if a is None or b is None:
        return False
    n = max(len(a), len(b))
    return a + (0,) * (n - len(a)) < b + (0,) * (n - len(b))
