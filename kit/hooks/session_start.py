"""claude-memory-cloud SessionStart hook (spec §7 E, F, G, H), registered for every source."""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def emit(ctx: str) -> None:
    sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}))


def main() -> int:
    if os.environ.get("CLAUDE_CODE_REMOTE") == "true":
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = {}
    from memory_kit.paths import kit_paths
    from memory_kit.preflight import MANAGED_SETTINGS
    from memory_kit.session import session_start_context
    ctx = session_start_context(
        source=str(payload.get("source") or "startup"), cwd=str(payload.get("cwd") or os.getcwd()),
        paths=kit_paths(), env=os.environ, now=datetime.now(timezone.utc),
        managed=Path(os.environ.get("MEMKIT_MANAGED_SETTINGS", str(MANAGED_SETTINGS))),
    )
    if ctx:
        emit(ctx)
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception as e:  # noqa: BLE001
        emit(f"claude-memory session hook failed ({type(e).__name__}). Tell the user one line: "
             "\"⚠ memory: the session-start hook failed; rerun the claude-memory-cloud setup script.\"")
        code = 0
    sys.stdout.flush()
    os._exit(code)   # don't wait for a /health thread still blocked in DNS
