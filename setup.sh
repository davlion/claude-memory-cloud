#!/usr/bin/env bash
# claude-memory-cloud local kit: ./setup.sh [--worker-url URL] [--scopes-file F [--login L]] [--scope N=O/R --login L] [--dry-run]
#                                ./setup.sh --uninstall [--force] [--delete-cache|--keep-cache] [--dry-run]
#                                ./setup.sh --export-local [--finish] [--cwd DIR]
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pick_python() {
  if [[ -n "${MEMKIT_PYTHON:-}" ]]; then echo "$MEMKIT_PYTHON"; return; fi
  # /usr/bin/python3 is stable across Homebrew/pyenv upgrades, but without the Command Line Tools it only
  # pops up an installer dialog, so try it only when xcode-select reports a developer directory.
  if [[ -x /usr/bin/python3 ]] && xcode-select -p >/dev/null 2>&1; then echo /usr/bin/python3; return; fi
  command -v python3 || true
}

py="$(pick_python)"
if [[ -z "$py" ]] || ! "$py" -B -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' 2>/dev/null; then
  echo "setup: needs Python 3.9+. Install the Command Line Tools (xcode-select --install) or Homebrew python3." >&2
  exit 2
fi
# Hooks run with this interpreter. Keep /usr/bin/python3 as is (stable path); resolve anything else, such as a
# pyenv shim (a slow bash script), to the real executable.
if [[ "$py" != /usr/bin/python3 ]]; then py="$("$py" -B -c 'import sys; print(sys.executable)')"; fi
MEMKIT_HOOK_PYTHON="$py" exec "$py" -B -I -S "$here/kit/memkit_setup.py" "$@"
