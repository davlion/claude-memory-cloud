"""Encrypt, decrypt or re-key a claude-memory repo (needs `cryptography`: see kit/requirements-crypt.txt).

  memcrypt.py encrypt <remote-url> [--to <new-remote-url> | --in-place] [--key-op op://… | --key-env VAR] [--confirm owner/repo]
  memcrypt.py decrypt <remote-url> [--key-op … | --key-env VAR] [--confirm owner/repo] [--server URL]
  memcrypt.py rotate  <remote-url> [--to … | --in-place | --commit] [--key-op … | --key-env VAR] [--new-key-env VAR] [--server URL]
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memory_kit.memcrypt import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main())
