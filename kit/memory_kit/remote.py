"""Git origin lookup and normalization. Mirrors claude-memory-cloud src/remote.ts exactly."""
from __future__ import annotations

import os
import re
from typing import List, Optional, Tuple

_PART = r"[A-Za-z0-9_.-]+"
_PATTERNS = [
    re.compile(r"git@github\.com:(" + _PART + r")/(" + _PART + r")"),
    re.compile(r"(?:https?|ssh|git)://(?:[^@/]+@)?github\.com/(" + _PART + r")/(" + _PART + r")"),
    re.compile(r"([A-Za-z0-9-]+)/(" + _PART + r")"),
]


def normalize_remote(url: str) -> Optional[Tuple[str, str]]:
    """`git@github.com:Acme/Billing.git` → ("acme", "billing"); None for non-GitHub remotes."""
    s = re.sub(r"/+$", "", url.strip())
    if s.endswith(".git"):
        s = s[:-4]
    for p in _PATTERNS:
        m = p.fullmatch(s)
        if m and m.group(2) not in (".", ".."):
            return m.group(1).lower(), m.group(2).lower()
    return None


def redact_remote(url: str) -> str:
    """Drops credentials from a URL remote (`https://user:token@host/…` → `https://host/…`)."""
    u = url.strip()
    if "://" in u:
        return re.sub(r"://[^/]*@", "://", u, count=1)   # greedy: a password may itself contain "@"
    return re.sub(r"^[^/@:]+:[^/]*@", "", u)   # scp-style `user:token@host:path`; plain `git@host:path` stays


def _git_checked(cwd: str, args: List[str], timeout: float) -> Tuple[Optional[str], bool]:
    """(stdout or None, failed). `failed` is True only when git could not run or timed out (not for a clean non-zero exit)."""
    import subprocess  # lazy: costs ~40 ms on the Command Line Tools' Python, and the prompt hook never needs it
    try:
        r = subprocess.run(
            ["git", "-C", cwd, *args], capture_output=True, text=True, timeout=timeout,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
    except (OSError, subprocess.SubprocessError):
        return None, True
    out = r.stdout.strip()
    return (out if r.returncode == 0 and out else None), False


def _git(cwd: str, args: List[str], timeout: float) -> Optional[str]:
    return _git_checked(cwd, args, timeout)[0]


def git_origin(cwd: str, timeout: float = 0.5) -> Optional[str]:
    return _git(cwd, ["remote", "get-url", "origin"], timeout)


def git_origin_checked(cwd: str, timeout: float = 0.5) -> Tuple[Optional[str], bool]:
    return _git_checked(cwd, ["remote", "get-url", "origin"], timeout)


def resolve_origin(cwd: str) -> Tuple[Optional[str], bool]:
    """(origin, git_failed). The .git/config value is used when it is a GitHub address; otherwise (or when absent)
    git itself is asked, which applies url.<base>.insteadOf. An unrecognised config value is kept if git adds nothing."""
    raw = origin_from_git_config(cwd)
    if raw is not None and normalize_remote(raw) is not None:
        return raw, False
    g, failed = git_origin_checked(cwd)
    if g is not None and (raw is None or normalize_remote(g) is not None):
        return g, False
    return raw, (failed and raw is None)


def git_toplevel(cwd: str, timeout: float = 0.5) -> Optional[str]:
    return _git(cwd, ["rev-parse", "--show-toplevel"], timeout)


def _read_text(path: str) -> Optional[str]:
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read()
    except (OSError, ValueError):
        return None


def _git_config_path(cwd: str) -> Optional[str]:
    d = os.path.abspath(cwd)
    while True:
        g = os.path.join(d, ".git")
        if os.path.isdir(g):
            return os.path.join(g, "config")
        if os.path.isfile(g):   # worktree or submodule: "gitdir: <path>"
            text = _read_text(g)
            line = text.strip() if text is not None else ""
            if not line.startswith("gitdir:"):
                return None
            gd = os.path.join(d, line[7:].strip())
            common = os.path.join(gd, "commondir")
            if os.path.exists(common):
                ctext = _read_text(common)
                if ctext is None or not ctext.strip():
                    return None
                gd = os.path.join(gd, ctext.strip())
            return os.path.join(gd, "config")
        parent = os.path.dirname(d)
        if parent == d:
            return None
        d = parent


def _strip_inline_comment(val: str) -> str:
    out, quoted = [], False
    for i, ch in enumerate(val):
        if ch == '"':
            quoted = not quoted
        elif ch in "#;" and not quoted:
            break
        out.append(ch)
    return "".join(out)


def origin_from_git_config(cwd: str) -> Optional[str]:
    """`remote.origin.url` read straight from .git/config: no subprocess, for the < 100 ms prompt hook.
    Never raises; returns None on any failure. The first `url` of the origin remote wins.
    Not handled (callers must fall back to `git_origin` when this returns None): include/includeIf,
    url.insteadOf rewrites, bare repositories (no .git entry), and exotic quoting/escapes."""
    try:
        cfg = _git_config_path(cwd)
        text = _read_text(cfg) if cfg else None
        if text is None:
            return None
        in_origin = False
        for raw in text.splitlines():
            line = raw.strip()
            if line.startswith("["):
                in_origin = re.fullmatch(r'\[\s*remote\s+"origin"\s*\]', line, re.IGNORECASE) is not None
            elif in_origin:
                key, sep, val = line.partition("=")
                if sep and key.strip().lower() == "url":
                    return _strip_inline_comment(val).strip().strip('"') or None
    except (OSError, ValueError):
        return None
    return None


def cache_key(remote: Optional[str]) -> str:
    """Snapshot key (spec §7 G): `owner__repo`, or `_none` without a GitHub origin."""
    n = normalize_remote(remote) if remote else None
    return f"{n[0]}__{n[1]}" if n else "_none"
