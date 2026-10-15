"""Check outcomes in the memory repos with `gh api` (spec §9 Level 4: outcomes, never wording)."""
from __future__ import annotations

import json
import re
import subprocess
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Tuple
from urllib.parse import quote

# memories/<name>.md, memories/<name>.conflict-<ts>[-n].md, optionally under projects/<repo>/ (src/memory.ts PATH_RE)
MEMORY_PATH = re.compile(r"^(?:projects/(?P<project>[^/]+)/)?memories/(?P<name>[a-z0-9][a-z0-9-]{0,63})"
                         r"(?P<conflict>\.conflict-\d{8}T\d{6}Z(?:-\d{1,3})?)?\.md$")


class GhError(RuntimeError):
    def __init__(self, status: Optional[int], message: str) -> None:
        super().__init__(message)
        self.status = status


Api = Callable[[List[str]], str]   # args after `gh api` -> stdout; raises GhError


def gh_api(args: List[str]) -> str:
    r = subprocess.run(["gh", "api", *args], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        m = re.search(r"HTTP (\d{3})", r.stderr)
        raise GhError(int(m.group(1)) if m else None, r.stderr.strip()[:300])
    return r.stdout


@dataclass
class Commit:
    sha: str
    message: str
    files: List[Tuple[str, str]]   # (path, status) — status: added | modified | removed | renamed

    @property
    def trailers(self) -> Dict[str, str]:
        out: Dict[str, str] = {}
        for line in self.message.splitlines():
            m = re.match(r"^(Memory-[A-Za-z]+): (.*)$", line)
            if m:
                out[m.group(1)] = m.group(2).strip()
        return out


@dataclass
class Found:
    repo: str
    path: str
    sha: str           # commit that wrote it
    scope: str         # Memory-Scope trailer
    source: str        # Memory-Source trailer

    @property
    def parts(self) -> Dict[str, Optional[str]]:
        m = MEMORY_PATH.match(self.path)
        return m.groupdict() if m else {"project": None, "name": None, "conflict": None}


class GitHub:
    def __init__(self, api: Api = gh_api) -> None:
        self.api = api

    def commits_since(self, repo: str, since: str) -> List[Commit]:
        """Commits on the default branch since `since` (ISO 8601 Z), oldest first, with their files."""
        try:
            listing = json.loads(self.api([f"repos/{repo}/commits?since={quote(since)}&per_page=100"]))
        except GhError as e:
            if e.status == 409:   # "Git Repository is empty": no memory saved there yet
                return []
            raise
        out = []
        for c in reversed(listing):
            d = json.loads(self.api([f"repos/{repo}/commits/{c['sha']}"]))
            out.append(Commit(c["sha"], d["commit"]["message"],
                              [(f["filename"], f["status"]) for f in d.get("files", [])]))
        return out

    def file_text(self, repo: str, path: str, ref: str = "HEAD") -> Optional[str]:
        try:
            return self.api([f"repos/{repo}/contents/{quote(path)}?ref={quote(ref)}",
                             "-H", "Accept: application/vnd.github.raw"])
        except GhError as e:
            if e.status == 404:
                return None
            raise

    def find(self, repos: List[str], since: str, token: str) -> List[Found]:
        """Memory files containing `token`, written by the server (Memory-Source trailer) since `since`."""
        found: List[Found] = []
        for repo in repos:
            for c in self.commits_since(repo, since):
                t = c.trailers
                if "Memory-Source" not in t:
                    continue
                for path, status in c.files:
                    if status in ("added", "modified") and MEMORY_PATH.match(path):
                        text = self.file_text(repo, path, c.sha)
                        if text and token in text:
                            found.append(Found(repo, path, c.sha, t.get("Memory-Scope", ""), t["Memory-Source"]))
        return found

    def exists(self, repo: str, path: str) -> bool:
        return self.file_text(repo, path) is not None

    def delete(self, repo: str, path: str, message: str) -> bool:
        """Delete one file by hand (cleanup). The server rebuilds MEMORY.md from the files. False if already gone."""
        try:
            meta = json.loads(self.api([f"repos/{repo}/contents/{quote(path)}"]))
        except GhError as e:
            if e.status == 404:
                return False
            raise
        self.api(["-X", "DELETE", f"repos/{repo}/contents/{quote(path)}",
                  "-f", f"message={message}", "-f", f"sha={meta['sha']}"])
        return True
