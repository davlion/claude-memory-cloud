"""Layer B: memory-intent detection for the UserPromptSubmit hook (spec §7 B). No network."""
from __future__ import annotations

import os
import re
from typing import Optional

from . import KIT_DIRNAME
from .remote import normalize_remote, redact_remote, resolve_origin
from .scopemap import ScopeMapError, client_scopes_for_owner, is_general_owner, load_scope_map

TRIGGERS = re.compile(
    r"\bsave (a |this )?memory"
    r"|(?<!don't )(?<!don’t )(?<!dont )(?<!can't )(?<!can’t )(?<!cant )(?<!do not )(?<!cannot )"
    r"\bremember (this|that)\b"
    r"|\bdon['’]?t (do|let) .* again"
    r"|\bnote for (the )?future"
    r"|\badd (this )?to (your )?memory",
    re.IGNORECASE,
)

REMINDER = (
    "claude-memory: this looks like a request to save a memory. Save it with the claude-memory connector's "
    "memory_save (load the tool first if it is deferred), never a local file; auto-memory is off.\n"
    "`scope` is required on memory_save: pass general (about the user), a client scope name (the client org as "
    "a whole), or project (this codebase, with project = the origin remote); if unclear, ask in one line. End with \"saved to <scope>\", "
    "\"queued in outbox for <scope>\", or \"not saved: <reason>\"."
)


def default_scopes_path() -> str:
    return os.path.join(os.path.expanduser("~"), KIT_DIRNAME, "scopes.json")


def is_memory_intent(prompt: str) -> bool:
    return bool(TRIGGERS.search(prompt))


def _safe_host(remote: str) -> str:
    """Only a sanitized host is ever echoed for a non-GitHub remote: .git/config of an untrusted checkout is not trusted."""
    rest = remote.strip().split("://", 1)[1] if "://" in remote else remote.strip()
    auth = re.split(r"[/\s]", rest, 1)[0] if "://" in remote else rest.split("/", 1)[0]
    host = auth.rsplit("@", 1)[-1].split(":", 1)[0]
    host = re.sub(r"[^A-Za-z0-9.-]", "", host)[:64]
    return host


def prompt_context(prompt: str, cwd: str, scopes_path: str) -> Optional[str]:
    if not is_memory_intent(prompt):
        return None
    lines = [REMINDER]
    remote = None
    if cwd:
        # .git/config first (fast); git itself only when it is missing (includes, reftable, ...) or not a
        # GitHub address (url.<base>.insteadOf aliases)
        remote = resolve_origin(cwd)[0]
    if remote is None:
        lines.append("No git origin remote here: project memories can't be saved from this directory; "
                     "say so if the fact is project-specific.")
        return "\n".join(lines)
    n = normalize_remote(remote)
    if n is None:
        host = _safe_host(remote)
        what = f"a non-GitHub remote on host {host}" if host else "a non-GitHub remote"
        lines.append(f"Origin remote: {what} (not on GitHub: no project scope here).")
        return "\n".join(lines)
    shown = redact_remote(remote)
    if re.search(r"[^\x21-\x7e]", shown):   # whitespace/control characters: never echo them
        shown = f"github.com/{n[0]}/{n[1]}"
    lines.append(f"Origin remote: {shown} (project = {n[0]}/{n[1]}).")
    try:
        sm = load_scope_map(scopes_path)
    except ScopeMapError:
        return "\n".join(lines)
    clients = client_scopes_for_owner(sm, n[0])
    if clients:
        lines.append(f"Client scope for this repo's owner {n[0]}: {', '.join(clients)}.")
    elif is_general_owner(sm, n[0]):
        lines.append(f"{n[0]} is the user's own account: no client scope; use general or project.")
    return "\n".join(lines)
