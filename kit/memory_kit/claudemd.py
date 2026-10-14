"""Layer A: the routing rule block in ~/.claude/CLAUDE.md, delimited by marker lines."""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Tuple

BEGIN = "<!-- claude-memory-cloud:routing-rule:begin -->"
END = "<!-- claude-memory-cloud:routing-rule:end -->"


def has_marker(text: str) -> bool:
    return BEGIN in text


def render_rule(template: str, *, outbox_dir: Path, cache_dir: Path, memkit_cmd: str) -> str:
    body = (template.replace("{{OUTBOX_DIR}}", str(outbox_dir))
            .replace("{{CACHE_DIR}}", str(cache_dir))
            .replace("{{MEMKIT}}", memkit_cmd))
    return f"{BEGIN}\n{body.strip(chr(10))}\n{END}"


def upsert_block(text: str, block: str) -> Tuple[str, Optional[str]]:
    """Returns (new text, separator added before the block). The separator is None when an
    existing block was replaced in place, so a rerun never changes the surrounding text."""
    i = text.find(BEGIN)
    j = text.find(END, i) if i >= 0 else -1
    if i >= 0 and j >= 0:
        return text[:i] + block + text[j + len(END):], None
    sep = "" if text == "" else ("\n" if text.endswith("\n") else "\n\n")
    return text + sep + block + "\n", sep


def remove_block(text: str, sep: Optional[str]) -> str:
    """Inverse of upsert_block: removes the block, its trailing newline and the separator."""
    i = text.find(BEGIN)
    j = text.find(END, i) if i >= 0 else -1
    if i < 0 or j < 0:
        return text
    j += len(END)
    if text[j:j + 1] == "\n":
        j += 1
    before = text[:i]
    if sep and before.endswith(sep):
        before = before[:-len(sep)]
    return before + text[j:]
