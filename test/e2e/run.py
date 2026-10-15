#!/usr/bin/env python3
"""Level 4 runner (spec §9): drives `claude -p` on the test hosts and checks outcomes with `gh api`.

  run.py hosts                                   check each host is reachable and ready
  run.py run   --hosts H1,H3 --scenarios S1,S2   single-host scenarios (S2/S4/S5 repeat 3x)
  run.py pair  --a H1 --b H3 --scenarios S6,S9   two-host scenarios
  run.py probe --host H1 --expect-problem TEXT   one session; check the preflight / Health output
  run.py token --scenario S2                     manual hosts: print a prompt with a fresh token
  run.py verify --token T --scenario S2 --host H6
  run.py report                                  write results/<date>-<run>.md
  run.py cleanup                                 delete this run's test memories and outbox entries

Every command takes --run-id (default: the latest run, or a new one for `run`/`pair`/`token`)."""
from __future__ import annotations

import argparse
import json
import random
import string
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from e2elib import checks as C                         # noqa: E402
from e2elib import config, results, scenarios          # noqa: E402
from e2elib.cleanup import cleanup, cleanup_or_warn    # noqa: E402
from e2elib.gh import GitHub                           # noqa: E402
from e2elib.launch import Invocation, shell            # noqa: E402

HERE = Path(__file__).resolve().parent
RAW = HERE / "results" / "raw"
PROMPT_HINT_OFF = {"CLAUDE_MEMORY_KIT_PROMPT_HINT": "off"}
MANUAL_EXPECT = {"S2": "general", "S3": "client", "S4": "project", "S4n": "none", "S8": "none", "S11d": "none"}


def new_run_id() -> str:
    return "".join(random.choice(string.ascii_lowercase + string.digits) for _ in range(6))


def latest_run() -> str:
    runs = sorted(RAW.glob("*/meta.json"), key=lambda p: p.stat().st_mtime)
    if not runs:
        sys.exit("no runs yet")
    return runs[-1].parent.name


def open_run(run_id: str, create: bool, layers: str = "A+B+C") -> dict:
    meta_path = RAW / run_id / "meta.json"
    if meta_path.exists():
        return json.loads(meta_path.read_text())
    if not create:
        sys.exit(f"unknown run {run_id}")
    meta = {"run_id": run_id, "started": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "layers": layers}
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(meta))
    return meta


def make_ctx(cfg, meta) -> scenarios.Ctx:
    env = PROMPT_HINT_OFF if meta["layers"] == "A+C" else {}
    return scenarios.Ctx(cfg, GitHub(), meta["run_id"], RAW / meta["run_id"], env=env)


def save(meta, host, verdicts) -> bool:
    ok = True
    for sid, v in verdicts.items():
        results.record(RAW / meta["run_id"], host, sid, v, meta["layers"])
        print(f"  {host} {sid}: {v.status}" + (f" — {'; '.join(v.notes)}" if v.notes else ""))
        ok = ok and v.status not in (C.FAIL, C.ERROR)
    return ok


def guarded(sid, fn, *args) -> scenarios.Verdicts:
    """A crash in one scenario becomes an ERROR row under its id instead of stopping the run."""
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001
        return {sid: C.Verdict(C.ERROR, [f"{type(e).__name__}: {e}"[:300]])}


def cmd_hosts(cfg, args) -> int:
    bad = 0
    for h in cfg.hosts.values():
        dirs = " ".join(f'test -d {d} || echo "missing {k}={d}";' for k, d in h.dirs.items())
        try:
            out = shell(h, f"{h.claude} --version; {h.python} --version; gh --version >/dev/null 2>&1 || true; {dirs}")
            print(f"{h.id} {h.label}: " + " | ".join(out.split("\n")).strip(" |"))
            bad += out.count("missing ")
        except RuntimeError as e:
            print(f"{h.id} {h.label}: UNREACHABLE {e}")
            bad += 1
    return 1 if bad else 0


def cmd_run(cfg, args) -> int:
    meta = open_run(args.run_id or new_run_id(), True, args.layers)
    ctx, ok = make_ctx(cfg, meta), True
    print(f"run {meta['run_id']} ({meta['layers']})")
    for hid in args.hosts.split(","):
        host = cfg.hosts[hid]
        for sid in args.scenarios.split(","):
            fn = scenarios.SINGLE[sid]
            for i in range(cfg.repeats if sid in scenarios.REPEATED else 1):
                ok = save(meta, hid, guarded(sid, fn, ctx, host, i)) and ok
                if not args.keep:
                    cleanup_or_warn(ctx, meta["started"], [host])
    return 0 if ok else 1


def cmd_pair(cfg, args) -> int:
    meta = open_run(args.run_id or new_run_id(), True, args.layers)
    ctx, a, b, ok = make_ctx(cfg, meta), cfg.hosts[args.a], cfg.hosts[args.b], True
    print(f"run {meta['run_id']} ({meta['layers']}) pair {a.id}+{b.id}")
    for sid in args.scenarios.split(","):
        ok = save(meta, f"{a.id}+{b.id}", guarded(sid, scenarios.PAIR[sid], ctx, a, b)) and ok
        if not args.keep:
            cleanup_or_warn(ctx, meta["started"], [a, b])
    return 0 if ok else 1


def cmd_probe(cfg, args) -> int:
    meta = open_run(args.run_id or latest_run(), False)
    ctx, host = make_ctx(cfg, meta), cfg.hosts[args.host]
    t = ctx.claude(host, Invocation("hi", args.cwd), f"probe-{args.label}")
    if args.expect_problem:
        notes = C.exactly_one_problem(t, args.expect_problem)
    elif args.expect_health:
        health = " ".join(c.result or "" for c in t.memory_calls("memory_index"))
        notes = [] if args.expect_health in health else [f"Health block lacks {args.expect_health!r}"]
    else:
        notes = C.kit_healthy(t)
    return 0 if save(meta, args.host, {args.label: C.verdict(notes)}) else 1


def cmd_token(cfg, args) -> int:
    meta = open_run(args.run_id or new_run_id(), True, args.layers)
    ctx = make_ctx(cfg, meta)
    tok = f"e2e-{meta['run_id']}-m{random.randint(100, 999)}"
    values = {"token": tok, "secret": scenarios.fake_secret(random.Random(tok))}
    entry = {"token": tok, "scenario": args.scenario, "since": ctx.since()}
    with open(RAW / meta["run_id"] / "manual.jsonl", "a") as f:
        f.write(json.dumps(entry) + "\n")
    print(f"run {meta['run_id']}  token {tok}\n\nPaste this into the session:\n\n{ctx.prompt(args.scenario, args.i, **values)}")
    return 0


def cmd_verify(cfg, args) -> int:
    meta = open_run(args.run_id or latest_run(), False)
    ctx = make_ctx(cfg, meta)
    entries = [json.loads(x) for x in (RAW / meta["run_id"] / "manual.jsonl").read_text().splitlines() if x]
    entry = next(e for e in entries if e["token"] == args.token)
    found, kind = ctx.found(args.token, entry["since"]), MANUAL_EXPECT[args.scenario]
    if kind == "none":
        notes = C.expect_none(found)
    elif kind == "general":
        notes = C.expect_one(found, repo=cfg.general_repo, project=None, scope="general")
    elif kind == "client":
        notes = C.expect_one(found, repo=cfg.client_repo, project=None, scope=cfg.client_scope)
    else:
        notes = C.expect_one(found, repo=cfg.client_repo, project=ctx.sample_repo_name(), scope=ctx.project_scope())
    return 0 if save(meta, args.host, {args.scenario: C.verdict(notes)}) else 1


def cmd_report(cfg, args) -> int:
    meta = open_run(args.run_id or latest_run(), False)
    recs = results.load(RAW / meta["run_id"])
    hosts = sorted({r["host"] for r in recs}, key=lambda h: (len(h), h))
    labels = [(h, "+".join(cfg.hosts[x].label if x in cfg.hosts else x for x in h.split("+"))) for h in hosts]
    out = HERE / "results" / f"{meta['started'][:10]}-{meta['run_id']}.md"
    out.write_text(results.render(meta["run_id"], recs, labels), encoding="utf-8")
    print(out)
    return 0


def cmd_cleanup(cfg, args) -> int:
    meta = open_run(args.run_id or latest_run(), False)
    for line in cleanup(make_ctx(cfg, meta), meta["started"], list(cfg.hosts.values())):
        print("removed", line)
    return 0


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--run-id")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("hosts")
    for name in ("run", "pair", "token"):
        s = sub.add_parser(name)
        s.add_argument("--layers", choices=["A+C", "A+B+C"], default="A+B+C")
    sub.choices["run"].add_argument("--hosts", required=True)
    sub.choices["run"].add_argument("--scenarios", required=True)
    sub.choices["pair"].add_argument("--a", required=True)
    sub.choices["pair"].add_argument("--b", required=True)
    sub.choices["pair"].add_argument("--scenarios", required=True)
    for name in ("run", "pair"):
        sub.choices[name].add_argument("--keep", action="store_true", help="skip cleanup after each scenario")
    s = sub.add_parser("probe")
    s.add_argument("--host", required=True)
    s.add_argument("--cwd", default="kit_repo")
    s.add_argument("--label", default="S12")
    g = s.add_mutually_exclusive_group()
    g.add_argument("--expect-problem")
    g.add_argument("--expect-health")
    sub.choices["token"].add_argument("--scenario", required=True, choices=sorted(MANUAL_EXPECT))
    sub.choices["token"].add_argument("--i", type=int, default=0)
    s = sub.add_parser("verify")
    s.add_argument("--token", required=True)
    s.add_argument("--scenario", required=True, choices=sorted(MANUAL_EXPECT))
    s.add_argument("--host", required=True)
    sub.add_parser("report")
    sub.add_parser("cleanup")
    args = p.parse_args(argv)
    cfg = config.load()
    return {"hosts": cmd_hosts, "run": cmd_run, "pair": cmd_pair, "probe": cmd_probe, "token": cmd_token,
            "verify": cmd_verify, "report": cmd_report, "cleanup": cmd_cleanup}[args.cmd](cfg, args)


if __name__ == "__main__":
    sys.exit(main())
