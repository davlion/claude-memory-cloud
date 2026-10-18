"""Run `claude -p` (and small shell commands) on a test host: the Mac itself or a VM over SSH."""
from __future__ import annotations

import os
import shlex
import subprocess
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Mapping, Optional, Sequence

from .transcript import MEMORY_TOOLS, Transcript, parse

# Variables a parent Claude Code session sets. Inherited, they make the child think it is nested, and
# ANTHROPIC_API_KEY turns off claude.ai connectors (observed 2026-10-15, Claude Code 2.1.300).
SCRUB_PREFIXES = ("ANTHROPIC_", "CLAUDE_CODE_", "CLAUDECODE")
SCRUB_EXACT = ("CLAUDE_PID", "CLAUDE_EFFORT")
EMPTY_MCP = '{"mcpServers":{}}'


@dataclass
class Host:
    id: str                      # "H1"
    label: str                   # "Mac CLI"
    ssh: Optional[str]           # ssh destination, or None for this machine
    claude: str                  # claude executable on that host
    python: str                  # python for kit helpers on that host
    mcp_prefixes: List[str]      # e.g. ["mcp__claude_ai_claude-memory-staging__"]
    dirs: Dict[str, str]         # "sample_app" / "kit_repo" / "no_remote" -> path (may start with ~/)
    deny_prefixes: List[str] = field(default_factory=list)   # other memory connectors (production): never usable


@dataclass
class Invocation:
    prompt: str
    cwd: str                                 # a key of Host.dirs
    allow: Sequence[str] = ()                # short memory tool names to pre-approve, e.g. ("memory_save",)
    max_turns: int = 12
    session_id: Optional[str] = None         # start a new session with this id
    resume: Optional[str] = None             # continue this session
    no_connector: bool = False               # load no MCP servers at all (connector "unavailable")
    env: Dict[str, str] = field(default_factory=dict)
    timeout: float = 420.0


@dataclass
class RunResult:
    transcript: Transcript
    returncode: Optional[int]
    stdout: str
    stderr: str
    timed_out: bool


Exec = Callable[[List[str], Optional[str], Optional[Dict[str, str]], float], "subprocess.CompletedProcess[str]"]


def clean_env(base: Mapping[str, str], extra: Mapping[str, str]) -> Dict[str, str]:
    env = {k: v for k, v in base.items() if not k.startswith(SCRUB_PREFIXES) and k not in SCRUB_EXACT}
    env.update(extra)
    return env


def claude_args(host: Host, inv: Invocation) -> List[str]:
    """The claude argv after the executable. The prompt comes first: --allowedTools is variadic, so it goes last."""
    args = ["-p", inv.prompt, "--output-format", "stream-json", "--verbose",
            "--permission-mode", "default", "--max-turns", str(inv.max_turns)]
    if inv.session_id:
        args += ["--session-id", inv.session_id]
    if inv.resume:
        args += ["--resume", inv.resume]
    if inv.no_connector:
        args += ["--strict-mcp-config", "--mcp-config", EMPTY_MCP]
    if host.deny_prefixes:
        args += ["--disallowedTools"] + [p + t for p in host.deny_prefixes for t in MEMORY_TOOLS]
    if inv.allow:
        args += ["--allowedTools"] + [p + t for p in host.mcp_prefixes for t in inv.allow]
    return args


def _remote_path(p: str) -> str:
    """Quote a path for a remote shell, keeping a leading ~/ expandable."""
    return '"$HOME"/' + shlex.quote(p[2:]) if p.startswith("~/") else shlex.quote(p)


def command(host: Host, inv: Invocation) -> List[str]:
    """Full argv to run locally (for ssh hosts: ssh + one remote shell command)."""
    if host.ssh is None:
        return [os.path.expanduser(host.claude)] + claude_args(host, inv)
    unset = " ".join(f"-u {v}" for v in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"))
    sets = " ".join(f"{k}={shlex.quote(v)}" for k, v in sorted(inv.env.items()))
    remote = (f"cd {_remote_path(host.dirs[inv.cwd])} && env {unset} {sets} "
              f"{_remote_path(host.claude)} {' '.join(shlex.quote(a) for a in claude_args(host, inv))} </dev/null")
    return ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host.ssh, remote]


def _default_exec(argv: List[str], cwd: Optional[str], env: Optional[Dict[str, str]],
                  timeout: float) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(argv, cwd=cwd, env=env, stdin=subprocess.DEVNULL, capture_output=True,
                          text=True, timeout=timeout)


def run_claude(host: Host, inv: Invocation, exec_: Exec = _default_exec) -> RunResult:
    argv = command(host, inv)
    cwd = os.path.expanduser(host.dirs[inv.cwd]) if host.ssh is None else None
    env = clean_env(os.environ, inv.env) if host.ssh is None else clean_env(os.environ, {})
    try:
        r = exec_(argv, cwd, env, inv.timeout)
    except subprocess.TimeoutExpired as e:
        out = e.stdout if isinstance(e.stdout, str) else (e.stdout or b"").decode("utf-8", "replace")
        return RunResult(parse(out.splitlines()), None, out, "timeout", True)
    return RunResult(parse(r.stdout.splitlines()), r.returncode, r.stdout, r.stderr, False)


def shell(host: Host, script: str, exec_: Exec = _default_exec, timeout: float = 60.0) -> str:
    """Run a small sh script on the host; returns stdout. Raises RuntimeError on a non-zero exit."""
    argv = ["sh", "-c", script] if host.ssh is None else \
        ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", host.ssh, script]
    r = exec_(argv, None, None, timeout)
    if r.returncode != 0:
        raise RuntimeError(f"{host.id}: `{script[:80]}` exited {r.returncode}: {r.stderr.strip()[:300]}")
    return r.stdout
