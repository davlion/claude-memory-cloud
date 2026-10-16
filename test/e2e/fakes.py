"""Test doubles for the scenario tests: scripted claude runs, a fake repo set, a fake host shell."""
import json
from pathlib import Path
from typing import Callable, Dict, List, Tuple

from e2elib.config import Config
from e2elib.gh import Found
from e2elib.launch import Host, Invocation, RunResult
from e2elib.transcript import parse

P = "mcp__claude_ai_claude-memory-staging__"
HOST = Host("H1", "Mac CLI", None, "claude", "python3", [P], {"sample_app": "/s", "kit_repo": "/k", "no_remote": "/n"})
CFG = Config(general_repo="me/claude-memory-test", client_repo="client/claude-memory", client_scope="client",
             sample_project="client/sample-app", kit_project="me/claude-memory-cloud", repeats=3,
             hosts={"H1": HOST}, prompts=json.loads((Path(__file__).resolve().parent / "prompts.json").read_text()))


def stream(*, kit: str = "Memory project for this session: client/sample-app", calls=(), text: str = "ok",
           hooks: List[Tuple[str, str]] = ()) -> str:
    """A stream-json transcript. calls: (short_name, input, result_text, is_error)."""
    ev = [{"type": "system", "subtype": "hook_response", "hook_name": "SessionStart:startup", "output":
           json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": kit}})}]
    ev += [{"type": "system", "subtype": "hook_response", "hook_name": n, "output": o} for n, o in hooks]
    ev.append({"type": "system", "subtype": "init", "session_id": "s", "tools": []})
    for i, (name, inp, res, err) in enumerate(calls):
        ev.append({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"c{i}", "name": P + name, "input": inp}]}})
        ev.append({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"c{i}", "content": res, "is_error": err}]}})
    ev.append({"type": "result", "subtype": "success", "is_error": False, "result": text})
    return "\n".join(json.dumps(e) for e in ev)


def saved(status: str = "created") -> str:
    return f'claude-memory response.\n{{"status": "{status}", "name": "n"}}'


class FakeClaude:
    """Returns scripted stdout per call, in order; records the invocations. A callable entry gets the Invocation."""

    def __init__(self, *outputs) -> None:
        self.outputs, self.invocations = list(outputs), []

    def __call__(self, host: Host, inv: Invocation) -> RunResult:
        self.invocations.append(inv)
        out = self.outputs.pop(0)
        out = out(inv) if callable(out) else out
        return RunResult(parse(out.splitlines()), 0, out, "", False)


class FakeGh:
    """Memory files as (Found, text). find() matches by token in text."""

    def __init__(self) -> None:
        self.files: List[Tuple[Found, str]] = []
        self.deleted: List[str] = []
        self.gone: set = set()          # (repo, path) deleted since: still in history, not at HEAD

    def add(self, repo: str, path: str, text: str, scope: str) -> None:
        self.files.append((Found(repo, path, "abc1234", scope, "claude-code on test"), text))

    def find(self, repos, since, token):
        return [f for f, text in self.files if token in text and f.repo in repos]

    def file_text(self, repo, path, ref="HEAD"):
        return next((text for f, text in self.files if f.repo == repo and f.path == path), None)

    def exists(self, repo, path):
        return (repo, path) not in self.gone and any(f.repo == repo and f.path == path for f, _ in self.files)


class FakeShell:
    """Answers host shell commands by substring; records them."""

    def __init__(self, answers: Dict[str, Callable[[str], str]] = None) -> None:
        self.answers, self.seen = answers or {}, []

    def __call__(self, host: Host, script: str) -> str:
        self.seen.append(script)
        for key, fn in self.answers.items():
            if key in script:
                return fn(script)
        return ""
