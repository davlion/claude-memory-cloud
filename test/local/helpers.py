"""Shared test helpers. Every test uses a temporary HOME; nothing touches the real ~/.claude."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, Optional, Tuple

REPO = Path(__file__).resolve().parents[2]
KIT = REPO / "kit"
sys.path.insert(0, str(KIT))

PY = sys.executable
FIXTURES = Path(__file__).resolve().parent / "fixtures"
SCOPES = {"version": 1, "login": "dav",
          "scopes": {"general": "dav/claude-memory", "acme": "acme-org/claude-memory"}}


def clean_env(home: Path, **extra: str) -> Dict[str, str]:
    """A minimal environment: no CLAUDE_* variables leak in from the session running the tests."""
    env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin"), "HOME": str(home),
           "MEMKIT_MANAGED_SETTINGS": str(home / "no-managed-settings.json"), "LANG": "en_US.UTF-8"}
    env.update(extra)
    return env


def make_git_dir(parent: Path, name: str, origin: Optional[str]) -> Path:
    d = parent / name
    d.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(d)], check=True)
    if origin:
        subprocess.run(["git", "-C", str(d), "remote", "add", "origin", origin], check=True)
    return d


def healthy_home(tmp: Path, worker_url: str) -> Path:
    """A HOME where every local check passes (the Worker answer depends on `worker_url`)."""
    home = tmp / "home"
    (home / ".claude").mkdir(parents=True)
    (home / ".claude" / "settings.json").write_text('{"autoMemoryEnabled": false}\n')
    (home / ".claude" / "CLAUDE.md").write_text(
        "<!-- claude-memory-cloud:routing-rule:begin -->\nrule\n<!-- claude-memory-cloud:routing-rule:end -->\n")
    root = home / ".claude-memory-cloud"
    root.mkdir(mode=0o700)
    for d in ("outbox", "cache"):
        (root / d).mkdir(mode=0o700)
    (root / "scopes.json").write_text(json.dumps(SCOPES))
    (root / "config.json").write_text(json.dumps({"worker_url": worker_url, "hook_version": "0.1.0"}))
    return home


def run_hook(script: str, payload: dict, env: Dict[str, str], hook_dir: Path = KIT / "hooks") -> Tuple[str, float]:
    """Runs a hook the way Claude Code does (`python -I -S <script>`, JSON on stdin). Returns (context, seconds)."""
    t = time.monotonic()
    r = subprocess.run([PY, "-I", "-S", str(hook_dir / script)], input=json.dumps(payload),
                       capture_output=True, text=True, env=env, timeout=10)
    elapsed = time.monotonic() - t
    assert r.returncode == 0, r.stderr
    if not r.stdout:
        return "", elapsed
    return json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"], elapsed


class FakeWorker:
    """A local /health endpoint. mode: ok | old | 429 | 1027 | 500 | garbage | blackhole."""

    def __init__(self, mode: str = "ok") -> None:
        self.mode = mode
        if mode == "blackhole":   # accepts connections, never answers
            self._sock = socket.socket()
            self._sock.bind(("127.0.0.1", 0))
            self._sock.listen(8)
            self.url = f"http://127.0.0.1:{self._sock.getsockname()[1]}"
            return
        outer = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def do_GET(self):
                m = outer.mode
                if m in ("ok", "old"):
                    body = json.dumps({"ok": True, "version": "0.1.0",
                                       "min_hook_version": "9.0.0" if m == "old" else "0.1.0"}).encode()
                    code = 200
                elif m == "429":
                    code, body = 429, b"rate limited"
                elif m == "1027":
                    code, body = 503, b"<html>error code: 1027</html>"
                elif m == "500":
                    code, body = 500, b"oops"
                else:
                    code, body = 200, b"<html>not json</html>"
                self.send_response(code)
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self._srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self._srv.server_address[1]}"
        threading.Thread(target=self._srv.serve_forever, daemon=True).start()

    def close(self) -> None:
        if self.mode == "blackhole":
            self._sock.close()
        else:
            self._srv.shutdown()
            self._srv.server_close()


def tempdir(testcase) -> Path:
    d = tempfile.TemporaryDirectory()
    testcase.addCleanup(d.cleanup)
    return Path(os.path.realpath(d.name))
