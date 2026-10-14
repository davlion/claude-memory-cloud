"""claude-memory-cloud SessionStart hook (spec §7 E, F, G, H), registered for every source."""
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


def emit(ctx: str) -> None:
    sys.stdout.write(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}))


def _str_field(payload: dict, key: str, default: str) -> str:
    v = payload.get(key)
    return v if isinstance(v, str) and v and "\0" not in v else default


def main() -> int:
    if os.environ.get("CLAUDE_CODE_REMOTE") == "true":
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        payload = {}
    if not isinstance(payload, dict):
        payload = {}
    from memory_kit.paths import kit_paths
    from memory_kit.preflight import MANAGED_SETTINGS
    from memory_kit.session import session_start_context
    ctx = session_start_context(
        source=_str_field(payload, "source", "startup"), cwd=_str_field(payload, "cwd", os.getcwd()),
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
        try:
            emit(f"claude-memory session hook failed ({type(e).__name__}). Tell the user one line: "
                 "\"⚠ memory: the session-start hook failed; rerun the claude-memory-cloud setup script.\"")
        except Exception:  # noqa: BLE001 — closed/broken stdout
            pass
        code = 0
    try:
        sys.stdout.flush()
    except Exception:  # noqa: BLE001
        pass
    os._exit(code)   # don't wait for a /health thread still blocked in DNS
