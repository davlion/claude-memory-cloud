"""memcrypt encrypt / decrypt / rotate against local bare repos (git isolated; key never reaches git)."""
import contextlib
import io
import json
import os
import re
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

from helpers import REPO, git_env, tempdir
from memory_kit import crypt

try:
    import cryptography  # noqa: F401
    HAVE = True
except ImportError:
    HAVE = False

VECTORS = json.loads((REPO / "test" / "fixtures" / "crypto-vectors.json").read_text(encoding="utf-8"))
KEY, KEY2 = VECTORS[0]["key_text"], VECTORS[1]["key_text"]
FILE_RE = re.compile(r"^---\nencrypted: claude-memory-v1\nname: ([a-z0-9][a-z0-9-]{0,63})\nkey_id: ([0-9a-f]{16})\n---\n([A-Za-z0-9+/]+={0,2})\n?$")
SEED = {
    "memories/alpha.md": "---\nname: alpha\ndescription: SECRET-alpha-desc\ntype: user\n---\nSECRET-alpha body é\n",
    "projects/billing/memories/beta.md": "---\nname: beta\ndescription: SECRET-beta-desc\ntype: project\n---\nSECRET-beta\n",
    "projects/billing/memories/beta.conflict-20260101T000000Z.md": "---\nname: beta\ndescription: SECRET-c\n---\nSECRET-conflict\n",
    "MEMORY.md": "# Memory index — general\n\n- [alpha](memories/alpha.md) — SECRET-alpha-desc\n",
    "projects/billing/MEMORY.md": "# Memory index — billing\n\n- [beta](memories/beta.md) — SECRET-beta-desc\n",
    "README.md": "hello\n",
}
needs = unittest.skipUnless(HAVE, "cryptography not installed")


@needs
class Memcrypt(unittest.TestCase):
    def setUp(self):
        from memory_kit import memcrypt
        self.mc = memcrypt
        self.tmp = tempdir(self)
        self.scratch = self.tmp / "scratch"
        self.scratch.mkdir()
        env = git_env(self.tmp)
        env.update(GIT_AUTHOR_NAME="T", GIT_AUTHOR_EMAIL="t@example.com", GIT_COMMITTER_NAME="T", GIT_COMMITTER_EMAIL="t@example.com")
        for p in (mock.patch.dict(os.environ, env, clear=True), mock.patch.object(tempfile, "tempdir", str(self.scratch))):
            p.start()
            self.addCleanup(p.stop)
        self.origin = self.bare("acme/memory.git")
        self.seed(self.origin, SEED)

    # helpers
    def git(self, *args, cwd=None):
        return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout

    def bare(self, rel):
        d = self.tmp / rel
        d.parent.mkdir(parents=True, exist_ok=True)
        self.git("init", "-q", "--bare", "-b", "main", str(d))
        return str(d)

    def seed(self, remote, files, msg="seed"):
        w = self.tmp / f"seed{len(list(self.tmp.glob('seed*')))}"
        self.git("clone", "-q", remote, str(w))
        self.git("checkout", "-q", "-B", "main", cwd=w)
        for p, t in files.items():
            (w / p).parent.mkdir(parents=True, exist_ok=True)
            (w / p).write_text(t, encoding="utf-8")
        self.git("add", "-A", cwd=w)
        self.git("commit", "-q", "-m", msg, cwd=w)
        self.git("push", "-q", "origin", "main", cwd=w)

    def head(self, remote):
        return self.git("--git-dir", remote, "rev-parse", "refs/heads/main").strip()

    def show(self, remote, path):
        return self.git("--git-dir", remote, "show", f"main:{path}")

    def files(self, remote):
        return self.git("--git-dir", remote, "ls-tree", "-r", "--name-only", "main").split()

    def run_mc(self, *argv, env=None):
        os.environ.update(env if env is not None else {"MK": KEY})
        self.calls = []
        real = subprocess.run

        def rec(args, **kw):
            self.calls.append((list(args), dict(kw.get("env") or os.environ)))
            return real(args, **kw)
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.object(subprocess, "run", side_effect=rec), contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            try:
                code = self.mc.main(list(argv))
            except SystemExit as e:
                code = e.code
        self.out = out.getvalue() + err.getvalue()
        self.assertEqual(os.listdir(self.scratch), [], "temp dir left behind")
        return code

    def encrypt(self):
        self.assertEqual(self.run_mc("encrypt", self.origin, "--in-place", "--key-env", "MK", "--confirm", "acme/memory"), 0, self.out)

    def assert_key_hidden(self, *keys):
        for args, env in self.calls:
            for k in keys:
                self.assertNotIn(k, " ".join(args))
                self.assertFalse(any(k in v for v in env.values()), args)

    # tests
    def test_encrypt_in_place(self):
        self.encrypt()
        self.assertEqual(self.git("--git-dir", self.origin, "rev-list", "--all").split(), [self.head(self.origin)])
        self.assertNotIn("\nparent ", self.git("--git-dir", self.origin, "cat-file", "-p", "main"))
        key = crypt.parse_key_text(KEY)
        marker = crypt.parse_marker(self.show(self.origin, crypt.MARKER_PATH))
        self.assertTrue(marker.enabled)
        self.assertTrue(crypt.marker_signed_by(key, marker))
        for p, t in SEED.items():
            got = self.show(self.origin, p)
            if "/memories/" in "/" + p:
                self.assertRegex(got, FILE_RE)
                self.assertEqual(crypt.open_memory_file(key, marker.repo_id, p, got), t)
        self.assertEqual(self.show(self.origin, "MEMORY.md"), "# Memory index — general\n\n- [alpha](memories/alpha.md)\n")
        self.assertEqual(self.show(self.origin, "README.md"), "hello\n")
        objs = self.git("--git-dir", self.origin, "rev-list", "--objects", "--all").split("\n")
        for line in filter(None, objs):
            self.assertNotIn("SECRET", self.git("--git-dir", self.origin, "cat-file", "-p", line.split()[0]))
        msg = self.git("--git-dir", self.origin, "log", "-1", "--format=%B")
        self.assertIn("Memory-Source: memcrypt on ", msg)
        self.assertIn("Memory-Scope: *", msg)
        self.assertNotIn(KEY, self.out)
        self.assert_key_hidden(KEY)
        self.assertTrue(any("push" in a and any(x.startswith("--force-with-lease=main:") for x in a) for a, _ in self.calls))

    def test_encrypt_fresh(self):
        new = self.bare("acme/memory-new.git")
        before = self.head(self.origin)
        self.assertEqual(self.run_mc("encrypt", self.origin, "--to", new, "--key-env", "MK", "--confirm", "acme/memory"), 0, self.out)
        self.assertEqual(self.head(self.origin), before)
        self.assertIn("SECRET", self.show(self.origin, "memories/alpha.md"))
        self.assertRegex(self.show(new, "memories/alpha.md"), FILE_RE)
        self.assertNotIn("\nparent ", self.git("--git-dir", new, "cat-file", "-p", "main"))
        self.assertIn("Until you finish, don't save memories to this scope: saves to the old repo would be lost when you delete it.", self.out)
        self.assert_key_hidden(KEY)

    def test_fresh_target_must_be_empty(self):
        new = self.bare("acme/other.git")
        self.seed(new, {"x.md": "x\n"})
        before = self.head(new)
        self.assertNotEqual(self.run_mc("encrypt", self.origin, "--to", new, "--key-env", "MK", "--confirm", "acme/memory"), 0)
        self.assertIn("isn't empty", self.out)
        self.assertEqual(self.head(new), before)

    def test_moved_origin_push_fails(self):
        real = self.mc._confirm

        def racing(*a, **kw):
            self.seed(self.origin, {"memories/late.md": "---\nname: late\n---\nSECRET-late\n"}, "late save")
            return real(*a, **kw)
        with mock.patch.object(self.mc, "_confirm", side_effect=racing):
            code = self.run_mc("encrypt", self.origin, "--in-place", "--key-env", "MK", "--confirm", "acme/memory")
        self.assertNotEqual(code, 0)
        self.assertEqual(self.git("--git-dir", self.origin, "log", "-1", "--format=%s"), "late save\n")
        self.assertIn("SECRET", self.show(self.origin, "memories/alpha.md"))

    def test_wrong_confirm_aborts(self):
        before = self.head(self.origin)
        self.assertNotEqual(self.run_mc("encrypt", self.origin, "--in-place", "--key-env", "MK", "--confirm", "acme/other"), 0)
        self.assertEqual(self.head(self.origin), before)

    def test_already_encrypted(self):
        self.encrypt()
        before = self.head(self.origin)
        self.assertNotEqual(self.run_mc("encrypt", self.origin, "--in-place", "--key-env", "MK", "--confirm", "acme/memory"), 0)
        self.assertIn("use rotate", self.out)
        self.assertEqual(self.head(self.origin), before)

    def test_in_place_refuses_tags(self):
        w = self.tmp / "tagger"
        self.git("clone", "-q", self.origin, str(w))
        self.git("tag", "v1", cwd=w)
        self.git("push", "-q", "origin", "v1", cwd=w)
        before = self.head(self.origin)
        self.assertNotEqual(self.run_mc("encrypt", self.origin, "--in-place", "--key-env", "MK", "--confirm", "acme/memory"), 0)
        self.assertIn("1 tag", self.out)
        self.assertEqual(self.head(self.origin), before)

    def test_decrypt_restores_bytes(self):
        self.encrypt()
        enc_head = self.head(self.origin)
        code = self.run_mc("decrypt", self.origin, "--key-env", "MK", "--confirm", "acme/memory", "--server", "https://mem.example")
        self.assertEqual(code, 0, self.out)
        for p, t in SEED.items():
            if p.endswith("MEMORY.md"):
                continue
            self.assertEqual(self.show(self.origin, p), t)
        key = crypt.parse_key_text(KEY)
        m = crypt.parse_marker(self.show(self.origin, crypt.MARKER_PATH))
        self.assertFalse(m.enabled)
        self.assertTrue(crypt.marker_signed_by(key, m))
        self.assertEqual(self.git("--git-dir", self.origin, "rev-parse", "main^").strip(), enc_head)
        self.assertTrue(self.git("--git-dir", self.origin, "log", "-1", "--format=%B").startswith("encrypt: decrypt all\n"))
        self.assertIn("an admin of acme/memory registers this key once more on the key page (https://mem.example/keys?repo=acme/memory), or uses Stop there.", self.out)
        self.assert_key_hidden(KEY)

    def test_decrypt_wrong_key_changes_nothing(self):
        self.encrypt()
        before = self.head(self.origin)
        self.assertNotEqual(self.run_mc("decrypt", self.origin, "--key-env", "MK", "--confirm", "acme/memory", env={"MK": KEY2}), 0)
        self.assertEqual(self.head(self.origin), before)
        self.assertNotIn(KEY2, self.out)

    def test_rotate(self):
        self.encrypt()
        code = self.run_mc("rotate", self.origin, "--key-env", "MK", "--new-key-env", "NK", "--commit", "--confirm", "acme/memory",
                           "--server", "https://mem.example", env={"MK": KEY, "NK": KEY2})
        self.assertEqual(code, 0, self.out)
        old, new = crypt.parse_key_text(KEY), crypt.parse_key_text(KEY2)
        m = crypt.parse_marker(self.show(self.origin, crypt.MARKER_PATH))
        self.assertTrue(m.enabled)
        self.assertTrue(crypt.marker_signed_by(new, m))
        self.assertFalse(crypt.marker_signed_by(old, m))
        for p, t in SEED.items():
            if "/memories/" in "/" + p:
                got = self.show(self.origin, p)
                self.assertEqual(crypt.open_memory_file(new, m.repo_id, p, got), t)
                with self.assertRaises(crypt.DecryptError):
                    crypt.open_memory_file(old, m.repo_id, p, got)
        self.assertIn("Register the new key: https://mem.example/keys?repo=acme/memory", self.out)
        self.assert_key_hidden(KEY, KEY2)

    def test_rotate_generated_key_must_be_confirmed(self):
        self.encrypt()
        before = self.head(self.origin)
        with mock.patch.object(crypt, "generate_key_text", return_value=KEY2):
            code = self.run_mc("rotate", self.origin, "--key-env", "MK", "--confirm-key-env", "CK", "--in-place", "--confirm", "acme/memory",
                               env={"MK": KEY, "CK": VECTORS[2]["key_text"]})
            self.assertNotEqual(code, 0)
            self.assertEqual(self.head(self.origin), before)
            code = self.run_mc("rotate", self.origin, "--key-env", "MK", "--confirm-key-env", "CK", "--in-place", "--confirm", "acme/memory",
                               env={"MK": KEY, "CK": KEY2})
        self.assertEqual(code, 0, self.out)
        self.assertEqual(self.out.count(KEY2), 1)
        self.assertIn("Register the new key", self.out)
        self.assertTrue(crypt.marker_signed_by(crypt.parse_key_text(KEY2), crypt.parse_marker(self.show(self.origin, crypt.MARKER_PATH))))
        self.assertEqual(len(self.git("--git-dir", self.origin, "rev-list", "--all").split()), 1)
        self.assert_key_hidden(KEY, KEY2)

    def test_rotate_needs_marker_signed_by_old_key(self):
        self.encrypt()
        before = self.head(self.origin)
        code = self.run_mc("rotate", self.origin, "--key-env", "MK", "--new-key-env", "NK", "--commit", "--confirm", "acme/memory",
                           env={"MK": KEY2, "NK": VECTORS[2]["key_text"]})
        self.assertNotEqual(code, 0)
        self.assertEqual(self.head(self.origin), before)

    def test_key_from_op(self):
        bindir = self.tmp / "bin"
        bindir.mkdir()
        op = bindir / "op"
        op.write_text(f"#!/bin/sh\n[ \"$1\" = read ] && [ \"$2\" = op://vault/item/key ] && echo {KEY}\n")
        op.chmod(op.stat().st_mode | stat.S_IEXEC)
        os.environ["PATH"] = f"{bindir}:{os.environ['PATH']}"
        self.assertEqual(self.run_mc("encrypt", self.origin, "--in-place", "--key-op", "op://vault/item/key", "--confirm", "acme/memory", env={}), 0, self.out)
        self.assertTrue(crypt.marker_signed_by(crypt.parse_key_text(KEY), crypt.parse_marker(self.show(self.origin, crypt.MARKER_PATH))))
        self.assert_key_hidden(KEY)

    def test_ts_vectors_open(self):
        for i, v in enumerate(VECTORS):
            key = crypt.parse_key_text(v["key_text"])
            repo_id, path = v["aad"].split("\n")[1:]
            remote = self.bare(f"acme/v{i}.git")
            name = path.rsplit("/", 1)[1][:-3]
            marker = crypt.sign_marker(key, crypt.Marker(True, repo_id, key.id))
            self.seed(remote, {path: f"---\nencrypted: claude-memory-v1\nname: {name}\nkey_id: {key.id}\n---\n{v['sealed']}\n",
                               crypt.MARKER_PATH: crypt.serialize_marker(marker)})
            code = self.run_mc("decrypt", remote, "--key-env", "MK", "--confirm", f"acme/v{i}", env={"MK": v["key_text"]})
            self.assertEqual(code, 0, self.out)
            self.assertEqual(self.show(remote, path), v["plaintext"])


if __name__ == "__main__":
    unittest.main()
