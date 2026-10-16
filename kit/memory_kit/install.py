"""setup.sh's engine: install, --uninstall, --export-local (spec §10 steps 3 and 6a).

Everything that edits the user's files is planned first (pure functions, nothing written), so a refusal
(bad JSON, unbalanced markers) leaves the machine untouched, and --dry-run prints exactly that plan.
"""
from __future__ import annotations

import argparse
import difflib
import json
import os
import re
import shlex
import shutil
import stat
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

from . import HOOK_VERSION
from .claudemd import MarkerError, has_marker, remove_block, render_rule, upsert_block
from .outbox import OutboxFormatError, _frontmatter, list_entries
from .paths import KIT_DIRNAME, KitPaths, kit_paths
from .preflight import MANAGED_SETTINGS
from .remote import cache_key, git_origin, git_toplevel
from .scopemap import ScopeMapError, from_scope_args, from_scopes_file, load_scope_map
from .session import load_config, session_report
from .settings_edit import (ABSENT, HOOK_MARKER, SettingsError, _load, detect_style, dumps, install_file,
                            install_with_info, uninstall_file, uninstall_settings, write_atomic)

WORKER_URL_RE = re.compile(r"https://[A-Za-z0-9.-]+(:\d+)?|http://(127\.0\.0\.1|localhost)(:\d+)?")
KIT_SUBDIRS = ("memory_kit", "hooks", "bin", "templates")
OUTBOX_NAME_RE = re.compile(r"\d{8}T\d{6}Z-[a-z0-9][a-z0-9-]{0,63}\.md", re.ASCII)
STATE_VERSION = 1
Out = Callable[[str], None]


def _now() -> datetime:
    return datetime.now(timezone.utc)


def managed_path(env: Optional[Dict[str, str]] = None) -> Path:
    """The managed-settings file to consult; MEMKIT_MANAGED_SETTINGS overrides it (tests never read the real one)."""
    return Path((env if env is not None else os.environ).get("MEMKIT_MANAGED_SETTINGS", str(MANAGED_SETTINGS)))


def _real(path: Path) -> Path:
    return Path(os.path.realpath(str(path)))


def _read(path: Path) -> Optional[str]:
    """Text exactly as stored (no newline translation), None when the file doesn't exist."""
    try:
        with open(_real(path), encoding="utf-8", newline="") as f:
            return f.read()
    except FileNotFoundError:
        return None


def _backup(path: Path, now: datetime) -> None:
    real = _real(path)
    if not real.exists():
        return
    stem = f"{real.name}.memkit-backup-{now.strftime('%Y%m%dT%H%M%SZ')}"
    dst, n = real.with_name(stem), 0
    while dst.exists():
        n += 1
        dst = real.with_name(f"{stem}-{n}")
    shutil.copy2(real, dst)
    os.chmod(dst, 0o600)


def _diff(path: Path, old: str, new: str) -> str:
    return "".join(difflib.unified_diff(old.splitlines(True), new.splitlines(True), str(path), f"{path} (new)"))


def _write_private(path: Path, text: str) -> None:
    write_atomic(path, text, 0o600)
    os.chmod(path, 0o600)


def commands(paths: KitPaths, python: str) -> Dict[str, str]:
    py = f"{shlex.quote(python)} -I -S"
    return {
        "session": f"{py} {shlex.quote(str(paths.kit / 'hooks' / 'session_start.py'))}",
        "prompt": f"{py} {shlex.quote(str(paths.kit / 'hooks' / 'user_prompt_submit.py'))}",
        "snapshot": f"{py} {shlex.quote(str(paths.kit / 'hooks' / 'post_tool_use.py'))}",
        "memkit": f"{py} {shlex.quote(str(paths.kit / 'bin' / 'memkit.py'))}",
    }


MCP_NAME_RE = re.compile(r"[A-Za-z0-9_-]+", re.ASCII)
MCP_READ_TOOLS = ("memory_index", "memory_read", "memory_search")    # memory_save / memory_delete keep prompting


def memkit_rule(memkit_cmd: str) -> str:
    return f"Bash({memkit_cmd} outbox-done *)"


def mcp_rules(names: List[str]) -> List[str]:
    return [f"mcp__{n}__{t}" for n in names for t in MCP_READ_TOOLS]


def allow_rules(memkit_cmd: str, mcp_names: Tuple[str, ...] = ()) -> List[str]:
    d = f"~/{KIT_DIRNAME}"
    return [f"Edit({d}/outbox/**)", f"Edit({d}/export/**)", f"Read({d}/**)",
            memkit_rule(memkit_cmd), *mcp_rules(list(mcp_names))]


def detect_mcp_servers(home: Path, worker_url: str) -> List[str]:
    """Names of the MCP servers in ~/.claude.json (top level and every project) whose url is the Worker's.
    Read-only; a missing / invalid / oddly shaped file gives []."""
    try:
        with open(Path(home) / ".claude.json", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return []
    base = worker_url.rstrip("/")
    found: List[str] = []

    def scan(servers: Any) -> None:
        if not isinstance(servers, dict):
            return
        for name, cfg in servers.items():
            url = cfg.get("url") if isinstance(cfg, dict) else None
            if not isinstance(url, str) or not isinstance(name, str) or not MCP_NAME_RE.fullmatch(name):
                continue
            u = url.strip().rstrip("/")
            if (u == base or u.startswith(base + "/") or u.startswith(base + "?")) and name not in found:
                found.append(name)

    if isinstance(data, dict):
        scan(data.get("mcpServers"))
        projects = data.get("projects")
        if isinstance(projects, dict):
            for proj in projects.values():
                if isinstance(proj, dict):
                    scan(proj.get("mcpServers"))
    return found


def load_settings(path: Path) -> Tuple[Dict[str, Any], Any, Optional[str]]:
    """(data, style, text as stored or None when missing). Raises SettingsError on invalid JSON / non-object."""
    real = _real(path)
    if not real.exists():
        return {}, detect_style("", {}), None
    text, data = _load(real)
    return data, detect_style(text, data), text


def _load_state(paths: KitPaths) -> Optional[Dict[str, Any]]:
    try:
        d = json.loads(paths.state.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) else None


def _union(old: Any, new: List[str]) -> List[str]:
    out = [x for x in old if isinstance(x, str)] if isinstance(old, list) else []
    out += [x for x in new if x not in out]
    return out


def _copy_kit(src: Path, dst: Path) -> None:
    tmp = dst.with_name(dst.name + ".new")
    old = dst.with_name(dst.name + ".old")
    shutil.rmtree(tmp, ignore_errors=True)
    shutil.rmtree(old, ignore_errors=True)
    for sub in KIT_SUBDIRS:
        shutil.copytree(src / sub, tmp / sub, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    if dst.exists():
        os.replace(dst, old)
    os.replace(tmp, dst)
    shutil.rmtree(old, ignore_errors=True)


def install(paths: KitPaths, *, worker_url: str, scope_map: Dict[str, Any], python: str, src_kit: Path,
            mcp_servers: Tuple[str, ...] = (), neutral_source: Optional[bool] = None, dry_run: bool = False, out: Out = print,
            now: Optional[datetime] = None) -> int:
    """0 on success, 1 when installed but preflight found problems. Raises SettingsError / MarkerError (before any
    write) when settings.json or CLAUDE.md can't be edited safely."""
    now = now or _now()
    cmds = commands(paths, python)
    # MCP server names: explicit + detected in ~/.claude.json + those a previous run stored in config.json
    detected = detect_mcp_servers(paths.home, worker_url)
    stored_cfg = load_config(paths.config) or {}
    kept = [n for n in stored_cfg.get("mcp_servers", []) if isinstance(n, str) and MCP_NAME_RE.fullmatch(n)] \
        if isinstance(stored_cfg.get("mcp_servers"), list) else []
    names: List[str] = []
    for n in [*mcp_servers, *detected, *kept]:
        if n not in names:
            names.append(n)
    allow = allow_rules(cmds["memkit"], tuple(names))
    if neutral_source is None:      # not given: keep the stored choice
        neutral_source = stored_cfg.get("neutral_source") is True
    source = "claude-code" if neutral_source else "claude-code on <hostname>"
    # 1. plan (pure)
    settings, style, settings_text = load_settings(paths.settings)
    new_settings, info = install_with_info(settings, session_cmd=cmds["session"], prompt_cmd=cmds["prompt"],
                                           snapshot_cmd=cmds["snapshot"], allow=allow)
    new_settings_text = dumps(new_settings, style)
    md_text = _read(paths.claude_md)
    template = (src_kit / "templates" / "routing-rule.md").read_text(encoding="utf-8")
    block = render_rule(template, outbox_dir=paths.outbox, memkit_cmd=cmds["memkit"], source=source)
    new_md, sep = upsert_block(md_text or "", block)

    stored = _load_state(paths)
    if stored is None:
        state: Dict[str, Any] = {
            "version": STATE_VERSION, "auto_memory_previous": info["auto_memory_previous"],
            "added_rules": list(info["added_rules"]), "created": list(info["created"]),
            "settings_created": settings_text is None,
            "settings_blank_text": settings_text if settings_text is not None and not settings_text.strip() else None,
            "claude_md_created": md_text is None, "claude_md_sep": sep,
            "installed_at": now.strftime("%Y-%m-%dT%H:%M:%SZ")}
    else:
        state = dict(stored)
        state["version"] = STATE_VERSION
        if "auto_memory_previous" not in state:     # keep the stored value; a re-install reports None
            state["auto_memory_previous"] = info["auto_memory_previous"]
        state["added_rules"] = _union(state.get("added_rules"), info["added_rules"])
        state["created"] = _union(state.get("created"), info["created"])
        if sep is not None:     # the block had been removed by hand; remember the new separator
            state["claude_md_sep"] = sep

    if stored is None and info["auto_memory_previous"] is None:
        out("warning: the kit's hooks are already in settings.json but there is no state.json, so your previous "
            "auto-memory setting is unknown; uninstall will leave autoMemoryEnabled as it is (off).")
    if dry_run:
        out(_diff(paths.settings, settings_text or "", new_settings_text) or f"{paths.settings}: no change")
        out(_diff(paths.claude_md, md_text or "", new_md) or f"{paths.claude_md}: no change")
        backups = []
        if settings_text is not None and new_settings_text != settings_text:
            backups.append(f"{_real(paths.settings)}.bak-<time>")
        if md_text is not None and new_md != md_text:
            backups.append(f"{_real(paths.claude_md)}.memkit-backup-<time>")
        out("memory MCP servers: " + (", ".join(names) if names else "none found (rerun with --mcp-server <name>, "
                                      "the name shown by /mcp, to allow the read-only memory tools)"))
        out(f"would write {paths.config}, {paths.scopes} ({json.dumps(scope_map['scopes'], sort_keys=True)}), "
            f"{paths.state}, copy the kit to {paths.kit}/ and create {paths.outbox}, {paths.cache}, {paths.export}")
        out("would create backups: " + (", ".join(b.strip() for b in backups) or "none (no existing file changes)"))
        out("dry run: nothing was written.")
        return 0

    # 2. write: kit files and state first (so an interrupted install can still be uninstalled), then the user's files
    paths.root.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(paths.root, 0o700)
    if state != stored:
        _write_private(paths.state, json.dumps(state, indent=2) + "\n")
    _copy_kit(src_kit, paths.kit)
    cfg_out: Dict[str, Any] = {"worker_url": worker_url, "hook_version": HOOK_VERSION, "python": python,
                               "mcp_servers": names}
    if neutral_source:
        cfg_out["neutral_source"] = True
    _write_private(paths.config, json.dumps(cfg_out, indent=2) + "\n")
    _write_private(paths.scopes, json.dumps(scope_map, indent=2) + "\n")
    for d in (paths.outbox, paths.cache, paths.export):
        d.mkdir(mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
    if new_settings_text != (settings_text or ""):
        r = install_file(paths.settings, session_cmd=cmds["session"], prompt_cmd=cmds["prompt"],
                         snapshot_cmd=cmds["snapshot"], allow=allow)
        via = f" (symlink; wrote {r['wrote']})" if r["symlink"] else ""
        out(f"updated {paths.settings}{via} (auto-memory off, hooks, allow rules)"
            + (f"; backup {r['backup']}" if r["backup"] else ""))
    if new_md != (md_text or ""):
        _backup(paths.claude_md, now)
        write_atomic(_real(paths.claude_md), new_md)
        out(f"updated {paths.claude_md} (memory routing rule)")
    if names:
        out("memory tools allowed without prompting (read-only): " + ", ".join(names))
    else:
        out("note: no memory MCP server found in ~/.claude.json, so its read-only tools will still prompt. "
            "Rerun with --mcp-server <name> (the name shown by /mcp).")
    return print_preflight(paths, out=out, now=now)


def print_preflight(paths: KitPaths, *, out: Out = print, now: Optional[datetime] = None,
                    cwd: Optional[str] = None) -> int:
    r = session_report(cwd=cwd or os.getcwd(), paths=paths, env=os.environ, now=now or _now(),
                       managed=managed_path())
    if not r.problems:
        out("preflight: all local checks passed (memory server reachable, hooks current).")
        return 0
    out("preflight found problems:")
    for p in r.problems:
        out(f"  ⚠ {p}")
    return 1


def _fallback_rules(paths: KitPaths) -> List[str]:
    """The kit's Bash rule for each interpreter it may have been installed with (used only without state.json)."""
    cfg = load_config(paths.config) or {}
    pys = [cfg.get("python"), os.environ.get("MEMKIT_HOOK_PYTHON"), "/usr/bin/python3", sys.executable]
    out: List[str] = []
    for py in pys:
        if isinstance(py, str) and py:
            r = memkit_rule(commands(paths, py)["memkit"])
            if r not in out:
                out.append(r)
    names = cfg.get("mcp_servers")
    if isinstance(names, list):
        out += [r for r in mcp_rules([n for n in names if isinstance(n, str) and MCP_NAME_RE.fullmatch(n)])
                if r not in out]
    return out


def uninstall(paths: KitPaths, *, force: bool = False, delete_cache: Optional[bool] = None, dry_run: bool = False,
              out: Out = print, ask: Callable[[str], bool] = lambda q: False,
              now: Optional[datetime] = None) -> int:
    """0 ok, 3 queued entries block it. Raises SettingsError / MarkerError (before any write)."""
    now = now or _now()
    settings_text = _read(paths.settings)
    md_text = _read(paths.claude_md)
    hooks_present = HOOK_MARKER in (settings_text or "").replace("\\/", "/")
    if not paths.state.exists() and not hooks_present and not has_marker(md_text or "") and not paths.kit.exists():
        out("Nothing to uninstall.")
        return 0
    queued = list_entries(paths.outbox)
    if queued and not force:
        out(f"{len(queued)} memories are still queued in {paths.outbox}. Flush them first: start Claude Code in any repo "
            "with the claude-memory connector working; the session-start hook asks Claude to flush them. "
            "Or rerun with --force (the entries are kept in that folder, not deleted). Nothing was changed.")
        return 3

    # plan (pure)
    state = _load_state(paths)
    if state is None:
        out("warning: ~/.claude-memory-cloud/state.json is missing or unreadable, so restoring settings.json is "
            "best-effort: only the kit's own hook entries and allow rules are removed, and your auto-memory "
            "setting is left as it is.")
    st = state or {}
    prev = st.get("auto_memory_previous") if state else None
    added = st.get("added_rules") if state and isinstance(st.get("added_rules"), list) else None
    created = st.get("created") if state and isinstance(st.get("created"), list) else None
    fallback = _fallback_rules(paths)
    settings, style, _ = load_settings(paths.settings)
    new_settings = uninstall_settings(settings, prev, added_rules=added, created=created, fallback_rules=fallback)
    new_settings_text = dumps(new_settings, style)
    delete_settings = bool(st.get("settings_created")) and new_settings == {} and not os.path.islink(str(paths.settings))
    if new_settings == {} and isinstance(st.get("settings_blank_text"), str):
        new_settings_text = st["settings_blank_text"]
    new_md = remove_block(md_text or "", st.get("claude_md_sep"))
    delete_md = bool(st.get("claude_md_created")) and new_md == "" and not os.path.islink(str(paths.claude_md))

    if dry_run:
        if delete_settings:
            out(f"{paths.settings}: would be deleted (the install created it)")
        else:
            out(_diff(paths.settings, settings_text or "", new_settings_text) or f"{paths.settings}: no change")
        if delete_md:
            out(f"{paths.claude_md}: would be deleted (the install created it)")
        else:
            out(_diff(paths.claude_md, md_text or "", new_md) or f"{paths.claude_md}: no change")
        out(f"would remove {paths.kit}, {paths.export}, config.json, scopes.json, state.json; "
            f"{len(queued)} queued entries and the cache would be kept unless you confirm.")
        out("dry run: nothing was changed.")
        return 0

    if settings_text is not None and new_settings_text != settings_text:
        if delete_settings:
            _backup(paths.settings, now)
            paths.settings.unlink()
            out(f"removed {paths.settings} (the install created it; backup kept)")
        else:
            uninstall_file(paths.settings, prev, added_rules=added, created=created, fallback_rules=fallback)
            if new_settings_text != dumps(new_settings, style):    # blank original file
                write_atomic(_real(paths.settings), new_settings_text)
            out(f"restored {paths.settings} (auto-memory: "
                f"{'left as is' if prev is None else ('removed' if prev == ABSENT else json.dumps(prev))})")
    if md_text is not None and new_md != md_text:
        _backup(paths.claude_md, now)
        if delete_md:
            paths.claude_md.unlink()
        else:
            write_atomic(_real(paths.claude_md), new_md)
        out(f"removed the memory routing rule from {paths.claude_md}")
    shutil.rmtree(paths.kit, ignore_errors=True)
    shutil.rmtree(paths.export, ignore_errors=True)
    for f in (paths.config, paths.scopes, paths.state):
        if f.exists():
            f.unlink()
    if queued:
        out(f"kept {len(queued)} queued entries in {paths.outbox}")
    else:
        _rmdir_if_empty(paths.outbox, out)
    snaps = list(paths.cache.iterdir()) if paths.cache.is_dir() else []
    if snaps:
        if delete_cache is None:
            delete_cache = ask(f"Delete {len(snaps)} cached memory snapshots in {paths.cache}? [y/N] ")
        if delete_cache:
            shutil.rmtree(paths.cache)
        else:
            out(f"kept {paths.cache} (rerun with --delete-cache to remove it)")
    else:
        _rmdir_if_empty(paths.cache, out)
    try:
        paths.root.rmdir()
    except OSError:
        pass
    out("claude-memory-cloud kit removed. Restart running Claude Code sessions.")
    return 0


def _rmdir_if_empty(d: Path, out: Out) -> None:
    if not d.exists():
        return
    try:
        d.rmdir()
    except OSError:
        out(f"kept {d} (it holds files the kit did not create)")


def outbox_done(outbox: Path, names: List[str], out: Out = print, err: Out = lambda m: print(m, file=sys.stderr)) -> int:
    """Deletes flushed outbox entries. Accepts only plain entry filenames that are regular files (never a symlink)
    directly inside the outbox. 0 ok, 1 not found, 2 refused."""
    code = 0
    base = os.path.realpath(str(outbox))
    for n in names:
        if "/" in n or "\0" in n or not OUTBOX_NAME_RE.fullmatch(n):
            err(f"refused {n!r}: not an outbox entry filename")
            code = 2
            continue
        target = Path(outbox) / n
        try:
            st = target.lstat()
        except FileNotFoundError:
            err(f"not found: {n}")
            code = code or 1
            continue
        except OSError as e:
            err(f"refused {n!r}: {type(e).__name__}")
            code = 2
            continue
        if stat.S_ISLNK(st.st_mode) or not stat.S_ISREG(st.st_mode):
            err(f"refused {n!r}: not a regular file")
            code = 2
            continue
        if os.path.dirname(os.path.realpath(str(target))) != base:
            err(f"refused {n!r}: resolves outside the outbox")
            code = 2
            continue
        target.unlink()
        out(f"removed {n}")
    return code


def auto_memory_dir(home: Path, toplevel: str) -> Path:
    """Claude Code's auto-memory folder for a repo: ~/.claude/projects/<path with non-alphanumerics as '-'>/memory."""
    return Path(home) / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", toplevel) / "memory"


def export_prompt(paths: KitPaths, cwd: str, python: str) -> str:
    remote = git_origin(cwd)
    stage = paths.export / cache_key(remote)
    project = f"project = {remote}" if remote else "no project (this directory has no git origin)"
    return (
        "Paste this into a Claude Code session started in this directory, with the claude-memory connector working:\n\n"
        f"Export my claude-memory memories to local files. 1) Call memory_index with {project}. "
        "2) For scope general" + (" and scope project" if remote else "") + ", call memory_read with every name in "
        "that scope's index (at most 20 names per call). 3) For each memory, write the text between its <memory …> "
        f"tag and its closing tag, exactly as returned, to {stage}/general/<name>.md or {stage}/project/<name>.md. "
        f"4) Run `{commands(paths, python)['memkit']} export-finish --cwd {shlex.quote(cwd)}` and show me its output."
    )


def _unescape(text: str) -> str:
    return re.sub(r"&lt;(\s*/?\s*memory)", r"<\1", text)


def export_finish(paths: KitPaths, cwd: str, out: Out = print) -> int:
    top = git_toplevel(cwd) or str(Path(cwd).resolve())
    try:
        settings, _, _ = load_settings(paths.settings)
    except SettingsError as e:
        out(f"{e}")
        return 2
    if settings.get("autoMemoryDirectory"):
        out(f"autoMemoryDirectory is set in {paths.settings}; copy the files in {paths.export} there by hand.")
        return 2
    stage = paths.export / cache_key(git_origin(cwd))
    target = auto_memory_dir(paths.home, top)
    project_names = {p.stem for p in (stage / "project").glob("*.md")}
    index_lines: List[str] = []
    written = 0
    for scope in ("project", "general"):
        for src in sorted((stage / scope).glob("*.md")):
            if src.is_symlink() or not src.is_file():
                out(f"skipped {src.name}: not a regular file")
                continue
            text = _unescape(src.read_text(encoding="utf-8"))
            try:
                top_fm, _ = _frontmatter(text)
            except OutboxFormatError:
                out(f"skipped {src.name}: no memory frontmatter")
                continue
            name = src.stem if scope == "project" or src.stem not in project_names else f"general-{src.stem}"
            if name == "MEMORY":    # never collide with the index file
                name = "MEMORY.cloud"
            dst = target / f"{name}.md"
            n = 1
            while (dst.exists() or dst.is_symlink()) and (
                    dst.is_symlink() or not dst.is_file() or dst.read_text(encoding="utf-8") != text):
                n += 1      # never overwrite: name.cloud.md, name.cloud-2.md, ...
                dst = target / (f"{name}.cloud.md" if n == 2 else f"{name}.cloud-{n - 1}.md")
            if not dst.exists():
                write_atomic(dst, text)
                written += 1
            index_lines.append(f"- [{name}]({dst.name}) — {top_fm.get('description', '')}")
    index = target / "MEMORY.md"
    existing = index.read_text(encoding="utf-8") if index.exists() else ""
    new_lines = [ln for ln in index_lines if f"]({ln.split('](')[1].split(')')[0]})" not in existing]
    if new_lines and index.is_symlink():
        out(f"skipped the index: {index} is a symlink; add these lines to it yourself:")
        for ln in new_lines:
            out(ln)
        new_lines = []
    if new_lines:
        write_atomic(index, existing + ("" if existing.endswith("\n") or not existing else "\n")
                     + "\n".join(new_lines) + "\n")
    out(f"exported {written} memories to {target} ({len(new_lines)} new index lines)")
    return 0


def _ask_tty(q: str) -> bool:
    if not sys.stdin.isatty():
        return False
    return input(q).strip().lower() in ("y", "yes")


def main(argv: Optional[List[str]] = None, src_kit: Optional[Path] = None) -> int:
    ap = argparse.ArgumentParser(prog="setup.sh", description="claude-memory-cloud local kit")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--uninstall", action="store_true")
    mode.add_argument("--export-local", action="store_true")
    ap.add_argument("--worker-url")
    ap.add_argument("--scopes-file", type=Path)
    ap.add_argument("--login")
    ap.add_argument("--scope", action="append", default=[], metavar="NAME=OWNER/REPO")
    ap.add_argument("--mcp-server", action="append", default=[], metavar="NAME",
                    help="name of the memory MCP server as shown by /mcp (repeatable; detected from ~/.claude.json too)")
    ns = ap.add_mutually_exclusive_group()
    ns.add_argument("--neutral-source", dest="neutral_source", action="store_const", const=True,
                    help='pass source "claude-code" instead of "claude-code on <hostname>" (kept on reinstall)')
    ns.add_argument("--no-neutral-source", dest="neutral_source", action="store_const", const=False)
    ap.add_argument("--dry-run", action="store_true", help="print the planned changes (diffs) and write nothing")
    ap.add_argument("--force", action="store_true")
    cache = ap.add_mutually_exclusive_group()
    cache.add_argument("--delete-cache", dest="delete_cache", action="store_const", const=True)
    cache.add_argument("--keep-cache", dest="delete_cache", action="store_const", const=False)
    ap.add_argument("--finish", action="store_true")
    ap.add_argument("--cwd", default=os.getcwd())
    a = ap.parse_args(argv)
    if (a.force or a.delete_cache is not None) and not a.uninstall:
        ap.error("--force, --delete-cache and --keep-cache only apply to --uninstall")
    bad = [n for n in a.mcp_server if not MCP_NAME_RE.fullmatch(n)]
    if bad:
        ap.error(f"--mcp-server {bad[0]!r}: use only letters, digits, '_' and '-'")
    if a.mcp_server and (a.uninstall or a.export_local):
        ap.error("--mcp-server only applies to install")
    if a.neutral_source is not None and (a.uninstall or a.export_local):
        ap.error("--neutral-source only applies to install")
    if a.finish and not a.export_local:
        ap.error("--finish only applies to --export-local")
    paths = kit_paths()
    src_kit = src_kit or Path(__file__).resolve().parent.parent
    python = os.environ.get("MEMKIT_HOOK_PYTHON") or sys.executable

    try:
        if a.uninstall:
            return uninstall(paths, force=a.force, delete_cache=a.delete_cache, dry_run=a.dry_run, ask=_ask_tty)
        if a.export_local:
            if a.finish:
                return export_finish(paths, a.cwd)
            print(export_prompt(paths, a.cwd, python))
            return 0

        try:
            if a.scope:
                if not a.login:
                    ap.error("--scope needs --login <your github login>")
                scope_map = from_scope_args(a.scope, a.login)
            elif a.scopes_file:
                scope_map = from_scopes_file(a.scopes_file, a.login)
            else:
                scope_map = load_scope_map(paths.scopes)
        except ScopeMapError as e:
            print(f"setup: scope map: {e}. Pass --scopes-file scopes.<env>.json [--login LOGIN] "
                  "or --scope general=OWNER/claude-memory [--scope CLIENT=ORG/claude-memory] --login LOGIN.",
                  file=sys.stderr)
            return 2
        cfg = load_config(paths.config)
        worker_url = (a.worker_url or (cfg or {}).get("worker_url") or "").rstrip("/")
        if not WORKER_URL_RE.fullmatch(worker_url):
            print("setup: pass --worker-url https://<worker>.workers.dev (no path).", file=sys.stderr)
            return 2
        return install(paths, worker_url=worker_url, scope_map=scope_map, python=python, src_kit=src_kit,
                       mcp_servers=tuple(a.mcp_server), neutral_source=a.neutral_source, dry_run=a.dry_run)
    except (SettingsError, MarkerError) as e:
        print(f"setup: {e}", file=sys.stderr)
        print("Nothing was changed.", file=sys.stderr)
        return 2
    except Exception as e:      # OSError and anything unexpected: no traceback, say how to recover
        err = f"{type(e).__name__}: {e}"
        if a.uninstall:
            tail = "Fix the problem and rerun ./setup.sh --uninstall."
        elif a.export_local:
            tail = "Fix the problem and rerun the command."
        else:
            tail = "Fix the problem and rerun ./setup.sh, or run ./setup.sh --uninstall to undo what was done."
        what = "uninstall" if a.uninstall else ("export" if a.export_local else "install")
        print(f"setup: {what} stopped partway ({err}). Your previous files are backed up next to them. {tail}",
              file=sys.stderr)
        return 2
