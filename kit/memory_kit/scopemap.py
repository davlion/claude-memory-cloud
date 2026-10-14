"""The local scope map: the signed-in user's own scopes, copied from their entry in SCOPES."""
from __future__ import annotations

import json
import os
import re
from typing import Dict, List, Optional, Union

PathLike = Union[str, "os.PathLike[str]"]   # open() takes either; no pathlib import (prompt-hook budget)

MAP_VERSION = 1
REPO_RE = re.compile(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+")   # same as src/scopes.ts REPO_RE
LOGIN_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}")      # same as src/scopes.ts LOGIN_RE


class ScopeMapError(ValueError):
    pass


def validate_scope_map(data: object) -> Dict[str, object]:
    if not isinstance(data, dict) or data.get("version") != MAP_VERSION:
        raise ScopeMapError('expected {"version": 1, "login": "<github login>", "scopes": {"<scope>": "<owner>/<repo>"}}')
    login = data.get("login")
    if not isinstance(login, str) or not LOGIN_RE.fullmatch(login):
        raise ScopeMapError("login missing or not a GitHub login")
    scopes = data.get("scopes")
    if not isinstance(scopes, dict) or not scopes:
        raise ScopeMapError("scopes missing or empty")
    for name, repo in scopes.items():
        if name == "project":   # the Worker's only scope-name rule (src/scopes.ts validateScopes)
            raise ScopeMapError('scope name "project" is reserved')
        if not isinstance(repo, str) or not REPO_RE.fullmatch(repo):
            raise ScopeMapError(f"invalid repo for scope {name!r}: expected owner/repo")
    return {"version": MAP_VERSION, "login": login, "scopes": dict(scopes)}


def load_scope_map(path: PathLike) -> Dict[str, object]:
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        raise ScopeMapError("missing") from None
    except (OSError, ValueError) as e:
        raise ScopeMapError(f"unreadable ({type(e).__name__})") from None
    return validate_scope_map(data)


def from_scopes_file(path: PathLike, login: Optional[str]) -> Dict[str, object]:
    """Picks one user's entry from a SCOPES-shaped file (`scopes.<env>.json`)."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        raise ScopeMapError(f"can't read {path} ({type(e).__name__})") from None
    if not isinstance(data, dict) or not data:
        raise ScopeMapError(f"{path} is not a SCOPES map")
    if login is None:
        if len(data) != 1:
            raise ScopeMapError(f"{path} lists {len(data)} users; pass --login <your github login>")
        login = next(iter(data))
    seen = set()
    for k in data:   # the Worker's parseScopeMap rules: valid logins, no case-insensitive duplicates
        if not LOGIN_RE.fullmatch(k):
            raise ScopeMapError(f"{path}: invalid GitHub login {k}")
        if k.lower() in seen:
            raise ScopeMapError(f"{path}: duplicate login {k} (logins are case-insensitive)")
        seen.add(k.lower())
    matches = [k for k in data if k.lower() == login.lower()]
    if not matches:
        raise ScopeMapError(f"login {login!r} is not in {path}")
    return validate_scope_map({"version": MAP_VERSION, "login": matches[0], "scopes": data[matches[0]]})


def from_scope_args(args: List[str], login: str) -> Dict[str, object]:
    """`["general=dav/claude-memory", "acme=acme-org/claude-memory"]` → scope map."""
    scopes: Dict[str, str] = {}
    for a in args:
        name, sep, repo = a.partition("=")
        if not sep:
            raise ScopeMapError(f"--scope expects NAME=OWNER/REPO, got {a!r}")
        scopes[name.strip()] = repo.strip()
    return validate_scope_map({"version": MAP_VERSION, "login": login, "scopes": scopes})


def client_scopes_for_owner(scope_map: Dict[str, object], owner: str) -> List[str]:
    """Client scopes whose repo owner is `owner` (spec §3 project resolution); never `general`."""
    scopes = scope_map["scopes"]
    assert isinstance(scopes, dict)
    return sorted(n for n, r in scopes.items() if n != "general" and r.split("/")[0].lower() == owner.lower())


def is_general_owner(scope_map: Dict[str, object], owner: str) -> bool:
    scopes = scope_map["scopes"]
    assert isinstance(scopes, dict)
    general = scopes.get("general")
    return isinstance(general, str) and general.split("/")[0].lower() == owner.lower()
