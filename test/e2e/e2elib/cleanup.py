"""Remove what a run left behind: test memories in the repos and queued test entries in host outboxes."""
from __future__ import annotations

import shlex
from typing import List

from .gh import MEMORY_PATH
from .launch import Host


def cleanup(ctx, since: str, hosts: List[Host]) -> List[str]:
    """Deletes every memory file touched since `since` whose text holds this run's `e2e-<run_id>-` prefix
    (conflict copies included), and every outbox entry holding it. Returns what was removed."""
    prefix = f"e2e-{ctx.run_id}-"
    removed: List[str] = []
    for repo in ctx.cfg.repos:
        paths = {p for c in ctx.gh.commits_since(repo, since) for p, _ in c.files if MEMORY_PATH.match(p)}
        for p in sorted(paths):
            text = ctx.gh.file_text(repo, p)
            if text and prefix in text and ctx.gh.delete(repo, p, f"e2e cleanup {ctx.run_id}"):
                removed.append(f"{repo}/{p}")
    for h in hosts:
        for f in ctx.outbox_files(h, prefix):
            name = f.rsplit("/", 1)[-1]
            ctx.sh(h, f"{h.python} -I -S ~/.claude-memory-cloud/kit/bin/memkit.py outbox-done {shlex.quote(name)}")
            removed.append(f"{h.id}:outbox/{name}")
    return removed


def cleanup_or_warn(ctx, since: str, hosts: List[Host], out=print) -> List[str]:
    """cleanup() between scenarios: a failure (e.g. GitHub unreachable) is reported, not fatal to the run."""
    try:
        return cleanup(ctx, since, hosts)
    except Exception as e:  # noqa: BLE001
        out(f"  cleanup failed ({e}); run `run.py cleanup` later")
        return []
