import os
import subprocess
import unittest
from unittest import mock

from helpers import git_env, make_git_dir, tempdir
from memory_kit.remote import cache_key, git_origin, normalize_remote, origin_from_git_config, redact_remote


class NormalizeRemote(unittest.TestCase):
    def test_github_forms(self):
        for url in ["git@github.com:Acme-Org/Billing.git", "https://github.com/acme-org/billing",
                    "https://github.com/acme-org/billing.git/", "ssh://git@github.com/acme-org/billing.git",
                    "https://user:tok@github.com/acme-org/billing", "acme-org/billing", "  acme-org/billing\n"]:
            with self.subTest(url=url):
                self.assertEqual(normalize_remote(url), ("acme-org", "billing"))

    def test_non_github(self):
        for url in ["git@gitlab.com:a/b.git", "https://bitbucket.org/a/b", "/srv/git/repo.git", "a/..", ""]:
            with self.subTest(url=url):
                self.assertIsNone(normalize_remote(url))

    def test_cache_key(self):
        self.assertEqual(cache_key("git@github.com:Acme-Org/Billing.git"), "acme-org__billing")
        self.assertEqual(cache_key(None), "_none")
        self.assertEqual(cache_key("git@gitlab.com:a/b.git"), "_none")

    def test_redact(self):
        self.assertEqual(redact_remote("https://u:ghp_x@git.example.com/a/b"), "https://git.example.com/a/b")
        self.assertEqual(redact_remote("git@github.com:a/b.git"), "git@github.com:a/b.git")
        self.assertEqual(redact_remote("https://github.com/a/b.git"), "https://github.com/a/b.git")
        self.assertEqual(redact_remote("ssh://git@host/a/b"), "ssh://host/a/b")

    def test_redact_password_containing_at(self):
        out = redact_remote("https://user:p@ss@host/x")
        self.assertEqual(out, "https://host/x")
        self.assertNotIn("ss@", out)

    def test_redact_scp_style_credentials(self):
        self.assertEqual(redact_remote("user:token@host.example:a/b"), "host.example:a/b")
        self.assertNotIn("token", redact_remote("user:tok@en@host.example:a/b"))


class OriginLookup(unittest.TestCase):
    def test_config_reader_agrees_with_git(self):
        tmp = tempdir(self)
        env = git_env(tmp)
        patcher = mock.patch.dict(os.environ, env, clear=True)   # git_origin inherits os.environ: isolate it too
        patcher.start()
        self.addCleanup(patcher.stop)
        repo = make_git_dir(tmp, "r", "git@github.com:acme-org/billing.git")
        subprocess.run(["git", "-C", str(repo), "remote", "add", "upstream", "https://github.com/x/y"], check=True, env=env)
        (repo / "sub" / "deeper").mkdir(parents=True)
        subprocess.run(["git", "-C", str(repo), "-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t",
                        "commit", "-q", "--allow-empty", "-m", "init"], check=True, env=env)
        subprocess.run(["git", "-C", str(repo), "worktree", "add", "-q", str(tmp / "wt")], check=True, env=env)
        bare = make_git_dir(tmp, "bare", None)
        for d in (repo, repo / "sub" / "deeper", tmp / "wt", bare, tmp):
            with self.subTest(d=d):
                self.assertEqual(origin_from_git_config(str(d)), git_origin(str(d)))


class ConfigReaderRobust(unittest.TestCase):
    def _repo(self, config_text: bytes):
        tmp = tempdir(self)
        (tmp / "r" / ".git").mkdir(parents=True)
        (tmp / "r" / ".git" / "config").write_bytes(config_text)
        return tmp / "r"

    def test_non_utf8_byte(self):
        r = self._repo(b'[user]\n\tname = caf\xe9\n[remote "origin"]\n\turl = git@github.com:a/b.git\n')
        self.assertEqual(origin_from_git_config(str(r)), "git@github.com:a/b.git")

    def test_inline_comment_and_case(self):
        r = self._repo(b'[Remote "origin"]\n\turl = git@github.com:a/b.git # primary\n')
        self.assertEqual(origin_from_git_config(str(r)), "git@github.com:a/b.git")
        r = self._repo(b'[remote "origin"]\n\turl = git@github.com:a/b.git ; x\n')
        self.assertEqual(origin_from_git_config(str(r)), "git@github.com:a/b.git")

    def test_multi_url_first_wins(self):
        r = self._repo(b'[remote "origin"]\n\turl = git@github.com:a/b.git\n\turl = git@github.com:c/d.git\n')
        self.assertEqual(origin_from_git_config(str(r)), "git@github.com:a/b.git")

    def test_bad_commondir_and_gitfile(self):
        tmp = tempdir(self)
        (tmp / "wt").mkdir()
        (tmp / "gd").mkdir()
        (tmp / "wt" / ".git").write_text("gitdir: ../gd\n")      # relative gitdir
        (tmp / "gd" / "config").write_text('[remote "origin"]\n\turl = git@github.com:a/b.git\n')
        self.assertEqual(origin_from_git_config(str(tmp / "wt")), "git@github.com:a/b.git")
        (tmp / "gd" / "commondir").write_bytes(b"\xff\xfe")      # undecodable: must not raise
        self.assertIsNone(origin_from_git_config(str(tmp / "wt")))
        (tmp / "gd" / "commondir").unlink()
        (tmp / "gd" / "commondir").mkdir()                         # unreadable (a directory)
        self.assertIsNone(origin_from_git_config(str(tmp / "wt")))
        (tmp / "wt" / ".git").write_bytes(b"\xff\xfe")           # undecodable .git file
        self.assertIsNone(origin_from_git_config(str(tmp / "wt")))


if __name__ == "__main__":
    unittest.main()
