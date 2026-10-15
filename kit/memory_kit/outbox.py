"""Outbox entries (spec §7 E): a memory file plus an `outbox:` frontmatter block.

Only the YAML subset Claude Code memory files use is accepted: top-level `key: value` lines and
one level of indented blocks (`metadata:`, `outbox:`). Values may be plain or double-quoted.
"""
from __future__ import annotations

import json
import os
import re
import stat
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional, Tuple

from .remote import normalize_remote

NAME_RE = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")
TYPES = ("user", "feedback", "project", "reference")
OPS = ("save", "delete")
TS_FORMAT = "%Y-%m-%dT%H:%M:%SZ"        # queued_at, e.g. 2026-10-13T18:04:00Z
FILE_TS_FORMAT = "%Y%m%dT%H%M%SZ"       # filename prefix, e.g. 20261013T180400Z
_NEEDS_QUOTES = re.compile(r"^[\s\"'#&*!|>%@`{\[\-?:,]|:\s|\s#|\s$")


class OutboxFormatError(ValueError):
    pass


@dataclass
class OutboxEntry:
    name: str
    op: str                 # save | delete
    scope: str              # general | <client> | project
    queued_at: str          # TS_FORMAT, UTC
    host: str = ""
    description: str = ""   # save only
    type: str = ""          # save only: metadata.type
    project: str = ""       # owner/repo, when scope is project
    version: str = ""       # blob sha the edit was based on; empty for a create
    body: str = ""          # save only


def parse_ts(s: str) -> datetime:
    try:
        return datetime.strptime(s, TS_FORMAT).replace(tzinfo=timezone.utc)
    except (TypeError, ValueError):
        raise OutboxFormatError(f"queued_at must look like 2026-10-13T18:04:00Z, got {s!r}") from None


def _scalar(raw: str) -> str:
    v = raw.strip()
    if v.startswith('"'):
        try:
            out = json.loads(v)
        except ValueError:
            raise OutboxFormatError(f"bad quoted value {v[:40]!r}") from None
        return str(out)
    if len(v) >= 2 and v[0] == v[-1] == "'":
        return v[1:-1].replace("''", "'")
    return re.sub(r"\s+#.*$", "", v)


def _frontmatter(text: str) -> Tuple[Dict[str, object], str]:
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        raise OutboxFormatError("no frontmatter")
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        raise OutboxFormatError("unterminated frontmatter")
    top: Dict[str, object] = {}
    block: Optional[Dict[str, str]] = None
    for ln in lines[1:end]:
        if not ln.strip() or ln.lstrip().startswith("#"):
            continue
        key, sep, val = ln.strip().partition(":")
        if not sep or not key.strip():
            raise OutboxFormatError(f"bad frontmatter line {ln.strip()[:40]!r}")
        if ln[:1] in (" ", "\t"):
            if block is None:
                raise OutboxFormatError("indented line outside a block")
            block[key.strip()] = _scalar(val)
        elif val.strip() == "":
            block = {}
            top[key.strip()] = block
        else:
            block = None
            top[key.strip()] = _scalar(val)
    body = "\n".join(lines[end + 1:])
    return top, body[1:] if body.startswith("\n") else body


def validate_entry(e: OutboxEntry) -> None:
    if not NAME_RE.fullmatch(e.name):
        raise OutboxFormatError(f"name {e.name!r} is not kebab-case")
    if e.op not in OPS:
        raise OutboxFormatError(f"outbox.op must be save or delete, got {e.op!r}")
    if not e.scope:
        raise OutboxFormatError("outbox.scope missing")
    if e.scope == "project" and not (e.project and normalize_remote(e.project)):
        raise OutboxFormatError("scope project needs outbox.project as owner/repo")
    parse_ts(e.queued_at)
    if e.op == "save":
        if not e.description or len(e.description) > 200 or "\n" in e.description:
            raise OutboxFormatError("save needs a one-line description of at most 200 characters")
        if e.type not in TYPES:
            raise OutboxFormatError(f"metadata.type must be one of {', '.join(TYPES)}")
        if not e.body.strip():
            raise OutboxFormatError("save needs a body")


def parse_entry(text: str) -> OutboxEntry:
    top, body = _frontmatter(text)
    ob = top.get("outbox")
    md = top.get("metadata", {})
    if not isinstance(ob, dict):
        raise OutboxFormatError("no outbox: block")
    if not isinstance(md, dict):
        raise OutboxFormatError("metadata must be a block")
    e = OutboxEntry(
        name=str(top.get("name", "")), op=ob.get("op", ""), scope=ob.get("scope", ""),
        queued_at=ob.get("queued_at", ""), host=ob.get("host", ""),
        description=str(top.get("description", "")), type=md.get("type", ""),
        project=ob.get("project", ""), version=ob.get("version", ""), body=body,
    )
    validate_entry(e)
    return e


def _q(v: str) -> str:
    return json.dumps(v, ensure_ascii=False) if v == "" or _NEEDS_QUOTES.search(v) else v


def format_entry(e: OutboxEntry) -> str:
    validate_entry(e)
    lines = ["---", f"name: {e.name}"]
    if e.description:
        lines.append(f"description: {_q(e.description)}")
    if e.type:
        lines += ["metadata:", f"  type: {e.type}"]
    lines += ["outbox:", f"  op: {e.op}", f"  scope: {_q(e.scope)}"]
    if e.project:
        lines.append(f"  project: {_q(e.project)}")
    if e.version:
        lines.append(f"  version: {_q(e.version)}")
    lines.append(f"  queued_at: {e.queued_at}")
    if e.host:
        lines.append(f"  host: {_q(e.host)}")
    lines += ["---", ""]
    return "\n".join(lines) + "\n" + e.body


def entry_filename(e: OutboxEntry) -> str:
    return f"{parse_ts(e.queued_at).strftime(FILE_TS_FORMAT)}-{e.name}.md"


@dataclass
class OutboxSummary:
    total: int = 0
    for_project: int = 0
    malformed: List[str] = field(default_factory=list)
    oldest_days: Optional[float] = None


MAX_ENTRY_BYTES = 64 * 1024


def list_entries(d: Path) -> List[Path]:
    """Oldest first (the filename starts with the UTC timestamp). Symlinks and other non-directories are
    listed too, so the scan can flag them; one unreadable entry never hides the rest."""
    out: List[Path] = []
    try:
        names = sorted(Path(d).iterdir())
    except OSError:
        return []
    for p in names:
        try:
            if p.suffix != ".md" or p.name.startswith(".") or stat.S_ISDIR(p.lstat().st_mode):
                continue
        except OSError:
            continue
        out.append(p)
    return out


def read_entry_text(p: Path) -> str:
    """Reads one regular, non-symlink entry of at most MAX_ENTRY_BYTES; raises OSError/UnicodeDecodeError otherwise."""
    st = p.lstat()
    if not stat.S_ISREG(st.st_mode):
        raise OSError("not a regular file")
    if st.st_size > MAX_ENTRY_BYTES:
        raise OSError("entry too large")
    fd = os.open(str(p), os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0))
    try:
        data = os.read(fd, MAX_ENTRY_BYTES + 1)
    finally:
        os.close(fd)
    if len(data) > MAX_ENTRY_BYTES:
        raise OSError("entry too large")
    return data.decode("utf-8")


def scan_outbox(d: Path, project: Optional[Tuple[str, str]], now: datetime) -> OutboxSummary:
    s = OutboxSummary()
    for p in list_entries(d):
        s.total += 1
        try:
            e = parse_entry(read_entry_text(p))
            since = parse_ts(e.queued_at)
            if project and e.scope == "project" and normalize_remote(e.project) == project:
                s.for_project += 1
        except (OutboxFormatError, OSError, UnicodeDecodeError):
            s.malformed.append(p.name)
            try:
                since = datetime.fromtimestamp(p.lstat().st_mtime, timezone.utc)
            except (OSError, OverflowError, ValueError):
                continue
        days = (now - since).total_seconds() / 86400
        s.oldest_days = days if s.oldest_days is None else max(s.oldest_days, days)
    return s
