"""Helper commands Claude runs (allowed without a prompt for outbox-done):

  memkit.py outbox-done <filename>...   delete flushed outbox entries (basenames only, regular files only)
  memkit.py export-finish [--cwd DIR]   copy staged exported memories into auto-memory files
  memkit.py preflight [--cwd DIR]       print the local preflight result
"""
import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memory_kit.install import export_finish, outbox_done, print_preflight  # noqa: E402
from memory_kit.paths import kit_paths  # noqa: E402


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="memkit")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("outbox-done").add_argument("names", nargs="+")
    ex = sub.add_parser("export-finish")
    ex.add_argument("--cwd", default=os.getcwd())
    pf = sub.add_parser("preflight")
    pf.add_argument("--cwd", default=os.getcwd())
    a = ap.parse_args(argv)
    if a.cmd == "outbox-done":
        return outbox_done(kit_paths().outbox, a.names)
    if a.cmd == "export-finish":
        return export_finish(kit_paths(), a.cwd)
    return print_preflight(kit_paths(), cwd=a.cwd)


if __name__ == "__main__":
    sys.exit(main())
