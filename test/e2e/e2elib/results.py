"""Record verdicts (results/raw/<run>/records.jsonl, gitignored) and render the host x scenario grid
(results/<date>.md, committed). Notes are the runner's own strings; memory content never goes in them."""
from __future__ import annotations

import json
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Tuple

from .checks import ERROR, FAIL, PASS, SKIPPED, SOFT_FAIL, SOFT_PASS, Verdict

ORDER = ["S0", "S1", "S2", "S3", "S4", "S4n", "S5", "S6", "S6p", "S7", "S8", "S9", "S10", "S11", "S11b", "S11c",
         "S11d", "S11e", "S11f", "S12", "S12h", "S13", "S14", "S15", "S16", "S17", "U1"]


def record(run_dir: Path, host: str, scenario: str, v: Verdict, layers: str) -> None:
    run_dir.mkdir(parents=True, exist_ok=True)
    with open(run_dir / "records.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"host": host, "scenario": scenario, "status": v.status, "notes": v.notes,
                            "layers": layers}) + "\n")


def load(run_dir: Path) -> List[dict]:
    p = run_dir / "records.jsonl"
    if not p.exists():
        return []
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines() if line.strip()]


def cell(statuses: List[str]) -> str:
    """One grid cell. Hard results: PASS only if every run passed. Soft results never read as FAIL."""
    n = len(statuses)
    if all(s == SKIPPED for s in statuses):
        return "skipped"
    if all(s in (SOFT_PASS, SOFT_FAIL) for s in statuses):
        ok = statuses.count(SOFT_PASS)
        return "soft ✓" if ok == n else f"soft ✗ {ok}/{n}"
    ok = statuses.count(PASS)
    if ERROR in statuses:
        return f"ERROR {ok}/{n}"
    return ("PASS" if ok == n else "FAIL") + (f" {ok}/{n}" if n > 1 else "")


def render(run_id: str, records: List[dict], hosts: List[Tuple[str, str]]) -> str:
    """Markdown: a grid (rows: scenarios, columns: hosts) then the notes of every non-pass."""
    if not records:
        return f"# Level 4 results — run {run_id}\n\nNo results recorded.\n"
    grid: Dict[Tuple[str, str], List[str]] = {}
    layers = sorted({r["layers"] for r in records})
    for r in records:
        grid.setdefault((r["scenario"], r["host"]), []).append(r["status"])
    rows = [s for s in ORDER if any(k[0] == s for k in grid)]
    out = [f"# Level 4 results — run {run_id}", "", f"Layers: {', '.join(layers)}", "",
           "| Scenario | " + " | ".join(f"{h} {label}" for h, label in hosts) + " |",
           "|---|" + "---|" * len(hosts)]
    for s in rows:
        out.append(f"| {s} | " + " | ".join(cell(grid[(s, h)]) if (s, h) in grid else "—" for h, _ in hosts) + " |")
    failures = OrderedDict()
    for r in records:
        if r["status"] not in (PASS, SOFT_PASS) or (r["status"] == SOFT_PASS and r["notes"]):
            failures.setdefault(f"{r['scenario']} on {r['host']}", []).extend(r["notes"])
    if failures:
        out += ["", "## Notes", ""]
        for k, notes in failures.items():
            out.append(f"- **{k}:** " + "; ".join(dict.fromkeys(notes)))
    return "\n".join(out) + "\n"
