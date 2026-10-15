"""Every local path the kit reads or writes. Derived from $HOME so tests can use a temporary HOME."""
from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from . import KIT_DIRNAME


@dataclass(frozen=True)
class KitPaths:
    home: Path
    root: Path        # ~/.claude-memory-cloud            (0700)
    kit: Path         # ~/.claude-memory-cloud/kit         installed hook code
    config: Path      # ~/.claude-memory-cloud/config.json worker_url, hook_version, python
    scopes: Path      # ~/.claude-memory-cloud/scopes.json the signed-in user's own scope map
    state: Path       # ~/.claude-memory-cloud/state.json  what install changed, for uninstall
    outbox: Path      # ~/.claude-memory-cloud/outbox/     (0700, files 0600)
    cache: Path       # ~/.claude-memory-cloud/cache/      (0700, files 0600)
    export: Path      # ~/.claude-memory-cloud/export/     staging for --export-local
    claude_dir: Path  # ~/.claude
    settings: Path    # ~/.claude/settings.json
    claude_md: Path   # ~/.claude/CLAUDE.md


def kit_paths(home: Optional[Path] = None) -> KitPaths:
    h = Path(home) if home is not None else Path(os.path.expanduser("~"))
    root = h / KIT_DIRNAME
    claude = h / ".claude"
    return KitPaths(
        home=h, root=root, kit=root / "kit", config=root / "config.json", scopes=root / "scopes.json",
        state=root / "state.json", outbox=root / "outbox", cache=root / "cache", export=root / "export",
        claude_dir=claude, settings=claude / "settings.json", claude_md=claude / "CLAUDE.md",
    )
