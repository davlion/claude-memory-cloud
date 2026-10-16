"""claude-memory-cloud local kit (spec §7 A–H). Python 3.9+, standard library only."""
from __future__ import annotations

# Bump on every change to the hooks or the routing rule. The Worker's /health reports
# min_hook_version; the SessionStart hook warns when this is older (spec §7 F).
HOOK_VERSION = "0.1.2"

# Everything the kit owns lives under ~/<KIT_DIRNAME> (outside ~/.claude, whose files Claude Code
# protects: writes there always prompt, whatever the allow rules say).
KIT_DIRNAME = ".claude-memory-cloud"
