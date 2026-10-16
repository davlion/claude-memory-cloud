"""claude-memory-cloud PostToolUse hook (spec §7 G): stores each memory_index result as the session's snapshot.
Silent: no output, so nothing appears in the transcript or Claude's context."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.realpath(__file__))))


def main() -> int:
    if os.environ.get("CLAUDE_CODE_REMOTE") == "true":
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(payload, dict):
        return 0
    tool = payload.get("tool_name")
    if not isinstance(tool, str) or not tool.startswith("mcp__") or not tool.endswith("__memory_index"):
        return 0
    cwd = payload.get("cwd")
    if not isinstance(cwd, str) or not cwd or "\0" in cwd:
        cwd = os.getcwd()
    from memory_kit.paths import kit_paths
    from memory_kit.remote import resolve_origin
    from memory_kit.snapshot import snapshot_from_tool_use, write_snapshot
    found = snapshot_from_tool_use(payload.get("tool_input"), payload.get("tool_response"), resolve_origin(cwd)[0])
    if found:
        write_snapshot(kit_paths().cache, *found)
    return 0


if __name__ == "__main__":
    try:
        code = main()
    except Exception:  # noqa: BLE001 — a failed snapshot write must never disturb the session
        code = 0
    os._exit(code)
