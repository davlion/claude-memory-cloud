"""Entry point for setup.sh. Runs from the repo checkout; installs a copy of kit/ into ~/.claude-memory-cloud/kit."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from memory_kit.install import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
