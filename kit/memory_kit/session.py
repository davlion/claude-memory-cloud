"""SessionStart context (spec §7 E outbox, F local preflight, G snapshot, H compaction)."""
from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Tuple
from urllib.parse import urlsplit

from . import HOOK_VERSION
from .claudemd import has_marker
from .health import HealthProbe, HealthResult, hook_outdated
from .outbox import OutboxSummary, scan_outbox
from .paths import KitPaths
from .preflight import (AUTO_MEMORY_LINE, CONFIG_LINE, MANAGED_SETTINGS, ROUTING_LINE, SCOPE_MAP_LINE,
                        auto_memory_off, ensure_private_dirs, settings_chain)
from .remote import cache_key, normalize_remote, resolve_origin
from .scopemap import ScopeMapError, load_scope_map
from .snapshot import render_snapshot

MAX_CONTEXT_CHARS = 9500   # Claude Code caps additionalContext at 10,000 characters
STALE_DAYS = 7
COMPACT_LINE = ("Context was compacted. Call memory_index again (with project as at session start) "
                "and use its result and Since map from now on.")
PROBLEMS_HEAD = ("claude-memory preflight found problems. Tell the user one line per problem, "
                 "starting with \"⚠ memory:\" and including its action:")


def load_config(path: Path) -> Optional[Dict[str, str]]:
    try:
        d = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(d, dict) or not isinstance(d.get("worker_url"), str) or not d["worker_url"]:
        return None
    return d


def health_line(url: str, h: HealthResult) -> Optional[str]:
    if h.kind == "dns":
        host = urlsplit(url).hostname or url
        return (f"Can't look up the memory server's address {host} (DNS failed). If other sites load, the Mac's DNS "
                "resolver is probably stuck: run `! sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`, "
                "then retry (toggling the terminal's Local Network permission alone isn't enough). If it still fails, "
                "check the Worker URL in `~/.claude-memory-cloud/config.json`. Saves will be queued in the outbox.")
    if h.kind == "unreachable":
        return (f"Can't reach the memory server {url}. Check this machine's network/DNS "
                f"(`curl -sS {url}/health`). Saves will be queued in the outbox.")
    if h.kind == "daily_limit":
        return ("The memory server hit its daily request limit; resets 00:00 UTC; saves are queued in the outbox.")
    if h.kind == "http_error":
        return (f"The memory server {url} answered /health with HTTP {h.status}. Saves may be queued in the outbox; "
                "server owner: check `npx wrangler tail` and the last deploy.")
    if h.kind == "bad_response":
        return (f"The memory server {url} sent an unexpected /health response; check the Worker URL in "
                "`~/.claude-memory-cloud/config.json` (rerun the setup script with --worker-url).")
    if hook_outdated(HOOK_VERSION, h.min_hook_version):
        return (f"Memory hooks are out of date (installed {HOOK_VERSION}, server needs {h.min_hook_version}); "
                "rerun the setup script.")
    return None


def project_line(project: Optional[Tuple[str, str]], unknown: bool = False) -> str:
    if unknown and not project:
        return "Memory project for this session: unknown (run `git remote get-url origin`)"
    if project:
        return f"Memory project for this session: {project[0]}/{project[1]}"
    return "Memory project for this session: none (no GitHub origin; omit project)"


def outbox_text(total: int, for_project: Optional[int], outbox_dir: Path) -> str:
    noun = "memory" if total == 1 else "memories"
    where = f" ({for_project} for this project)" if for_project is not None else ""
    return (f"{total} {noun} queued in outbox{where}. Once memory_index succeeds, flush them with "
            "memory_save/memory_delete, oldest first, and delete each entry only after a successful result. "
            f"Entries are in {outbox_dir}; the format and flush steps are in the memory rule in ~/.claude/CLAUDE.md.")


@dataclass
class SessionReport:
    problems: List[str]
    outbox: OutboxSummary
    remote: Optional[str]
    project: Optional[Tuple[str, str]]
    origin_unknown: bool = False


def session_report(*, cwd: str, paths: KitPaths, env: Mapping[str, str], now: datetime,
                   managed: Path = MANAGED_SETTINGS, health_timeout: float = 1.0) -> SessionReport:
    """Runs every local preflight check plus the one /health GET (spec §7 F local half)."""
    cfg = load_config(paths.config)
    # Run `git` before the probe starts: on macOS, a fork() after a failed DNS lookup (resolver stuck) can segfault
    # the child. Costs the probe a few ms of overlap with the local checks.
    remote, git_failed = resolve_origin(cwd) if cwd else (None, False)
    probe = HealthProbe(cfg["worker_url"], health_timeout) if cfg else None  # overlaps the local checks
    problems: List[str] = [] if cfg else [CONFIG_LINE]
    problems += ensure_private_dirs(paths.root, [paths.outbox, paths.cache])
    if not auto_memory_off(env, settings_chain(paths.home, env.get("CLAUDE_PROJECT_DIR") or cwd, managed)):
        problems.append(AUTO_MEMORY_LINE)
    try:
        rule_present = has_marker(paths.claude_md.read_text(encoding="utf-8"))
    except OSError:
        rule_present = False
    if not rule_present:
        problems.append(ROUTING_LINE)
    try:
        load_scope_map(paths.scopes)
    except ScopeMapError:
        problems.append(SCOPE_MAP_LINE)
    project = normalize_remote(remote) if remote else None
    ob = scan_outbox(paths.outbox, project, now)
    if ob.malformed:
        shown = ", ".join(ob.malformed[:5]) + (" …" if len(ob.malformed) > 5 else "")
        problems.append(f"{len(ob.malformed)} outbox entries can't be read and won't be flushed: {shown}. "
                        f"Fix or delete them in {paths.outbox} (format: the memory rule in ~/.claude/CLAUDE.md).")
    if ob.oldest_days is not None and ob.oldest_days > STALE_DAYS:
        problems.append(f"Oldest queued memory is {int(ob.oldest_days)} days old; check the server health above.")
    if probe and cfg:
        line = health_line(cfg["worker_url"], probe.result())
        if line:
            problems.append(line)
    return SessionReport(problems, ob, remote, project, git_failed)


def session_start_context(*, source: str, cwd: str, paths: KitPaths, env: Mapping[str, str], now: datetime,
                          managed: Path = MANAGED_SETTINGS, health_timeout: float = 1.0) -> str:
    """The SessionStart additionalContext: always the memory-project line, plus anything else worth saying."""
    r = session_report(cwd=cwd, paths=paths, env=env, now=now, managed=managed, health_timeout=health_timeout)
    sections: List[str] = []
    if source == "compact":
        sections.append(COMPACT_LINE)
    sections.append(project_line(r.project, r.origin_unknown))
    if r.outbox.total:
        sections.append(outbox_text(r.outbox.total, r.outbox.for_project if r.project else None, paths.outbox))
    if r.problems:
        sections.append(PROBLEMS_HEAD + "\n" + "\n".join(f"- {p}" for p in r.problems))
    used = sum(len(s) + 2 for s in sections)
    snap = render_snapshot(paths.cache, cache_key(r.remote), max_chars=MAX_CONTEXT_CHARS - used)
    if snap:
        sections.append(snap)
    return "\n\n".join(sections)
