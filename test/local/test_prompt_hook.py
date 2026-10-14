"""Level 3: the UserPromptSubmit hook, run as Claude Code runs it (spec §9)."""
import json
import subprocess
import unittest

from helpers import KIT, PY, SCOPES, clean_env, make_git_dir, run_hook, tempdir

TRIGGERS = ["Save a memory: we deploy on Fridays", "please save this memory", "save memory about X",
            "Remember this for next time", "remember that I use zsh", "Don't do that again",
            "don’t let the build break like this again", "dont do force pushes again",
            "Note for the future: tests need docker", "note for future: x", "Add this to your memory",
            "add to memory: the API is v2"]
NON_TRIGGERS = ["What do you remember about the build?", "save the file", "memory usage is high",
                "don't do that", "remember thistle", "add tests", ""]


class PromptHook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir(self)
        self.home = self.tmp / "home"
        (self.home / ".claude-memory-cloud").mkdir(parents=True)
        (self.home / ".claude-memory-cloud" / "scopes.json").write_text(json.dumps(SCOPES))
        self.env = clean_env(self.home)

    def ctx(self, prompt, cwd):
        return run_hook("user_prompt_submit.py", {"hook_event_name": "UserPromptSubmit", "prompt": prompt,
                                                  "cwd": str(cwd), "session_id": "t"}, self.env)

    def test_trigger_table(self):
        d = make_git_dir(self.tmp, "r", None)
        for p in TRIGGERS:
            with self.subTest(p=p):
                self.assertIn("claude-memory: this looks like a request to save a memory", self.ctx(p, d)[0])

    def test_non_trigger_table_outputs_nothing(self):
        d = make_git_dir(self.tmp, "r", "git@github.com:acme-org/billing.git")
        for p in NON_TRIGGERS:
            with self.subTest(p=p):
                self.assertEqual(self.ctx(p, d)[0], "")

    def test_client_org_repo(self):
        d = make_git_dir(self.tmp, "billing", "git@github.com:Acme-Org/Billing.git")
        out = self.ctx("save a memory: x", d)[0]
        self.assertIn("Origin remote: git@github.com:Acme-Org/Billing.git (project = acme-org/billing).", out)
        self.assertIn("Client scope for this repo's owner acme-org: acme.", out)

    def test_personal_repo(self):
        d = make_git_dir(self.tmp, "tool", "https://github.com/dav/tool.git")
        out = self.ctx("remember this", d)[0]
        self.assertIn("(project = dav/tool)", out)
        self.assertIn("dav is the user's own account: no client scope", out)
        self.assertNotIn("Client scope", out)

    def test_unknown_owner_has_no_client_hint(self):
        d = make_git_dir(self.tmp, "x", "https://github.com/someone/x")
        out = self.ctx("remember this", d)[0]
        self.assertIn("(project = someone/x)", out)
        self.assertNotIn("Client scope", out)

    def test_no_remote_and_non_git(self):
        for d in (make_git_dir(self.tmp, "local", None), self.tmp):
            with self.subTest(d=d):
                out = self.ctx("remember this", d)[0]
                self.assertNotIn("Origin remote", out)
                self.assertIn("No git origin remote here", out)

    def test_credentials_never_echoed(self):
        d = make_git_dir(self.tmp, "c", "https://u:secret123@git.example.com/a/b.git")
        out = self.ctx("remember this", d)[0]
        self.assertNotIn("secret123", out)
        self.assertIn("not on GitHub", out)

    def test_under_100_ms(self):
        d = make_git_dir(self.tmp, "billing", "git@github.com:acme-org/billing.git")
        for p in ("save a memory: x", "unrelated prompt"):
            with self.subTest(p=p):
                best = min(self.ctx(p, d)[1] for _ in range(5))
                self.assertLess(best, 0.1)


class PromptHookRobustness(unittest.TestCase):
    """Odd stdin never produces a traceback, a non-zero exit or a false 'hook failed' message."""

    def setUp(self):
        self.tmp = tempdir(self)
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.env = clean_env(self.home)

    def raw(self, stdin):
        return subprocess.run([PY, "-I", "-S", str(KIT / "hooks" / "user_prompt_submit.py")], input=stdin,
                              capture_output=True, text=True, env=self.env, timeout=10)

    def test_bad_stdin_is_silent(self):
        for stdin in ("", "not json", "[]", "null", '"x"', "{}", '{"prompt": 5}', '{"prompt": null}'):
            with self.subTest(stdin=stdin):
                r = self.raw(stdin)
                self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

    def test_matching_prompt_with_missing_or_bad_cwd_still_hints(self):
        for extra in ({}, {"cwd": None}, {"cwd": 5}, {"cwd": "a\0b"}, {"cwd": ""}):
            with self.subTest(extra=extra):
                r = self.raw(json.dumps(dict(prompt="remember this", **extra)))
                self.assertEqual((r.returncode, r.stderr), (0, ""))
                self.assertIn("claude-memory: this looks like", json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"])
                self.assertNotIn("hook failed", r.stdout)

    def test_closed_stdout_exits_zero_quietly(self):
        r = subprocess.run(f'"{PY}" -I -S "{KIT / "hooks" / "user_prompt_submit.py"}" <<< \'{{"prompt":"remember this"}}\' >&-',
                           shell=True, executable="/bin/bash", capture_output=True, text=True, env=self.env, timeout=10)
        self.assertEqual((r.returncode, r.stderr), (0, ""))

    def test_cloud_session_is_silent(self):
        self.env["CLAUDE_CODE_REMOTE"] = "true"
        r = self.raw(json.dumps({"prompt": "remember this"}))
        self.assertEqual((r.returncode, r.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()
