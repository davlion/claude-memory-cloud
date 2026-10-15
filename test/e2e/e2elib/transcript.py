"""Parse `claude -p --output-format stream-json --verbose` output into what the scenario checks need."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from typing import Any, Dict, Iterable, List, Optional

KIT_MARK = "Memory project for this session"
MEMORY_TOOLS = ("memory_index", "memory_read", "memory_search", "memory_save", "memory_delete",
                "memory_health", "memory_scopes")
_STATUS = re.compile(r'"status"\s*:\s*"([a-z_]+)"')


@dataclass
class ToolCall:
    id: str
    name: str
    input: Dict[str, Any]
    result: Optional[str] = None
    is_error: bool = False

    @property
    def short(self) -> str:
        """`memory_save` for `mcp__claude_ai_claude-memory-staging__memory_save`."""
        return self.name.rsplit("__", 1)[-1] if self.name.startswith("mcp__") else self.name

    @property
    def status(self) -> Optional[str]:
        """The `status` field of a memory tool's JSON result, if any."""
        m = _STATUS.search(self.result or "")
        return m.group(1) if m else None


@dataclass
class Hook:
    name: str      # e.g. "SessionStart:startup", "SessionStart:compact", "UserPromptSubmit"
    context: str   # additionalContext if the hook printed hookSpecificOutput JSON, else raw stdout


@dataclass
class Transcript:
    session_id: Optional[str] = None
    tools: List[str] = field(default_factory=list)
    hooks: List[Hook] = field(default_factory=list)
    calls: List[ToolCall] = field(default_factory=list)
    texts: List[str] = field(default_factory=list)
    denials: List[str] = field(default_factory=list)
    final: Optional[Dict[str, Any]] = None
    bad_lines: int = 0

    def memory_calls(self, short: Optional[str] = None) -> List[ToolCall]:
        out = [c for c in self.calls if c.name.startswith("mcp__") and c.short in MEMORY_TOOLS]
        return [c for c in out if c.short == short] if short else out

    def kit_context(self, hook_prefix: str = "SessionStart") -> str:
        """The memory kit's SessionStart context (the hook whose output names the memory project)."""
        return "\n".join(h.context for h in self.hooks if h.name.startswith(hook_prefix) and KIT_MARK in h.context)

    @property
    def final_text(self) -> str:
        if self.final and isinstance(self.final.get("result"), str):
            return self.final["result"]
        return self.texts[-1] if self.texts else ""

    @property
    def succeeded(self) -> bool:
        return bool(self.final) and self.final.get("subtype") == "success" and not self.final.get("is_error")


def _hook_context(output: str) -> str:
    try:
        d = json.loads(output)
    except ValueError:
        return output
    if isinstance(d, dict) and isinstance(d.get("hookSpecificOutput"), dict):
        ctx = d["hookSpecificOutput"].get("additionalContext")
        if isinstance(ctx, str):
            return ctx
    return output


def _result_text(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(c.get("text", "") for c in content if isinstance(c, dict) and c.get("type") == "text")
    return ""


def parse(lines: Iterable[str]) -> Transcript:
    t = Transcript()
    by_id: Dict[str, ToolCall] = {}
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except ValueError:
            t.bad_lines += 1
            continue
        if not isinstance(e, dict):
            t.bad_lines += 1
            continue
        kind, sub = e.get("type"), e.get("subtype")
        if kind == "system" and sub == "init":
            t.session_id = e.get("session_id")
            t.tools = [x for x in e.get("tools", []) if isinstance(x, str)]
        elif kind == "system" and sub == "hook_response":
            t.hooks.append(Hook(str(e.get("hook_name", "")), _hook_context(str(e.get("output", "")))))
        elif kind == "system" and sub == "permission_denied":
            t.denials.append(str(e.get("tool_name", "")))
        elif kind == "assistant":
            for c in (e.get("message") or {}).get("content") or []:
                if c.get("type") == "tool_use":
                    call = ToolCall(str(c.get("id")), str(c.get("name")), c.get("input") or {})
                    by_id[call.id] = call
                    t.calls.append(call)
                elif c.get("type") == "text" and c.get("text"):
                    t.texts.append(c["text"])
        elif kind == "user":
            content = (e.get("message") or {}).get("content")
            for c in content if isinstance(content, list) else []:
                if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("tool_use_id") in by_id:
                    call = by_id[c["tool_use_id"]]
                    call.result = _result_text(c.get("content"))
                    call.is_error = bool(c.get("is_error"))
        elif kind == "result":
            t.final = e
            t.session_id = t.session_id or e.get("session_id")
    return t
