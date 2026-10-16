"""Level 4 scenarios (spec §9). Each returns {scenario id: Verdict}; one run can decide several rows."""
from __future__ import annotations

import json
import random
import re
import shlex
import string
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

from . import checks as C
from .config import Config
from .gh import GitHub
from .launch import Host, Invocation, RunResult, run_claude, shell
from .transcript import Transcript

SAVE = ("memory_save",)
SAVE_DELETE = ("memory_save", "memory_delete")
Verdicts = Dict[str, C.Verdict]


class Ctx:
    """Everything a scenario needs; tests replace `claude`, `sh` and `gh`."""

    def __init__(self, cfg: Config, gh: GitHub, run_id: str, raw_dir: Path,
                 claude: Callable[[Host, Invocation], RunResult] = run_claude,
                 sh: Callable[[Host, str], str] = shell,
                 now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
                 env: Optional[Dict[str, str]] = None) -> None:
        self.cfg, self.gh, self.run_id, self.raw_dir = cfg, gh, run_id, raw_dir
        self.env = dict(env or {})   # added to every claude run, e.g. the prompt-hook switch for the A+C run
        self._claude, self.sh, self.now = claude, sh, now
        self._n = 0

    # ---- identifiers and time
    def token(self) -> str:
        """Unique per memory; cleanup finds everything by the `e2e-<run_id>-` prefix."""
        self._n += 1
        return f"e2e-{self.run_id}-{self._n:02d}"

    def since(self) -> str:
        return (self.now() - timedelta(seconds=5)).strftime("%Y-%m-%dT%H:%M:%SZ")

    def prompt(self, key: str, i: int = 0, **values: str) -> str:
        options = self.cfg.prompts[key]
        return options[i % len(options)].format(**values)

    # ---- running things
    def claude(self, host: Host, inv: Invocation, label: str) -> Transcript:
        inv.env = {**self.env, **inv.env}
        r = self._claude(host, inv)
        self.raw_dir.mkdir(parents=True, exist_ok=True)
        (self.raw_dir / f"{host.id}-{label}-{self._n:02d}.jsonl").write_text(r.stdout, encoding="utf-8")
        if r.timed_out:
            r.transcript.texts.append("[e2e: timed out]")
        return r.transcript

    def found(self, token: str, since: str):
        return self.gh.find(self.cfg.repos, since, token)

    def marker(self, host: Host, token: str) -> str:
        path = f"/tmp/{token}.marker"
        self.sh(host, f"touch {path}")
        return path

    def auto_memory_writes(self, host: Host, marker: str) -> List[str]:
        out = self.sh(host, f"find ~/.claude/projects -path '*/memory/*' -type f -newer {marker} 2>/dev/null; true")
        return [f"auto-memory file written: {p}" for p in out.split()]

    def outbox_files(self, host: Host, token: str) -> List[str]:
        return self.sh(host, f"grep -l -- {shlex.quote(token)} ~/.claude-memory-cloud/outbox/*.md 2>/dev/null; true").split()

    def mtime(self, host: Host, path: str) -> Optional[int]:
        out = self.sh(host, f"{host.python} -c 'import os,sys; print(int(os.path.getmtime(os.path.expanduser(sys.argv[1]))))' "
                            f"{shlex.quote(path)} 2>/dev/null; true").strip()
        return int(out) if out.isdigit() else None

    def project_scope(self) -> str:
        return f"project:{self.cfg.sample_project}"

    def sample_repo_name(self) -> str:
        return self.cfg.sample_project.split("/", 1)[1]


# ---------- single-host scenarios

def s1_s12h(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    """S1: index read unprompted (and with the right project). S12h: healthy preflight says nothing."""
    t = ctx.claude(host, Invocation("hi", "sample_app"), "S1")
    return {"S1": C.verdict(C.index_called(t, ctx.cfg.sample_project) + C.no_prompts(t)),
            "S12h": C.verdict(C.kit_healthy(t))}


def _routed_save(ctx: Ctx, host: Host, key: str, i: int, cwd: str, *, repo: str, project: Optional[str],
                 scope: str, announce: str) -> Verdicts:
    tok = ctx.token()
    since, marker = ctx.since(), ctx.marker(host, tok)
    t = ctx.claude(host, Invocation(ctx.prompt(key, i, token=tok), cwd, allow=SAVE), key)
    auto = ctx.auto_memory_writes(host, marker)
    notes = C.expect_one(ctx.found(tok, since), repo=repo, project=project, scope=scope)
    notes += C.announced(t, announce) + C.no_prompts(t)
    return {key: C.verdict(notes + auto), "S0": C.verdict(auto)}


def s2(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    return _routed_save(ctx, host, "S2", i, "sample_app", repo=ctx.cfg.general_repo, project=None,
                        scope="general", announce="saved to general")


def s3(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    return _routed_save(ctx, host, "S3", i, "sample_app", repo=ctx.cfg.client_repo, project=None,
                        scope=ctx.cfg.client_scope, announce=f"saved to {ctx.cfg.client_scope}")


def s4(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    return _routed_save(ctx, host, "S4", i, "sample_app", repo=ctx.cfg.client_repo, project=ctx.sample_repo_name(),
                        scope=ctx.project_scope(), announce="saved to project")


def s4n(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    tok = ctx.token()
    since = ctx.since()
    t = ctx.claude(host, Invocation(ctx.prompt("S4n", i, token=tok), "no_remote", allow=SAVE), "S4n")
    project_saves = [c for c in t.memory_calls("memory_save") if c.input.get("scope") == "project"
                     and c.status in ("created", "updated")]
    notes = C.expect_none(ctx.found(tok, since)) + [f"project save succeeded: {c.input}" for c in project_saves]
    return {"S4n": C.verdict(notes)}


def s5(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    tok = ctx.token()
    since = ctx.since()
    t = ctx.claude(host, Invocation(ctx.prompt("S5", i, token=tok), "sample_app", allow=SAVE), "S5")
    notes = [f"saved without asking: {c.input.get('scope')}" for c in t.memory_calls("memory_save")]
    notes += C.expect_none(ctx.found(tok, since))
    if "?" not in t.final_text:
        notes.append("reply asks no question")
    return {"S5": C.verdict(notes)}


def fake_secret(rng: random.Random) -> str:
    """Matches the server's aws-access-key rule (src/secrets.ts); not a real key."""
    return "AKIA" + "".join(rng.choice(string.ascii_uppercase + string.digits) for _ in range(16))


def s8(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    tok = ctx.token()
    since = ctx.since()
    secret = fake_secret(random.Random(tok))
    t = ctx.claude(host, Invocation(ctx.prompt("S8", i, token=tok, secret=secret), "sample_app", allow=SAVE), "S8")
    notes = C.expect_none(ctx.found(tok, since))
    notes += [f"memory_save returned {c.status}" for c in t.memory_calls("memory_save")
              if c.status not in (None, "rejected_secret")]
    notes += C.announced(t, "not saved")
    return {"S8": C.verdict(notes)}


def s11_chain(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    """S11f (fresh snapshot), S11 (queue), S11e (stale snapshot shown), S11b (flush) — in that order."""
    out: Verdicts = {}
    key = ctx.cfg.kit_project.lower().replace("/", "__")
    start = int(ctx.now().timestamp()) - 1
    t = ctx.claude(host, Invocation("hi", "kit_repo"), "S11f")
    m = ctx.mtime(host, f"~/.claude-memory-cloud/cache/{key}.md")
    out["S11f"] = C.verdict(C.index_called(t, ctx.cfg.kit_project) +
                            ([] if m is not None and m >= start else [f"snapshot not rewritten (mtime {m}, run {start})"]))

    tok = ctx.token()
    since = ctx.since()
    t = ctx.claude(host, Invocation(ctx.prompt("S2", i, token=tok), "kit_repo", allow=SAVE, no_connector=True), "S11")
    queued = ctx.outbox_files(host, tok)
    out["S11"] = C.verdict(C.expect_none(ctx.found(tok, since)) + C.announced(t, "queued in outbox for general") +
                           ([] if len(queued) == 1 else [f"expected one outbox entry, found {queued}"]))

    t = ctx.claude(host, Invocation("hi", "kit_repo", no_connector=True), "S11e")
    ctx_text = t.kit_context()
    out["S11e"] = C.verdict(([] if C.SNAPSHOT_MARK in ctx_text else ["no stale snapshot in the SessionStart context"]) +
                            [f"memory call succeeded: {c.short}" for c in t.memory_calls() if not c.is_error])

    t = ctx.claude(host, Invocation("hi", "kit_repo", allow=SAVE), "S11b")
    notes = [] if C.OUTBOX_MARK in t.kit_context() else ["hook did not report the queued entry"]
    notes += C.expect_one(ctx.found(tok, since), repo=ctx.cfg.general_repo, project=None, scope="general")
    left = ctx.outbox_files(host, tok)
    notes += [f"outbox entry not removed: {left}"] if left else []
    out["S11b"] = C.verdict(notes + C.no_prompts(t))
    return out


def s14_s7(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    """S14: after /compact the hook prompts a re-index and the early memory is still known. S7: a save
    after compaction still routes correctly."""
    sid = str(uuid.uuid4())
    tok1, since = ctx.token(), ctx.since()
    ctx.claude(host, Invocation(ctx.prompt("S2", i, token=tok1), "sample_app", allow=SAVE, session_id=sid), "S14a")
    t2 = ctx.claude(host, Invocation("/compact", "sample_app", resume=sid), "S14b")
    t3 = ctx.claude(host, Invocation("What is the e2e marker I asked you to remember earlier in this session?",
                                     "sample_app", resume=sid), "S14c")
    notes = [] if any(C.COMPACT_MARK in h.context for h in t2.hooks + t3.hooks) else ["no compaction re-index line"]
    if not (t2.memory_calls("memory_index") or t3.memory_calls("memory_index")):
        notes.append("memory_index not called after compaction")
    if tok1 not in t3.final_text:
        notes.append("early memory not recalled")
    tok2 = ctx.token()
    t4 = ctx.claude(host, Invocation(ctx.prompt("S2", i + 1, token=tok2), "sample_app", allow=SAVE, resume=sid), "S7")
    s7 = C.expect_one(ctx.found(tok2, since), repo=ctx.cfg.general_repo, project=None, scope="general")
    return {"S14": C.verdict(notes), "S7": C.verdict(s7 + C.announced(t4, "saved to general"))}


def s16(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    """Soft: parallel saves where a call may fail in transit (ECONNRESET). Each fact must end up stored exactly
    once, with no duplicate or conflict copies. Informational: a dropped connection is often GitHub's or the
    network's, so this never fails the run."""
    base = ctx.token()
    facts = ctx.cfg.prompts["S16_facts"]
    marks = [f"{base}-{n}" for n in range(1, len(facts) + 1)]
    lines = "\n".join(f"- {m}: {f}" for m, f in zip(marks, facts))
    since = ctx.since()
    t = ctx.claude(host, Invocation(ctx.prompt("S16", i, facts=lines), "sample_app", allow=SAVE, max_turns=20), "S16")
    notes, dropped = [], [c for c in t.memory_calls("memory_save") if c.is_error and c.status is None]
    for m in marks:
        hits = ctx.found(m, since)
        live = {f.path for f in hits if not f.parts["conflict"]}
        conflicts = {f.path for f in hits if f.parts["conflict"]}
        if len(live) != 1:
            notes.append(f"{m}: stored {len(live)} times")
        if conflicts:
            notes.append(f"{m}: conflict copies {sorted(conflicts)}")
    v = C.verdict(notes, soft=True)
    v.notes.append(f"{len(t.memory_calls('memory_save'))} save calls, {len(dropped)} failed in transit")
    return {"S16": v}


def s17(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    """S17: the user's recourse when a memory lands in the wrong scope — "move that memory to <scope>". There is no
    move tool: Claude reads, saves in the new scope and deletes the old copy (a delete prompts in real use; here it
    is pre-approved). Pass: one live copy in the project scope, none left in general, and "saved to project"."""
    name, since, sid = ctx.token(), ctx.since(), str(uuid.uuid4())
    ctx.claude(host, Invocation(ctx.prompt("named_save", name=name, body=f"original {name}"), "sample_app",
                                allow=SAVE, session_id=sid), "S17a")
    t = ctx.claude(host, Invocation(ctx.prompt("S17_move", name=name, target="this project (sample-app)"),
                                    "sample_app", allow=SAVE_DELETE, resume=sid), "S17b")
    live = [f for f in ctx.found(name, since) if not f.parts["conflict"] and ctx.gh.exists(f.repo, f.path)]
    notes = C.expect_one([f for f in live if f.repo == ctx.cfg.client_repo] or live, repo=ctx.cfg.client_repo,
                         project=ctx.sample_repo_name(), scope=ctx.project_scope())
    notes += [f"old copy still in {f.repo}: {f.path}" for f in live if f.repo == ctx.cfg.general_repo]
    notes += C.announced(t, "saved to project")
    return {"S17": C.verdict(notes)}


def s18(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    """S18: a clearly personal fact is refused (rejected_personal): nothing committed anywhere, "not saved"."""
    tok, since = ctx.token(), ctx.since()
    t = ctx.claude(host, Invocation(ctx.prompt("S18", i, token=tok), "sample_app", allow=SAVE), "S18")
    notes = C.expect_none(ctx.found(tok, since)) + C.announced(t, "not saved") + C.no_prompts(t)
    return {"S18": C.verdict(notes)}


def s19(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    """S19: a candid opinion is not saved until the user says so (needs_confirmation); then exactly one memory in
    general and none in the client repo."""
    tok, since, sid = ctx.token(), ctx.since(), str(uuid.uuid4())
    ctx.claude(host, Invocation(ctx.prompt("S19", i, token=tok), "sample_app", allow=SAVE, session_id=sid), "S19a")
    notes = [f"saved before the user confirmed: {n}" for n in C.expect_none(ctx.found(tok, since))]
    t = ctx.claude(host, Invocation(ctx.prompt("S19_yes"), "sample_app", allow=SAVE, resume=sid), "S19b")
    notes += C.expect_one(ctx.found(tok, since), repo=ctx.cfg.general_repo, project=None, scope="general")
    notes += C.announced(t, "saved to general") + C.no_prompts(t)
    return {"S19": C.verdict(notes)}


def s20(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    """S20: a fact about this client that names another configured client, given in this client's repo, never puts
    the other client's name in this client's repo and is never sent to the other client's scope. Claude may refuse
    ("not saved", by itself or via rejected_cross_client) or save only this client's part ("saved to").
    Needs a second client scope in staging SCOPES; without `second_client_scope` in e2e.json it is skipped."""
    other = ctx.cfg.second_client_scope
    if not other:
        return {"S20": C.Verdict(C.SKIPPED, ["needs a second client scope in staging SCOPES"])}
    tok, since = ctx.token(), ctx.since()
    t = ctx.claude(host, Invocation(ctx.prompt("S20", i, token=tok, client=other), "sample_app", allow=SAVE), "S20")
    found = ctx.found(tok, since)
    names_other = re.compile(rf"(?<!\w){re.escape(other)}(?!\w)", re.I)
    notes = C.expect_none([f for f in found if f.repo != ctx.cfg.client_repo])
    saved = [f for f in found if f.repo == ctx.cfg.client_repo]
    notes += [f"committed text names {other}: {f.repo}/{f.path}" for f in saved
              if names_other.search(ctx.gh.file_text(f.repo, f.path, f.sha) or "")]
    if any(c.input.get("scope") == other for c in t.memory_calls("memory_save")):
        notes.append(f"saved to {other}'s scope instead of refusing")
    notes += C.announced(t, "saved to" if saved else "not saved") + C.no_prompts(t)
    return {"S20": C.verdict(notes)}


# ---------- two-host scenarios (a: the Mac, b: a VM)

def _save_named(ctx: Ctx, host: Host, name: str, body: str, label: str) -> Transcript:
    return ctx.claude(host, Invocation(ctx.prompt("named_save", name=name, body=body), "sample_app", allow=SAVE), label)


def s6(ctx: Ctx, a: Host, b: Host, project: bool = False) -> Verdicts:
    tok, since = ctx.token(), ctx.since()
    key = "S4" if project else "S2"
    ctx.claude(a, Invocation(ctx.prompt(key, 0, token=tok), "sample_app", allow=SAVE), "S6a")
    live = [f for f in ctx.found(tok, since) if not f.parts["conflict"]]
    if not live:
        return {"S6": C.verdict(["the save on host A did not land"])}
    name = live[0].parts["name"] or ""
    t = ctx.claude(b, Invocation("hi", "sample_app"), "S6b")
    seen = any(name in (c.result or "") for c in t.memory_calls("memory_index"))
    return {"S6": C.verdict([] if seen else [f"{name} not in host B's session-start index"])}


def s9(ctx: Ctx, a: Host, b: Host) -> Verdicts:
    name, since = ctx.token(), ctx.since()
    _save_named(ctx, a, name, f"original {name}", "S9-0")
    sa, sb = str(uuid.uuid4()), str(uuid.uuid4())
    read = ctx.prompt("named_read", name=name)
    ctx.claude(a, Invocation(read, "sample_app", session_id=sa), "S9-a1")
    ctx.claude(b, Invocation(read, "sample_app", session_id=sb), "S9-b1")
    ta = ctx.claude(a, Invocation(ctx.prompt("named_update", name=name, body=f"edited on A {name}"), "sample_app",
                                  allow=SAVE, resume=sa), "S9-a2")
    tb = ctx.claude(b, Invocation(ctx.prompt("named_update", name=name, body=f"edited on B {name}"), "sample_app",
                                  allow=SAVE, resume=sb), "S9-b2")
    notes = [] if [c.status for c in ta.memory_calls("memory_save")][-1:] == ["updated"] else ["host A's update did not apply"]
    if "conflict" not in [c.status for c in tb.memory_calls("memory_save")]:
        notes.append("host B's stale update did not produce a conflict")
    copies = [f.path for f in ctx.found(f"edited on B {name}", since) if f.parts["conflict"]]
    if not copies:
        return {"S9": C.verdict(notes + ["no conflict copy in the repo"])}
    sc = str(uuid.uuid4())
    ctx.claude(a, Invocation("hi", "sample_app", allow=SAVE_DELETE, session_id=sc), "S9-c1")
    ctx.claude(a, Invocation(ctx.prompt("reconcile_yes"), "sample_app", allow=SAVE_DELETE, resume=sc), "S9-c2")
    if ctx.gh.exists(ctx.cfg.general_repo, copies[0]):
        notes.append(f"conflict copy {copies[0]} still there after reconciling")
    return {"S9": C.verdict(notes)}


def s11c(ctx: Ctx, a: Host, b: Host) -> Verdicts:
    name, since = ctx.token(), ctx.since()
    _save_named(ctx, a, name, f"original {name}", "S11c-0")
    sa = str(uuid.uuid4())
    ctx.claude(a, Invocation(ctx.prompt("named_read", name=name), "sample_app", session_id=sa), "S11c-a1")
    queued = f"queued on A {name}"
    ctx.claude(a, Invocation(ctx.prompt("named_update", name=name, body=queued), "sample_app", allow=SAVE,
                             resume=sa, no_connector=True), "S11c-a2")
    notes = [] if len(ctx.outbox_files(a, name)) == 1 else ["host A did not queue the update"]
    ctx.claude(b, Invocation(ctx.prompt("named_read_update", name=name, body=f"edited on B {name}"), "sample_app",
                             allow=SAVE), "S11c-b")
    ctx.claude(a, Invocation("hi", "sample_app", allow=SAVE), "S11c-a3")
    copies = [f.path for f in ctx.found(queued, since) if f.parts["conflict"]]
    plain = [f.path for f in ctx.found(queued, since) if not f.parts["conflict"]]
    notes += [] if copies else ["the stale queued update did not become a conflict copy"]
    notes += [f"the stale queued update overwrote the memory: {plain}"] if plain else []
    notes += [f"outbox entry not removed: {ctx.outbox_files(a, name)}"] if ctx.outbox_files(a, name) else []
    return {"S11c": C.verdict(notes)}


def s13(ctx: Ctx, a: Host, b: Host) -> Verdicts:
    sb = str(uuid.uuid4())
    ctx.claude(b, Invocation("hi", "sample_app", session_id=sb), "S13-b1")
    name = ctx.token()
    _save_named(ctx, a, name, f"saved on A while B runs {name}", "S13-a")
    t = ctx.claude(b, Invocation(ctx.prompt("named_search", name=name), "sample_app", resume=sb), "S13-b2")
    results = " ".join(c.result or "" for c in t.memory_calls())
    notes = [] if "Memory changed since your index" in results else ["no change notice in host B's tool results"]
    notes += [] if name in results else [f"{name} not in host B's results"]
    return {"S13": C.verdict(notes)}


def u1(ctx: Ctx, host: Host, i: int = 0) -> Verdicts:
    """After `setup.sh --uninstall` and with the connector removed: no kit hooks, no memory tool calls,
    and auto-memory writes locally again. The user runs the uninstall and the reinstall (Task 11)."""
    t = ctx.claude(host, Invocation("hi", "sample_app", no_connector=True), "U1a")
    notes = ["kit SessionStart hook still fires"] if t.kit_context() else []
    notes += [f"memory tool called: {c.short}" for c in t.memory_calls()]
    # stream-json carries no UserPromptSubmit hook output, so check the registration itself
    hooks = ctx.sh(host, "grep -c /.claude-memory-cloud/kit/hooks/ ~/.claude/settings.json 2>/dev/null; true").strip()
    if hooks.isdigit() and int(hooks):
        notes.append(f"kit hooks still registered in ~/.claude/settings.json ({hooks})")
    tok = ctx.token()
    marker = ctx.marker(host, tok)
    t = ctx.claude(host, Invocation(ctx.prompt("U1", token=tok), "sample_app", no_connector=True), "U1b")
    files = ctx.sh(host, f"find ~/.claude/projects -path '*/memory/*' -type f -newer {marker} "
                         f"-exec grep -l -- {shlex.quote(tok)} {{}} + 2>/dev/null; true").split()
    notes += [] if files else ["no auto-memory file holds the fact"]
    return {"U1": C.verdict(notes)}


SINGLE = {"S1": s1_s12h, "S2": s2, "S3": s3, "S4": s4, "S4n": s4n, "S5": s5, "S8": s8,
          "S11": s11_chain, "S14": s14_s7, "S16": s16, "S17": s17, "S18": s18, "S19": s19, "S20": s20, "U1": u1}
PAIR = {"S6": s6, "S6p": lambda ctx, a, b: {"S6p": s6(ctx, a, b, project=True)["S6"]},
        "S9": s9, "S11c": s11c, "S13": s13}
REPEATED = ("S2", "S4", "S5")   # spec: routing prompts run 3x per host; all runs must pass
