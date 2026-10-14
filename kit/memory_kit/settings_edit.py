"""Merges the kit's entries into ~/.claude/settings.json and removes exactly those again.

Formatting is preserved (indent, `": "` vs `" : "`, escaped slashes, sorted keys, trailing newline),
so install followed by uninstall gives back the original bytes.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

HOOK_MARKER = "/.claude-memory-cloud/kit/hooks/"
PERMISSION_MARKER = "/.claude-memory-cloud/"
AUTO_MEMORY_KEY = "autoMemoryEnabled"
# Narrow rule so writing an outbox entry's timestamp doesn't prompt. Has no PERMISSION_MARKER, so it is
# matched by exact string on uninstall (a user's own identical rule would be removed too; unavoidable).
DATE_ALLOW_RULE = "Bash(date -u +%Y%m%dT%H%M%SZ)"
ABSENT = "absent"   # state.json value when autoMemoryEnabled wasn't set before install


@dataclass
class JsonStyle:
    indent: Union[int, str] = 2
    key_sep: str = ": "
    escape_slash: bool = False
    sort_keys: bool = False
    trailing_newline: bool = True


def _objects(v: Any):
    if isinstance(v, dict):
        yield v
        for x in v.values():
            yield from _objects(x)
    elif isinstance(v, list):
        for x in v:
            yield from _objects(x)


def detect_style(text: str, data: Any) -> JsonStyle:
    if not text.strip():
        return JsonStyle()
    m = re.search(r"\n([ \t]+)\S", text)
    ind = m.group(1) if m else "  "
    objs = [o for o in _objects(data) if len(o) > 1]
    return JsonStyle(
        indent=len(ind) if set(ind) == {" "} else ind,
        key_sep=" : " if re.search(r'"\s+:\s', text) else ": ",
        escape_slash="\\/" in text,
        sort_keys=bool(objs) and all(list(o) == sorted(o) for o in objs),
        trailing_newline=text.endswith("\n"),
    )


def dumps(data: Any, style: JsonStyle) -> str:
    s = json.dumps(data, indent=style.indent, separators=(",", style.key_sep), ensure_ascii=False,
                   sort_keys=style.sort_keys)
    if style.escape_slash:
        s = s.replace("/", "\\/")   # "/" only occurs inside strings in JSON text
    return s + ("\n" if style.trailing_newline else "")


def _is_ours(group: Any) -> bool:
    return isinstance(group, dict) and any(
        isinstance(h, dict) and HOOK_MARKER in str(h.get("command", "")) for h in group.get("hooks", []) or [])


def install_settings(data: Dict[str, Any], *, session_cmd: str, prompt_cmd: str, allow: List[str]) -> Dict[str, Any]:
    """Returns a copy with auto-memory off, the kit's hooks (replacing older kit hooks) and allow rules."""
    out = json.loads(json.dumps(data))
    out[AUTO_MEMORY_KEY] = False
    hooks = out.setdefault("hooks", {})
    for event, cmd, timeout in (("SessionStart", session_cmd, 5), ("UserPromptSubmit", prompt_cmd, 2)):
        groups = [g for g in hooks.get(event, []) if not _is_ours(g)]
        groups.append({"hooks": [{"type": "command", "command": cmd, "timeout": timeout}]})
        hooks[event] = groups
    perms = out.setdefault("permissions", {})
    rules = perms.setdefault("allow", [])
    for r in list(allow) + [DATE_ALLOW_RULE]:
        if r not in rules:
            rules.append(r)
    return out


def uninstall_settings(data: Dict[str, Any], auto_memory_previous: Optional[Union[bool, str]]) -> Dict[str, Any]:
    """Removes the kit's hooks and allow rules and restores autoMemoryEnabled (bool → set, ABSENT → removed)."""
    out = json.loads(json.dumps(data))
    hooks = out.get("hooks")
    if isinstance(hooks, dict):
        removed = False
        for event in list(hooks):
            if isinstance(hooks[event], list):
                kept = [g for g in hooks[event] if not _is_ours(g)]
                if len(kept) != len(hooks[event]):
                    removed = True
                    if kept:
                        hooks[event] = kept
                    else:
                        del hooks[event]
        if removed and not hooks:
            del out["hooks"]
    perms = out.get("permissions")
    if isinstance(perms, dict) and isinstance(perms.get("allow"), list):
        kept_rules = [r for r in perms["allow"] if PERMISSION_MARKER not in str(r) and r != DATE_ALLOW_RULE]
        if len(kept_rules) != len(perms["allow"]):
            if kept_rules:
                perms["allow"] = kept_rules
            else:
                del perms["allow"]
                if not perms:
                    del out["permissions"]
    if isinstance(auto_memory_previous, bool):
        out[AUTO_MEMORY_KEY] = auto_memory_previous
    elif auto_memory_previous == ABSENT:
        out.pop(AUTO_MEMORY_KEY, None)
    return out   # None: install state unknown, leave the user's setting alone


def write_atomic(path: Path, text: str, mode: int = 0o644) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        mode = path.stat().st_mode & 0o777
    except FileNotFoundError:
        pass
    fd, tmp = tempfile.mkstemp(dir=str(path.parent), prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


class SettingsError(Exception):
    """settings.json can't be edited safely (invalid JSON, not an object). Nothing was changed."""


def _load(real: Path):
    try:
        text = real.read_text(encoding="utf-8")
    except FileNotFoundError:
        return "", {}
    if not text.strip():
        return text, {}
    try:
        data = json.loads(text)
    except ValueError as e:
        raise SettingsError(f"{real} is not valid JSON ({e}); refusing to touch it") from e
    if not isinstance(data, dict):
        raise SettingsError(f"{real} is not a JSON object; refusing to touch it")
    return text, data


def _backup(real: Path) -> Optional[str]:
    if not real.exists():
        return None
    stamp = time.strftime("%Y%m%dT%H%M%S")
    n, dest = 0, real.with_name(f"{real.name}.bak-{stamp}")
    while dest.exists():
        n += 1
        dest = real.with_name(f"{real.name}.bak-{stamp}-{n}")
    shutil.copy2(str(real), str(dest))
    return str(dest)


def _apply(path, transform) -> Dict[str, Any]:
    """Loads (following a symlink, reported in `wrote`), transforms, backs up once, writes atomically if changed."""
    real = Path(os.path.realpath(str(path)))
    text, data = _load(real)
    new = transform(data)
    out = {"changed": False, "backup": None, "wrote": str(real), "symlink": real != Path(os.path.abspath(str(path))),
           "previous_data": data}
    new_text = dumps(new, detect_style(text, data))
    if new_text != text and not (not text.strip() and new == {} and not real.exists()):
        out["backup"] = _backup(real)
        write_atomic(real, new_text)
        out["changed"] = True
    return out


def install_file(path, *, session_cmd: str, prompt_cmd: str, allow: List[str]) -> Dict[str, Any]:
    """Merges into the file. Returns changed/backup/wrote/symlink and auto_memory_previous (bool or ABSENT).
    Note: on a re-run the previous value is already False (the kit set it); callers must keep the first answer."""
    r = _apply(path, lambda d: install_settings(d, session_cmd=session_cmd, prompt_cmd=prompt_cmd, allow=allow))
    prev = r.pop("previous_data").get(AUTO_MEMORY_KEY, ABSENT)
    r["auto_memory_previous"] = prev if isinstance(prev, bool) else ABSENT
    return r


def uninstall_file(path, auto_memory_previous: Optional[Union[bool, str]]) -> Dict[str, Any]:
    r = _apply(path, lambda d: uninstall_settings(d, auto_memory_previous))
    r.pop("previous_data")
    return r
