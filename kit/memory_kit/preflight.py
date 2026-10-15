"""Local preflight checks (spec §7 F, local half). Each problem line names the user's action."""
from __future__ import annotations

import json
import os
import stat
import sys
from pathlib import Path
from typing import List, Mapping, Optional

def managed_settings_path(platform: str) -> Path:
    if platform.startswith("linux"):
        return Path("/etc/claude-code/managed-settings.json")
    return Path("/Library/Application Support/ClaudeCode/managed-settings.json")


MANAGED_SETTINGS = managed_settings_path(sys.platform)

AUTO_MEMORY_LINE = ('Built-in auto-memory is on, so memories may go to the local folder. '
                    'Add `"autoMemoryEnabled": false` to `~/.claude/settings.json` (or rerun the setup script).')
ROUTING_LINE = ("The memory routing rule is missing from `~/.claude/CLAUDE.md`; "
                "rerun the claude-memory-cloud setup script.")
SCOPE_MAP_LINE = ("Scope map missing or invalid; rerun the setup script "
                  "(or fix `~/.claude-memory-cloud/scopes.json`).")
CONFIG_LINE = ("The memory kit's config (`~/.claude-memory-cloud/config.json`) is missing or invalid; "
               "rerun the claude-memory-cloud setup script.")
PERMISSIONS_LINE = ("Memory files on this machine are readable by other users. Run `chmod 700 "
                    "~/.claude-memory-cloud/outbox ~/.claude-memory-cloud/cache && find "
                    "~/.claude-memory-cloud/outbox ~/.claude-memory-cloud/cache -type f -exec chmod 600 {} +`.")


def settings_chain(home: Path, project_dir: Optional[str], managed: Path = MANAGED_SETTINGS) -> List[Path]:
    """Settings files in precedence order, highest first: managed, local, project, user."""
    chain = [managed]
    if project_dir:
        pd = Path(project_dir)
        chain += [pd / ".claude" / "settings.local.json", pd / ".claude" / "settings.json"]
    chain.append(Path(home) / ".claude" / "settings.json")
    return chain


def auto_memory_off(env: Mapping[str, str], chain: List[Path]) -> bool:
    if env.get("CLAUDE_CODE_DISABLE_AUTO_MEMORY", "").strip().lower() in ("1", "true", "yes", "on"):
        return True
    for p in chain:
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(d, dict) and "autoMemoryEnabled" in d:
            return d["autoMemoryEnabled"] is False
    return False


def ensure_private_dirs(root: Path, dirs: List[Path]) -> List[str]:
    """Creates missing dirs as 0700. Files inside a 0700 dir that aren't 0600 (Claude's Write tool
    creates 0644 files) are fixed silently: the dir already kept them private. A dir that isn't
    0700 is reported, because its files may have been readable."""
    try:
        root.mkdir(mode=0o700, parents=True, exist_ok=True)
    except OSError:
        return [PERMISSIONS_LINE]
    exposed = False
    for d in dirs:
        try:
            if not d.exists():
                d.mkdir(mode=0o700)
                os.chmod(d, 0o700)
                continue
            dir_ok = stat.S_IMODE(d.stat().st_mode) == 0o700
            exposed = exposed or not dir_ok
            for f in d.iterdir():
                if f.is_symlink() or not f.is_file():
                    continue
                if stat.S_IMODE(f.stat().st_mode) != 0o600:
                    if dir_ok:
                        os.chmod(f, 0o600)
                    else:
                        exposed = True
        except OSError:
            exposed = True
    return [PERMISSIONS_LINE] if exposed else []
