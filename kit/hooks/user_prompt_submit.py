"""claude-memory-cloud UserPromptSubmit hook (spec §7 B). Stdlib only; no network; < 100 ms."""
import json
import os
import sys

# os.path, not pathlib: every import counts on the Command Line Tools' Python (budget 100 ms).
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))


def emit(ctx):
    sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit",
                                                        "additionalContext": ctx}}))


def main() -> int:
    if os.environ.get("CLAUDE_CODE_REMOTE") == "true":
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    prompt = payload.get("prompt")
    from memory_kit.prompt import is_memory_intent
    if not isinstance(prompt, str) or not is_memory_intent(prompt):
        return 0   # no match -> no output; git is never run
    from memory_kit.prompt import default_scopes_path, prompt_context
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd or "\0" in cwd:
        cwd = os.getcwd()
    ctx = prompt_context(prompt, cwd, default_scopes_path())
    if ctx:
        emit(ctx)
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception:  # noqa: BLE001 — a broken hint must never block the prompt
        code = 0
    try:
        sys.stdout.flush()
    except Exception:  # noqa: BLE001 — closed/broken stdout
        pass
    os._exit(code)
