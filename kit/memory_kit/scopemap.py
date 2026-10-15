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


def _check_scopes(scopes: object, where: str) -> None:
    """The Worker's validateScopes (src/scopes.ts): an object, no reserved "project", every repo owner/repo."""
    if not isinstance(scopes, dict):
        raise ScopeMapError(f'{where} must be a JSON object of scope name -> "owner/repo"')
    for name, repo in scopes.items():
        if name == "project":   # the Worker's only scope-name rule
            raise ScopeMapError(f'{where}: scope name "project" is reserved')
        if not isinstance(repo, str) or not REPO_RE.fullmatch(repo):
            raise ScopeMapError(f"{where}: invalid repo for scope {name!r}: expected owner/repo")


def validate_scope_map(data: object) -> Dict[str, object]:
    if not isinstance(data, dict) or data.get("version") != MAP_VERSION:
        raise ScopeMapError('expected {"version": 1, "login": "<github login>", "scopes": {"<scope>": "<owner>/<repo>"}}')
    login = data.get("login")
    if not isinstance(login, str) or not LOGIN_RE.fullmatch(login):
        raise ScopeMapError("login missing or not a GitHub login")
    scopes = data.get("scopes")
    # Deliberate difference from the Worker, which accepts an empty scope object: a local map with no
    # scopes can't route anything, so it is rejected here.
    if not isinstance(scopes, dict) or not scopes:
        raise ScopeMapError("scopes missing or empty")
    _check_scopes(scopes, "scopes")
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
    for k, scopes in data.items():   # the Worker's parseScopeMap, over the WHOLE file (any invalid entry rejects it)
        if not LOGIN_RE.fullmatch(k):
            raise ScopeMapError(f"{path}: invalid GitHub login {k}")
        if not isinstance(scopes, dict):
            raise ScopeMapError(f"{path}: scopes for {k} must be an object")
        if k.lower() in seen:
            raise ScopeMapError(f"{path}: duplicate login {k} (logins are case-insensitive)")
        seen.add(k.lower())
        _check_scopes(scopes, f"{path}: {k}")
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
