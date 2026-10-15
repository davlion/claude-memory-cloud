"""Pure pass/fail checks shared by the scenarios. Each returns a list of failure notes (empty = pass)."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, List, Optional

from .gh import Found
from .transcript import Transcript

PASS, FAIL, SOFT_PASS, SOFT_FAIL, ERROR = "PASS", "FAIL", "SOFT-PASS", "SOFT-FAIL", "ERROR"
SKIPPED = "SKIPPED"   # recorded by hand for a scenario deliberately not run
PROBLEMS_MARK = "claude-memory preflight found problems"   # kit/memory_kit/session.py PROBLEMS_HEAD
COMPACT_MARK = "Context was compacted. Call memory_index again"  # session.py COMPACT_LINE
SNAPSHOT_MARK = "<memory-snapshot "
OUTBOX_MARK = "queued in outbox"


@dataclass
class Verdict:
    status: str
    notes: List[str] = field(default_factory=list)


def verdict(notes: Iterable[str], soft: bool = False) -> Verdict:
    notes = [n for n in notes if n]
    if soft:
        return Verdict(SOFT_FAIL if notes else SOFT_PASS, notes)
    return Verdict(FAIL if notes else PASS, notes)


def expect_one(found: List[Found], *, repo: str, project: Optional[str], scope: str) -> List[str]:
    """Exactly one non-conflict memory file holds the token, in `repo`, under projects/<project>/ or not, with
    the expected Memory-Scope trailer."""
    live = [f for f in found if not f.parts["conflict"]]
    paths = sorted({(f.repo, f.path) for f in live})
    if not paths:
        return [f"no memory with the token was committed (expected {repo}, scope {scope})"]
    notes = []
    if len(paths) > 1:
        notes.append(f"token is in {len(paths)} memories: {paths}")
    f = live[-1]
    if f.repo != repo:
        notes.append(f"saved to {f.repo}, expected {repo}")
    if f.parts["project"] != project:
        notes.append(f"saved under project {f.parts['project']!r}, expected {project!r} ({f.path})")
    if f.scope != scope:
        notes.append(f"Memory-Scope trailer {f.scope!r}, expected {scope!r}")
    return notes


def expect_none(found: List[Found]) -> List[str]:
    return [f"unexpected commit: {f.repo}/{f.path} ({f.sha[:7]})" for f in found]


def no_prompts(t: Transcript) -> List[str]:
    """A memory tool that needed a permission prompt (denied in -p) breaks the zero-prompt setup."""
    return [f"permission denied for {d}" for d in t.denials if "memory_" in d]


def announced(t: Transcript, phrase: str) -> List[str]:
    """The save announcement is a fixed protocol string (spec §7 D), so checking it is not checking wording."""
    return [] if phrase.lower() in t.final_text.lower() else [f"reply lacks the announcement {phrase!r}"]


def index_called(t: Transcript, project: Optional[str]) -> List[str]:
    calls = t.memory_calls("memory_index")
    if not calls:
        return ["memory_index was not called"]
    c = calls[0]
    notes = []
    if c.is_error or c.result is None:
        notes.append(f"memory_index failed: {(c.result or '')[:160]}")
    if c.input.get("project") != project:
        notes.append(f"memory_index project={c.input.get('project')!r}, expected {project!r}")
    return notes


def kit_healthy(t: Transcript) -> List[str]:
    ctx = t.kit_context()
    if not ctx:
        return ["the kit's SessionStart hook produced no context"]
    return ["preflight reported problems: " + ctx.split(PROBLEMS_MARK, 1)[1][:300]] if PROBLEMS_MARK in ctx else []


def problems(t: Transcript) -> List[str]:
    """The preflight problem lines in the kit's SessionStart context ("- …" lines after the problems head)."""
    ctx = t.kit_context()
    if PROBLEMS_MARK not in ctx:
        return []
    tail = ctx.split(PROBLEMS_MARK, 1)[1].split("\n\n", 1)[0]
    return [line[2:] for line in tail.splitlines() if line.startswith("- ")]


def exactly_one_problem(t: Transcript, fragment: str) -> List[str]:
    p = problems(t)
    if len(p) != 1:
        return [f"expected exactly one preflight problem, got {len(p)}: {p}"]
    return [] if fragment in p[0] else [f"problem line lacks {fragment!r}: {p[0]}"]
