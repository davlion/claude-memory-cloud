"""Layer A: the routing rule block in ~/.claude/CLAUDE.md, delimited by marker lines."""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple

BEGIN = "<!-- claude-memory-cloud:routing-rule:begin -->"
END = "<!-- claude-memory-cloud:routing-rule:end -->"


class MarkerError(ValueError):
    """The routing-rule markers in CLAUDE.md are unbalanced; nothing was changed."""


def _find_block(text: str) -> Optional[Tuple[int, int]]:
    """(begin index, end index) of the single well-formed block, None when there is none."""
    nb, ne = text.count(BEGIN), text.count(END)
    if nb == 0 and ne == 0:
        return None
    i, j = text.find(BEGIN), text.find(END)
    if nb != 1 or ne != 1 or j < i:
        raise MarkerError(
            f"CLAUDE.md has {nb} begin and {ne} end routing-rule markers (expected one of each, begin first). "
            "Fix it by hand: remove stray marker lines, then run again. Nothing was changed.")
    return i, j


def has_marker(text: str) -> bool:
    return BEGIN in text


def render_rule(template: str, *, outbox_dir: Path, memkit_cmd: str) -> str:
    body = template.replace("{{OUTBOX_DIR}}", str(outbox_dir)).replace("{{MEMKIT}}", memkit_cmd)
    return f"{BEGIN}\n{body.strip(chr(10))}\n{END}"


def upsert_block(text: str, block: str) -> Tuple[str, Optional[str]]:
    """Returns (new text, separator added before the block). The separator is None when an
    existing block was replaced in place, so a rerun never changes the surrounding text."""
    found = _find_block(text)
    if found:
        i, j = found
        return text[:i] + block + text[j + len(END):], None
    sep = "" if text == "" else ("\n" if text.endswith("\n") else "\n\n")
    return text + sep + block + "\n", sep


def remove_block(text: str, sep: Optional[str]) -> str:
    """Inverse of upsert_block: removes the block, its trailing newline and the separator."""
    found = _find_block(text)
    if not found:
        return text
    i, j = found
    j += len(END)
    if text[j:j + 1] == "\n":
        j += 1
    before = text[:i]
    if sep and before.endswith(sep):
        before = before[:-len(sep)]
    return before + text[j:]
