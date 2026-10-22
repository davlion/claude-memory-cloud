"""memcrypt: encrypt, decrypt or re-key a memory repo from this machine.

Works in a fresh clone in a temporary directory (removed on every exit), never in the user's own clone. Key text never
goes to git: not in arguments, not in its environment, not in a file in the repo, and it is printed only when generated.
"""
from __future__ import annotations

import argparse
import getpass
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
from typing import Dict, List, Optional, Tuple

from . import crypt
from .remote import normalize_remote, redact_remote

_TO_CONTINUE = " To continue, paste the key back and type the repo name."
# Same copy as the key page (src/key-page-html.ts); the fresh path can't hold saves from here, so that sentence is adapted.
IN_PLACE_WARNING = ("Turning on encryption replaces this repo's whole history with a single commit. Past changes and their log are gone. "
                    "The old commits stay readable through the repo's activity log by anyone with read access until GitHub Support purges "
                    "them: request that at https://support.github.com/request after this finishes. Clones and forks made before now keep the "
                    "old plaintext. A rule that blocks force pushes on the branch must be lifted first. Without this key your memories can't "
                    "be read: keep it in your password manager.")
FRESH_WARNING = ("Your encrypted memories will be written to a new, empty private repo. Then you delete this repo and rename the new one to "
                 "this name. Until you do, don't save memories to this scope. Deleting is what removes the old plaintext; clones and forks "
                 "made before now keep it. Without this key your memories can't be read: keep it in your password manager.")
DECRYPT_WARNING = ("Decrypting writes every memory back in plaintext, in a normal commit. That plaintext stays in the repo's history from "
                   "now on, even if you turn encryption on again later.")
ROTATE_IN_PLACE_WARNING = ("Rotating in place replaces this repo's whole history with a single commit. The old commits, sealed with the old "
                           "key, stay readable through the repo's activity log by anyone with read access until GitHub Support purges them "
                           "(https://support.github.com/request); clones and forks made before now keep them. A rule that blocks force pushes "
                           "on the branch must be lifted first. Without the new key your memories can't be read: keep it in your password manager.")
ROTATE_COMMIT_WARNING = ("The re-sealed memories go in a normal commit. The old key's ciphertext stays in the repo's history, so anyone with "
                         "read access and the old key can still read those versions. Without the new key your memories can't be read: keep it "
                         "in your password manager.")
_SET_RE = re.compile(r"(projects/[^/]+/)?(.*)\Z", re.S)


NOT_APPLIED = ("The new key shown above was NOT applied: {repo} still uses its current key. "
               "Discard the new key; run memcrypt again to get another.")
NOT_APPLIED_ENCRYPT = ("The new key shown above was NOT applied: {repo} is unchanged. "
                       "Discard the new key; run memcrypt again to get another.")
APPLIED = "The new key WAS applied: keep it."
MAYBE_APPLIED = ("The push may have gone through. Keep the new key until you've checked {repo} on GitHub: "
                 "if its encryption marker names key {key_id}, the new key is in use.")


class Abort(Exception):
    pass


def _kind(path: str) -> Optional[str]:
    if path == crypt.MARKER_PATH:
        return "marker"
    rel = _SET_RE.match(path).group(2)
    if rel == "MEMORY.md":
        return "index"
    return "memory" if crypt._PATH_RE.fullmatch(rel) else None


def repo_name(url: str) -> str:
    """`owner/repo` for a GitHub remote; for anything else (a local path) its last two path parts."""
    n = normalize_remote(url)
    if n:
        return f"{n[0]}/{n[1]}"
    parts = [p for p in re.split(r"[/:\\]", url.strip().rstrip("/")) if p]
    if len(parts) < 2:
        raise Abort("Can't tell the repo's owner/name from that remote URL.")
    last = parts[-1][:-4] if parts[-1].endswith(".git") else parts[-1]
    return f"{parts[-2]}/{last}".lower()


class Run:
    """One command: the key texts in use (kept out of every child process's environment) and the temporary clone."""

    def __init__(self, a: argparse.Namespace) -> None:
        self.a = a
        self.secrets: List[str] = []
        self.names = {n for n in (a.key_env, getattr(a, "new_key_env", None), getattr(a, "confirm_key_env", None)) if n}
        self.dir = ""
        self.key_shown = False

    def env(self) -> Dict[str, str]:
        return {k: v for k, v in os.environ.items() if k not in self.names and not any(s in v for s in self.secrets)}

    def git(self, *args: str, data: Optional[bytes] = None, here: bool = True) -> bytes:
        argv = ["git", "-C", self.dir, *args] if here else ["git", *args]
        try:
            return subprocess.run(argv, input=data, capture_output=True, check=True, env=self.env()).stdout
        except subprocess.CalledProcessError as e:
            err = redact_remote(e.stderr.decode("utf-8", "replace").strip())
            raise Abort(f"git {args[0]} failed: {err}") from None

    def out(self, *args: str, here: bool = True) -> str:
        return self.git(*args, here=here).decode("utf-8", "replace").strip()

    def read_key(self, op_ref: Optional[str], env_name: Optional[str], prompt: str, allow_new: bool = False) -> Tuple[str, bool]:
        """(key text, generated?) from `op read`, an environment variable or a hidden prompt (empty = new, when allowed)."""
        if op_ref:
            r = subprocess.run(["op", "read", op_ref], capture_output=True, text=True, env=self.env())
            if r.returncode:
                raise Abort("op read failed; check the reference and that 1Password CLI is signed in.")
            text = r.stdout
        elif env_name:
            text = os.environ.get(env_name, "")
            if not text:
                raise Abort(f"{env_name} is not set.")
        elif prompt:
            try:
                text = getpass.getpass(prompt)
            except EOFError:
                raise Abort("No key given. Nothing was changed.") from None
        else:
            text = ""
        generated = allow_new and not text.strip()
        text = crypt.generate_key_text() if generated else text.strip()
        try:
            crypt.parse_key_text(text)
        except ValueError as e:
            raise Abort(str(e)) from None
        self.secrets.append(text)
        return text, generated


def _ask(prompt: str) -> str:
    try:
        return input(prompt).strip()
    except EOFError:
        return ""


def _confirm(r: Run, repo: str, warning: str, new_key: Optional[str]) -> None:
    if new_key:
        r.key_shown = True
        print(f"\nThe new key for {repo}. Save it in your password manager now; it isn't shown again.\n\n  {new_key}\n")
    print(warning + "\n")
    if new_key:
        env = r.a.confirm_key_env
        back = (os.environ.get(env, "") if env else
                getpass.getpass("Step 1 of 2 \u2014 paste the new key back to prove you saved it (input is hidden): "))
        if back.strip() != new_key:
            raise Abort("The pasted key doesn't match. Nothing was changed.")
    ask = f"Step 2 of 2 \u2014 type {repo} to continue: " if new_key else f"Type {repo} to continue: "
    typed = r.a.confirm if r.a.confirm is not None else _ask(ask)
    if typed.strip().lower() != repo:
        raise Abort("The repo name didn't match. Nothing was changed.")


def _files(r: Run) -> Dict[str, Tuple[str, Optional[str]]]:
    """path -> (mode, text) for the marker, indexes and memory files (text None when not a readable regular file)."""
    out: Dict[str, Tuple[str, Optional[str]]] = {}
    for entry in r.git("ls-tree", "-r", "-z", "HEAD").split(b"\0"):
        if not entry:
            continue
        meta, path = entry.decode("utf-8", "surrogateescape").split("\t", 1)
        mode, _typ, sha = meta.split()
        if not _kind(path):
            continue
        text = None
        if mode in ("100644", "100755"):
            try:
                text = r.git("cat-file", "blob", sha).decode("utf-8")
            except UnicodeDecodeError:
                pass
        out[path] = (mode, text)
    bad = sorted(p for p, (_, t) in out.items() if t is None)
    if bad:
        raise Abort(f"These files couldn't be read: {', '.join(bad)}. Fix or remove them, then try again. Nothing was changed.")
    return out


def _marker(files: Dict[str, Tuple[str, Optional[str]]]) -> Optional[crypt.Marker]:
    f = files.get(crypt.MARKER_PATH)
    if not f:
        return None
    try:
        return crypt.parse_marker(f[1] or "")
    except ValueError:
        return None


def _open(key: crypt.RepoKey, repo_id: str, path: str, text: str) -> str:
    try:
        return crypt.open_memory_file(key, repo_id, path, text)
    except crypt.DecryptError:
        raise Abort(f"{path} doesn't open with that key. Nothing was changed.") from None


def plan_encrypt(files, key: crypt.RepoKey, repo: str) -> Dict[str, str]:
    existing = _marker(files)
    if existing and existing.enabled:
        raise Abort(f"Encryption is already on for {repo}: use rotate to change its key. Nothing was changed.")
    repo_id = existing.repo_id if existing and crypt.marker_signed_by(key, existing) else crypt.new_repo_id()
    changes: Dict[str, str] = {}
    for path, (_, text) in files.items():
        kind = _kind(path)
        if kind == "index":
            changes[path] = crypt.names_only_index(text)
        elif kind == "memory" and crypt.is_encrypted_file(text):
            _open(key, repo_id, path, text)   # kept as is, only if it opens with this key
        elif kind == "memory":
            changes[path] = crypt.seal_memory_file(key, repo_id, path, text)
    changes[crypt.MARKER_PATH] = crypt.serialize_marker(crypt.sign_marker(key, crypt.Marker(True, repo_id, key.id)))
    return changes


def _signed_marker(files, key: crypt.RepoKey, repo: str) -> crypt.Marker:
    m = _marker(files)
    if not m:
        raise Abort(f"{repo} has no valid encryption marker, so it isn't encrypted. Nothing was changed.")
    if not crypt.marker_signed_by(key, m):
        raise Abort(f"That key doesn't match {repo}'s encryption marker. Nothing was changed.")
    return m


_NAMES_LINE_RE = re.compile(r"^(- \[([^\]]+)\]\(memories/([^)]+)\.md\))[ \t]*$")
_DESC_RE = re.compile(r"^description:[ \t]*(.*?)[ \t]*$", re.MULTILINE)


def _description(text: str) -> Optional[str]:
    """The one-line `description:` of a memory's frontmatter, unquoted, or None."""
    m = re.match(r"---\r?\n(.*?)\r?\n---", text, re.S)
    d = _DESC_RE.search(m.group(1)) if m else None
    if not d:
        return None
    v = d.group(1)
    if not v or v[0] in "|>&*![{%@`" or (v[0] in "\"'" and (len(v) < 2 or v[-1] != v[0])):
        return None   # block scalar or anything else not parsed with confidence: leave the line names-only
    if v[0] == '"':
        try:
            v = json.loads(v)
        except ValueError:
            return None
    elif v[0] == "'":
        v = v[1:-1].replace("''", "'")
    v = re.sub(r"\s+", " ", v.replace("```", " ")).strip()
    v = re.sub(r"^#+\s*", "", v)
    if len(v) > 200:
        v = v[:199] + "\u2026"   # the Worker's MAX_DESCRIPTION
    return v or None


def _describe_index(files, changes: Dict[str, str], path: str, text: str) -> str:
    """Give each names-only `- [name](memories/name.md)` line its ` — description`, as the Worker's buildIndex writes it."""
    base = path[: -len("MEMORY.md")]
    out = []
    for line in text.split("\n"):
        m = _NAMES_LINE_RE.match(line.rstrip("\r"))
        if m:
            mem = f"{base}memories/{m.group(3)}.md"
            body = changes.get(mem) or (files[mem][1] if mem in files else None)
            desc = _description(body) if body and not crypt.is_encrypted_file(body) else None
            if desc:
                line = f"{m.group(1)} \u2014 {desc}"
        out.append(line)
    return "\n".join(out)


def plan_decrypt(files, key: crypt.RepoKey, repo: str) -> Dict[str, str]:
    m = _signed_marker(files, key, repo)
    changes = {p: _open(key, m.repo_id, p, t) for p, (_, t) in files.items() if _kind(p) == "memory" and crypt.is_encrypted_file(t)}
    for p, (_, t) in files.items():
        if _kind(p) == "index":
            fixed = _describe_index(files, changes, p, t)
            if fixed != t:
                changes[p] = fixed
    changes[crypt.MARKER_PATH] = crypt.serialize_marker(crypt.sign_marker(key, crypt.Marker(False, m.repo_id, key.id)))
    return changes


def plan_rotate(files, old: crypt.RepoKey, new: crypt.RepoKey, repo: str) -> Dict[str, str]:
    m = _signed_marker(files, old, repo)
    if new.id == old.id:
        raise Abort("The new key is the same as the old one. Nothing was changed.")
    changes = {p: crypt.seal_memory_file(new, m.repo_id, p, _open(old, m.repo_id, p, t))
               for p, (_, t) in files.items() if _kind(p) == "memory" and crypt.is_encrypted_file(t)}
    changes[crypt.MARKER_PATH] = crypt.serialize_marker(crypt.sign_marker(new, crypt.Marker(m.enabled, m.repo_id, new.id)))
    return changes


def _extra_refs(r: Run, url: str, branch: str) -> None:
    counts = {"branch": 0, "tag": 0, "pull request": 0, "other ref": 0}
    for line in r.out("ls-remote", url, here=False).splitlines():
        ref = line.split("\t", 1)[-1]
        if ref in ("HEAD", f"refs/heads/{branch}") or ref.endswith("^{}"):
            continue
        kind = ("branch" if ref.startswith("refs/heads/") else "tag" if ref.startswith("refs/tags/")
                else "pull request" if ref.startswith("refs/pull/") else "other ref")
        counts[kind] += 1
    found = [f"{n} {'other ' if k == 'branch' else ''}{k}{'es' if k == 'branch' and n != 1 else 's' if n != 1 else ''}"
             for k, n in counts.items() if n]
    if found:
        how = ("Pull requests can't be deleted: use --to with a fresh repo instead." if counts["pull request"]
               else "Delete them and try again, or use --to with a fresh repo instead.")
        raise Abort(f"The repo has {', '.join(found)}, which would keep the old history reachable. Nothing was changed. {how}")


def _choose(a: argparse.Namespace, choices: List[str]) -> str:
    if a.to:
        return "fresh"
    if a.in_place:
        return "in-place"
    if getattr(a, "commit", False):
        return "commit"
    ans = _ask(f"Write to a fresh repo (recommended) or {' or '.join(choices[1:])}? [{'/'.join(choices)}]: ").lower()
    if ans not in choices:
        raise Abort("No path chosen. Nothing was changed.")
    if ans == "fresh":
        a.to = _ask("Remote URL of the new, empty private repo: ")
        if not a.to:
            raise Abort("No new repo given. Nothing was changed.")
    return ans


def _pushed(r: Run, url: str, branch: str, sha: str, old: Optional[str]) -> Optional[bool]:
    """Whether a push that failed or was interrupted reached the remote: True if the branch holds `sha` (or a descendant),
    False if it is still `old` (None: absent) or doesn't contain `sha`, None if the remote can't be read."""
    try:
        out = r.out("ls-remote", url, f"refs/heads/{branch}", here=False)
        now = out.split("\t")[0] if out else None
        if now == sha:
            return True
        if now == old or now is None:
            return False
        # Moved elsewhere (someone pushed): only a branch that contains our commit uses the new key.
        r.git("fetch", "--quiet", url, f"refs/heads/{branch}")
        anc = subprocess.run(["git", "-C", r.dir, "merge-base", "--is-ancestor", sha, "FETCH_HEAD"], capture_output=True, env=r.env())
        return {0: True, 1: False}.get(anc.returncode)
    except (Abort, KeyboardInterrupt, EOFError, OSError):
        return None


def _remove(tmp: str) -> None:
    """Removes the temporary clone (it can hold the old plaintext history); says so if any of it is left."""
    shutil.rmtree(tmp, ignore_errors=True)
    if os.path.exists(tmp):   # read-only files (Windows packs): make everything writable and try once more
        for root, dirs, names in os.walk(tmp):
            for n in dirs + names:
                try:
                    os.chmod(os.path.join(root, n), 0o700)
                except OSError:
                    pass
        shutil.rmtree(tmp, ignore_errors=True)
    if os.path.exists(tmp):
        print(f"memcrypt: couldn't remove its temporary clone, {tmp}, which may hold your memories in plaintext. Delete it.",
              file=sys.stderr)


def _commit(r: Run, files, changes: Dict[str, str], message: str, parent: Optional[str]) -> str:
    r.git("read-tree", "HEAD")
    for path, text in changes.items():
        sha = r.git("hash-object", "-w", "--no-filters", "--stdin", data=text.encode("utf-8")).decode().strip()
        mode = files.get(path, ("100644", None))[0]
        r.git("update-index", "--add", "--cacheinfo", f"{mode},{sha},{path}")
    tree = r.out("write-tree")
    trailers = f"\n\nMemory-Source: memcrypt on {socket.gethostname()}\nMemory-Scope: *\n"
    return r.out("commit-tree", tree, *(["-p", parent] if parent else []), "-m", message + trailers)


def _key_page(a: argparse.Namespace, repo: str) -> str:
    return f"{a.server.rstrip('/')}/keys?repo={repo}" if a.server else ""


def _move_steps(a: argparse.Namespace, repo: str, register: str) -> str:
    page = _key_page(a, repo)
    return (f"The encrypted copy is in {redact_remote(a.to)}. To finish:\n"
            f"  1. Delete {repo}: https://github.com/{repo}/settings → Danger Zone → Delete this repository. "
            "GitHub keeps a deleted repo restorable by its owner for 90 days.\n"
            f"  2. Rename the new repo to {repo.split('/')[1]}: its Settings → Repository name.\n"
            f"  3. {register}{': ' + page if page else ' on the key page.'}\n"
            "Until you finish, don't save memories to this scope: saves to the old repo would be lost when you delete it.")


def run(a: argparse.Namespace) -> int:
    r = Run(a)
    repo = repo_name(a.remote)
    key_text, generated = r.read_key(a.key_op, a.key_env, "Repo key (press Enter to generate a new one): " if a.cmd == "encrypt"
                                     else "Repo key: ", allow_new=a.cmd == "encrypt" and not a.key_op and not a.key_env)
    key = crypt.parse_key_text(key_text)
    tmp = tempfile.mkdtemp(prefix="memcrypt-")
    try:
        r.dir = os.path.join(tmp, "repo")
        r.git("clone", "--quiet", "--no-checkout", a.remote, r.dir, here=False)
        try:
            head = r.out("rev-parse", "--verify", "HEAD")
        except Abort:
            raise Abort(f"{repo} has no commits. Nothing was changed.") from None
        branch = r.out("symbolic-ref", "--short", "HEAD")
        files = _files(r)
        new_key: Optional[str] = key_text if generated else None
        if a.cmd == "encrypt":
            changes = plan_encrypt(files, key, repo)
            path = _choose(a, ["fresh", "in-place"])
            warning = FRESH_WARNING if path == "fresh" else IN_PLACE_WARNING
            message = f"encrypt: fresh encrypted copy of {repo}" if path == "fresh" else "encrypt: switch on, history squashed"
        elif a.cmd == "decrypt":
            changes, path, warning, message = plan_decrypt(files, key, repo), "commit", DECRYPT_WARNING, "encrypt: decrypt all"
        else:
            _signed_marker(files, key, repo)
            new_text, gen = r.read_key(None, a.new_key_env, "", allow_new=True)   # no variable: a new key, no prompt
            new_key = new_text if gen else None
            changes = plan_rotate(files, key, crypt.parse_key_text(new_text), repo)
            path = _choose(a, ["fresh", "in-place", "commit"])
            warning = {"fresh": FRESH_WARNING, "in-place": ROTATE_IN_PLACE_WARNING, "commit": ROTATE_COMMIT_WARNING}[path]
            message = {"fresh": f"encrypt: rotated copy of {repo}", "in-place": "encrypt: rotate key, history squashed",
                       "commit": "encrypt: rotate key"}[path]
        if path == "in-place":
            _extra_refs(r, a.remote, branch)
        if path == "fresh":
            if a.to.strip() == a.remote.strip():
                raise Abort("The new repo must be a different repo. Nothing was changed.")
            if r.out("ls-remote", a.to, here=False):
                raise Abort(f"{redact_remote(a.to)} isn't empty. Create a new, empty private repo (no README) and try again. Nothing was changed.")
            # A plain git remote doesn't say whether it is private; the memory tool refuses a public one only after the rename.
            print(f"Make sure {redact_remote(a.to)} is a private repository.")
        not_applied = (NOT_APPLIED_ENCRYPT if a.cmd == "encrypt" else NOT_APPLIED).format(repo=repo)
        sha = ""
        pushing = False
        interrupted: Optional[KeyboardInterrupt] = None
        try:
            _confirm(r, repo, warning, new_key)
            sha = _commit(r, files, changes, message, head if path == "commit" else None)
            pushing = True
            if path == "in-place":
                r.git("push", "--quiet", f"--force-with-lease={branch}:{head}", "origin", f"{sha}:refs/heads/{branch}")
            elif path == "commit":
                r.git("push", "--quiet", "origin", f"{sha}:refs/heads/{branch}")
            else:
                r.git("push", "--quiet", a.to, f"{sha}:refs/heads/{branch}")
        except (KeyboardInterrupt, EOFError, Abort) as e:
            if not r.key_shown:
                if isinstance(e, EOFError):
                    raise Abort("No input. Nothing was changed.") from None
                raise
            # Before the push started nothing reached the remote; after, the remote says what it holds.
            outcome = _pushed(r, a.to if path == "fresh" else a.remote, branch, sha, None if path == "fresh" else head) if pushing else False
            if outcome is True:
                print(APPLIED, file=sys.stderr)   # then on as if the push had succeeded
                interrupted = e if isinstance(e, KeyboardInterrupt) else None
            else:
                text = "No input. Nothing was changed." if isinstance(e, EOFError) else str(e) if isinstance(e, Abort) else ""
                if outcome is False and "stale info" in text:
                    text += f"\n{repo} changed while memcrypt was waiting (a memory was probably saved). Nothing was changed; run it again."
                tail = not_applied if outcome is False else MAYBE_APPLIED.format(
                    repo=repo_name(a.to) if path == "fresh" else repo, key_id=crypt.parse_key_text(new_key or key_text).id)
                if isinstance(e, KeyboardInterrupt):
                    print(tail, file=sys.stderr)
                    raise
                raise Abort(f"{text}\n{tail}" if text else tail) from None
        if path == "fresh":
            # The copy is pushed: a problem from here on leaves the new key in use in the new repo.
            applied = f"\n{APPLIED}" if r.key_shown else ""
            try:
                moved = r.out("ls-remote", "origin", f"refs/heads/{branch}").split("\t")[0] != head
            except Abort as e:
                raise Abort(f"{e}{applied}") from None
            except KeyboardInterrupt:
                if r.key_shown:
                    print(APPLIED, file=sys.stderr)
                raise
            if moved:
                raise Abort(f"{repo} changed while its encrypted copy was being written, so the copy misses those saves. "
                            f"Delete and recreate {redact_remote(a.to)} as an empty private repo, then try again.{applied}")
        if a.cmd == "decrypt":
            print(f"Done: {repo} is decrypted.")
        elif a.cmd == "rotate":
            print(f"Done: {repo} is now encrypted under the new key." if path != "fresh"
                  else f"Done: copy encrypted under the new key pushed to {redact_remote(a.to)}.")
        else:
            print(f"Done: {repo} is encrypted." if path != "fresh" else f"Done: encrypted copy pushed to {redact_remote(a.to)}.")
        page = _key_page(a, repo)
        if a.cmd == "decrypt":
            print("Encryption is off in the repo. To let the memory tool see it, an admin of "
                  f"{repo} clicks Confirm decryption on the key page{f' ({page})' if page else ''} and pastes this key, or uses Stop there.")
        elif path == "fresh":
            print(_move_steps(a, repo, f"An admin of {repo} registers the key once" if a.cmd == "encrypt" else f"An admin of {repo} registers the new key"))
        elif a.cmd == "encrypt":
            print(f"Encryption is on for {repo}; its history is now one commit. Ask GitHub Support to purge the old commits: "
                  f"https://support.github.com/request\nAn admin of {repo} registers the key once so the memory tool can read and save"
                  f"{': ' + page if page else ' on the key page.'}")
        if a.cmd == "rotate" and path != "fresh":
            print(f"An admin of {repo} registers the new key{': ' + page if page else ' on the key page.'}")
        if interrupted:
            raise interrupted
        return 0
    finally:
        _remove(tmp)


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(prog="memcrypt", description="Encrypt, decrypt or re-key a claude-memory repo.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("encrypt", "decrypt", "rotate"):
        p = sub.add_parser(name)
        p.add_argument("remote", help="the memory repo's remote URL")
        p.add_argument("--key-op", help="1Password reference for the key (op://…), read with `op read`")
        p.add_argument("--key-env", help="environment variable holding the key")
        p.add_argument("--confirm", help="owner/repo, instead of typing it")
        p.add_argument("--server", help="the memory tool's URL, for the key page link")
        if name == "decrypt":
            continue
        p.add_argument("--confirm-key-env", help="environment variable holding a generated key, instead of pasting it back")
        g = p.add_mutually_exclusive_group()
        g.add_argument("--to", help="remote URL of a new, empty private repo (recommended)")
        g.add_argument("--in-place", action="store_true", help="replace the repo's history with one commit (force push)")
        if name == "rotate":
            p.add_argument("--new-key-env", help="environment variable holding the new key (default: generate one)")
            g.add_argument("--commit", action="store_true", help="a normal commit; old-key ciphertext stays in history")
    a = ap.parse_args(argv)
    for opt in ("to", "in_place", "commit", "confirm_key_env", "new_key_env"):
        if not hasattr(a, opt):
            setattr(a, opt, None)
    try:
        return run(a)
    except Abort as e:
        print(f"memcrypt: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("memcrypt: interrupted.", file=sys.stderr)
        return 130
