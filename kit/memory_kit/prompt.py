"""Layer B: memory-intent detection for the UserPromptSubmit hook (spec §7 B). No network."""
from __future__ import annotations

import os
import re
from typing import Optional

from . import KIT_DIRNAME
from .remote import git_origin, normalize_remote, origin_from_git_config, redact_remote
from .scopemap import ScopeMapError, client_scopes_for_owner, is_general_owner, load_scope_map

TRIGGERS = re.compile(
    r"\bsave (a |this )?memory"
    r"|\bremember (this|that)\b"
    r"|\bdon['’]?t (do|let) .* again"
    r"|\bnote for (the )?future"
    r"|\badd (this )?to (your )?memory",
    re.IGNORECASE,
)

REMINDER = (
    "claude-memory: this looks like a request to save a memory. Save it with the claude-memory connector's "
    "memory_save (load the tool first if it is deferred), never a local file; auto-memory is off.\n"
    "Scope: general (about the user), a client scope (the client org as a whole), or project (this codebase, "
    "project = the origin remote); if unclear, ask in one line. End with \"saved to <scope>\", "
    "\"queued in outbox for <scope>\", or \"not saved: <reason>\"."
)


def default_scopes_path() -> str:
    return os.path.join(os.path.expanduser("~"), KIT_DIRNAME, "scopes.json")


def is_memory_intent(prompt: str) -> bool:
    return bool(TRIGGERS.search(prompt))


def prompt_context(prompt: str, cwd: str, scopes_path: str) -> Optional[str]:
    if not is_memory_intent(prompt):
        return None
    lines = [REMINDER]
    remote = None
    if cwd:
        remote = origin_from_git_config(cwd)
        if remote is None:   # unusual layouts (includes, reftable, ...): ask git itself
            remote = git_origin(cwd)
    if remote is None:
        lines.append("No git origin remote here: project memories can't be saved from this directory; "
                     "say so if the fact is project-specific.")
        return "\n".join(lines)
    n = normalize_remote(remote)
    if n is None:
        lines.append(f"Origin remote: {redact_remote(remote)} (not on GitHub: no project scope here).")
        return "\n".join(lines)
    lines.append(f"Origin remote: {redact_remote(remote)} (project = {n[0]}/{n[1]}).")
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
