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


class SettingsError(Exception):
    """settings.json can't be edited safely (invalid JSON, unexpected shape). Nothing was changed."""


# Fixed kit rule strings, used to remove rules when the exact list added at install time is unknown.
KNOWN_KIT_RULES = [
    "Edit(~/.claude-memory-cloud/outbox/**)",
    "Edit(~/.claude-memory-cloud/cache/**)",
    "Edit(~/.claude-memory-cloud/export/**)",
    "Read(~/.claude-memory-cloud/**)",
    DATE_ALLOW_RULE,
]
_CONTAINERS = ("hooks", "hooks.SessionStart", "hooks.UserPromptSubmit", "permissions", "permissions.allow")


def _is_kit_entry(h: Any) -> bool:
    return isinstance(h, dict) and HOOK_MARKER in str(h.get("command", ""))


def _strip_kit(groups: List[Any]) -> List[Any]:
    """Removes kit hook entries only; a group is dropped only if it became empty because of that."""
    out = []
    for g in groups:
        if isinstance(g, dict) and isinstance(g.get("hooks"), list) and any(_is_kit_entry(h) for h in g["hooks"]):
            rest = [h for h in g["hooks"] if not _is_kit_entry(h)]
            if not rest:
                continue
            g = dict(g, hooks=rest)
        out.append(g)
    return out


def _check_shapes(data: Dict[str, Any]) -> None:
    hooks = data.get("hooks")
    if hooks is not None:
        if not isinstance(hooks, dict):
            raise SettingsError('"hooks" must be an object; refusing to edit')
        for ev, v in hooks.items():
            if not isinstance(v, list):
                raise SettingsError(f'"hooks.{ev}" must be a list; refusing to edit')
    perms = data.get("permissions")
    if perms is not None:
        if not isinstance(perms, dict):
            raise SettingsError('"permissions" must be an object; refusing to edit')
        if "allow" in perms and not isinstance(perms["allow"], list):
            raise SettingsError('"permissions.allow" must be a list; refusing to edit')


def _has_kit_hooks(data: Dict[str, Any]) -> bool:
    return any(_is_kit_entry(h) for gs in (data.get("hooks") or {}).values() for g in gs if isinstance(g, dict)
               for h in (g.get("hooks") if isinstance(g.get("hooks"), list) else []))


def install_with_info(data: Dict[str, Any], *, session_cmd: str, prompt_cmd: str, allow: List[str]):
    """Returns (new_data, info). info (store it; on re-install merge with the stored one):
      auto_memory_previous: ABSENT | bool | {"value": raw} | None (None = kit already installed, keep stored value)
      added_rules: allow rules appended by this call (not already present)
      created: containers this call created (subset of hooks, hooks.<Event>, permissions, permissions.allow)"""
    if not isinstance(data, dict):
        raise SettingsError("settings must be a JSON object")
    _check_shapes(data)
    reinstall = _has_kit_hooks(data)
    out = json.loads(json.dumps(data))
    created: List[str] = []
    if AUTO_MEMORY_KEY not in data:
        prev: Any = ABSENT
    elif isinstance(data[AUTO_MEMORY_KEY], bool):
        prev = data[AUTO_MEMORY_KEY]
    else:
        prev = {"value": data[AUTO_MEMORY_KEY]}
    out[AUTO_MEMORY_KEY] = False
    if "hooks" not in out:
        created.append("hooks")
    hooks = out.setdefault("hooks", {})
    for event, cmd, timeout in (("SessionStart", session_cmd, 5), ("UserPromptSubmit", prompt_cmd, 2)):
        if event not in hooks:
            created.append("hooks." + event)
        groups = _strip_kit(hooks.get(event, []))
        groups.append({"hooks": [{"type": "command", "command": cmd, "timeout": timeout}]})
        hooks[event] = groups
    if "permissions" not in out:
        created.append("permissions")
    perms = out.setdefault("permissions", {})
    if "allow" not in perms:
        created.append("permissions.allow")
    rules = perms.setdefault("allow", [])
    added: List[str] = []
    for r in list(allow) + [DATE_ALLOW_RULE]:
        if r not in rules:
            rules.append(r)
            added.append(r)
    return out, {"auto_memory_previous": None if reinstall else prev, "added_rules": added, "created": created}


def install_settings(data: Dict[str, Any], *, session_cmd: str, prompt_cmd: str, allow: List[str]) -> Dict[str, Any]:
    """Returns a copy with auto-memory off, the kit's hooks (replacing older kit hook entries) and allow rules."""
    return install_with_info(data, session_cmd=session_cmd, prompt_cmd=prompt_cmd, allow=allow)[0]


def uninstall_settings(data: Dict[str, Any], auto_memory_previous: Any, *,
                       added_rules: Optional[List[str]] = None, created: Optional[List[str]] = None,
                       fallback_rules: Optional[List[str]] = None) -> Dict[str, Any]:
    """Removes the kit's hook entries and allow rules and restores autoMemoryEnabled.

    auto_memory_previous: bool -> set, ABSENT -> remove, {"value": raw} -> set raw, None -> leave alone.
    added_rules: exactly the rules install appended; only those strings are removed. None (unknown) -> only rules
      exactly equal to KNOWN_KIT_RULES (+ fallback_rules, e.g. the Bash rule) are removed. Never substring matches.
    created: containers install created; only those are deleted when empty. None (unknown) -> containers that
      became empty through our removal are deleted."""
    if not isinstance(data, dict):
        raise SettingsError("settings must be a JSON object")
    _check_shapes(data)
    out = json.loads(json.dumps(data))

    def droppable(name: str, touched: bool) -> bool:
        return touched if created is None else name in created

    hooks = out.get("hooks")
    if isinstance(hooks, dict):
        touched = False
        for event in list(hooks):
            kept = _strip_kit(hooks[event])
            if kept != hooks[event]:
                touched = True
                hooks[event] = kept
                if not kept and droppable("hooks." + event, True):
                    del hooks[event]
        if not hooks and droppable("hooks", touched):
            del out["hooks"]
    perms = out.get("permissions")
    if isinstance(perms, dict):
        touched = False
        if isinstance(perms.get("allow"), list):
            victims = set(added_rules) if added_rules is not None else set(KNOWN_KIT_RULES) | set(fallback_rules or [])
            kept_rules = [r for r in perms["allow"] if not (isinstance(r, str) and r in victims)]
            touched = len(kept_rules) != len(perms["allow"])
            perms["allow"] = kept_rules
            if not kept_rules and droppable("permissions.allow", touched):
                del perms["allow"]
        if not perms and droppable("permissions", touched):
            del out["permissions"]
    if auto_memory_previous is None:
        pass   # install state unknown, leave the user's setting alone
    elif isinstance(auto_memory_previous, bool):
        out[AUTO_MEMORY_KEY] = auto_memory_previous
    elif auto_memory_previous == ABSENT:
        out.pop(AUTO_MEMORY_KEY, None)
    elif isinstance(auto_memory_previous, dict) and "value" in auto_memory_previous:
        out[AUTO_MEMORY_KEY] = auto_memory_previous["value"]
    return out


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
    new, info = transform(data)
    out = {"changed": False, "backup": None, "wrote": str(real), "symlink": os.path.islink(str(path))}
    out.update(info)
    new_text = dumps(new, detect_style(text, data))
    if new_text != text and not (not text.strip() and new == {} and not real.exists()):
        out["backup"] = _backup(real)
        write_atomic(real, new_text)
        out["changed"] = True
    return out


def install_file(path, *, session_cmd: str, prompt_cmd: str, allow: List[str]) -> Dict[str, Any]:
    """Merges into the file. Result: changed, backup, wrote, symlink, plus the install info to store
    (auto_memory_previous, added_rules, created; see install_with_info)."""
    return _apply(path, lambda d: install_with_info(d, session_cmd=session_cmd, prompt_cmd=prompt_cmd, allow=allow))


def uninstall_file(path, auto_memory_previous: Any, *, added_rules: Optional[List[str]] = None,
                   created: Optional[List[str]] = None, fallback_rules: Optional[List[str]] = None) -> Dict[str, Any]:
    return _apply(path, lambda d: (uninstall_settings(d, auto_memory_previous, added_rules=added_rules, created=created,
                                                      fallback_rules=fallback_rules), {}))
