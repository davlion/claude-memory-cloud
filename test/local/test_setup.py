"""Level 3: setup.sh install / --uninstall / --export-local against a temporary HOME, with golden diffs."""
import json
import os
import re
import subprocess
import unittest

from helpers import FIXTURES, PY, REPO, SCOPES, FakeWorker, clean_env, make_git_dir, run_hook, tempdir


class Setup(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir(self)
        self.worker = FakeWorker("ok")
        self.addCleanup(self.worker.close)
        self.home = self.tmp / "home"
        (self.home / ".claude").mkdir(parents=True)
        self.settings = self.home / ".claude" / "settings.json"
        self.claude_md = self.home / ".claude" / "CLAUDE.md"
        self.root = self.home / ".claude-memory-cloud"
        self.scopes_file = self.tmp / "scopes.staging.json"
        self.scopes_file.write_text(json.dumps({"dav": SCOPES["scopes"], "friend": {"general": "friend/claude-memory"}}))
        self.env = clean_env(self.home, MEMKIT_PYTHON=PY)
        self.repo = make_git_dir(self.tmp, "billing", "git@github.com:acme-org/billing.git")

    def setup_sh(self, *args, input_text=""):
        return subprocess.run(["bash", str(REPO / "setup.sh"), *args], capture_output=True, text=True,
                              env=self.env, cwd=str(self.repo), input=input_text, timeout=60)

    def install(self, *extra):
        r = self.setup_sh("--worker-url", self.worker.url, "--scopes-file", str(self.scopes_file), "--login", "dav", *extra)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r

    def snapshot_files(self):
        return {p: p.read_bytes() for p in (self.settings, self.claude_md) if p.exists()}

    def test_install_writes_everything(self):
        self.settings.write_text((FIXTURES / "settings-nsjson.json").read_text())
        r = self.install()
        self.assertIn("preflight: all local checks passed", r.stdout)
        s = json.loads(self.settings.read_text())
        self.assertIs(s["autoMemoryEnabled"], False)
        self.assertEqual(len(s["hooks"]["SessionStart"]), 2)
        self.assertIn("/.claude-memory-cloud/kit/hooks/session_start.py", s["hooks"]["SessionStart"][1]["hooks"][0]["command"])
        self.assertEqual(s["hooks"]["PostToolUse"][0]["matcher"], "mcp__.*__memory_index")
        self.assertIn("/.claude-memory-cloud/kit/hooks/post_tool_use.py", s["hooks"]["PostToolUse"][0]["hooks"][0]["command"])
        self.assertNotIn("Edit(~/.claude-memory-cloud/cache/**)", s["permissions"]["allow"])   # the hook writes the snapshot
        self.assertIn("<!-- claude-memory-cloud:routing-rule:begin -->", self.claude_md.read_text())
        self.assertEqual(json.loads((self.root / "scopes.json").read_text()), SCOPES)
        self.assertEqual(json.loads((self.root / "config.json").read_text())["worker_url"], self.worker.url)
        for d in ("", "outbox", "cache"):
            self.assertEqual(os.stat(self.root / d).st_mode & 0o777, 0o700, d)
        for f in ("scopes.json", "config.json", "state.json"):
            self.assertEqual(os.stat(self.root / f).st_mode & 0o777, 0o600, f)
        self.assertTrue(list((self.home / ".claude").glob("settings.json.bak-*")))

    def test_second_install_is_a_noop(self):
        self.install()
        before = self.snapshot_files()
        state = (self.root / "state.json").read_text()
        r = self.install()
        self.assertEqual(self.snapshot_files(), before)
        self.assertEqual((self.root / "state.json").read_text(), state)
        self.assertNotIn("updated", r.stdout)

    def test_rerun_without_scope_args_keeps_the_map(self):
        self.install()
        r = self.setup_sh()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(json.loads((self.root / "scopes.json").read_text()), SCOPES)

    def test_missing_scope_map_is_an_error(self):
        r = self.setup_sh("--worker-url", self.worker.url)
        self.assertEqual(r.returncode, 2)
        self.assertIn("--scopes-file", r.stderr)

    def test_installed_hooks_run(self):
        self.install()
        hooks = self.root / "kit" / "hooks"
        self.assertEqual(run_hook("session_start.py", {"source": "startup", "cwd": str(self.repo)}, self.env, hooks)[0],
                         "Memory project for this session: acme-org/billing")
        out = run_hook("user_prompt_submit.py", {"prompt": "remember this", "cwd": str(self.repo)}, self.env, hooks)[0]
        self.assertIn("Client scope for this repo's owner acme-org: acme.", out)

    def test_dry_run_changes_nothing(self):
        self.settings.write_text((FIXTURES / "settings-plain.json").read_text())
        before = self.snapshot_files()
        r = self.install("--dry-run")
        self.assertIn('+  "autoMemoryEnabled": false', r.stdout.replace('"autoMemoryEnabled": true', ""))
        self.assertEqual(self.snapshot_files(), before)
        self.assertFalse(self.root.exists())

    def test_uninstall_golden_round_trip(self):
        cases = [("settings-nsjson.json", "CLAUDE-existing.md"), ("settings-plain.json", None), (None, None)]
        for settings_fx, md_fx in cases:
            with self.subTest(settings=settings_fx, md=md_fx):
                for p in (self.settings, self.claude_md):
                    if p.exists():
                        p.unlink()
                if settings_fx:
                    self.settings.write_text((FIXTURES / settings_fx).read_text())
                if md_fx:
                    self.claude_md.write_text((FIXTURES / md_fx).read_text())
                before = self.snapshot_files()
                self.install()
                self.assertNotEqual(self.snapshot_files(), before)
                r = self.setup_sh("--uninstall", "--delete-cache")
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertEqual(self.snapshot_files(), before)
                self.assertFalse(self.root.exists())
                r2 = self.setup_sh("--uninstall")
                self.assertEqual((r2.returncode, r2.stdout.strip()), (0, "Nothing to uninstall."))
                self.assertEqual(self.snapshot_files(), before)

    def test_outbox_blocks_uninstall_unless_force(self):
        self.install()
        entry = FIXTURES / "outbox" / "20261013T180400Z-prefer-small-commits.md"
        (self.root / "outbox" / entry.name).write_text(entry.read_text())
        before = self.snapshot_files()
        r = self.setup_sh("--uninstall")
        self.assertEqual(r.returncode, 3)
        self.assertIn("1 memories are still queued", r.stdout)
        self.assertEqual(self.snapshot_files(), before)
        r = self.setup_sh("--uninstall", "--force", "--keep-cache")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.root / "outbox" / entry.name).exists())
        self.assertFalse((self.root / "kit").exists())
        self.assertFalse(self.settings.exists())    # install created it, so uninstall removes it

    def test_uninstall_keeps_cache_unless_confirmed(self):
        self.install()
        (self.root / "cache" / "_none.md").write_text("x")
        r = self.setup_sh("--uninstall")            # stdin is not a tty: the answer defaults to no
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.root / "cache" / "_none.md").exists())

    def test_uninstall_restores_previous_true(self):
        self.settings.write_text('{\n  "autoMemoryEnabled": true\n}\n')
        self.install()
        self.setup_sh("--uninstall", "--delete-cache")
        self.assertEqual(self.settings.read_text(), '{\n  "autoMemoryEnabled": true\n}\n')

    def test_outbox_done_helper(self):
        self.install()
        name = "20261013T180400Z-prefer-small-commits.md"
        (self.root / "outbox" / name).write_text("x")
        memkit = [PY, "-I", "-S", str(self.root / "kit" / "bin" / "memkit.py")]
        bad = subprocess.run(memkit + ["outbox-done", "../config.json"], env=self.env, capture_output=True, text=True)
        self.assertEqual(bad.returncode, 2)
        self.assertTrue((self.root / "config.json").exists())
        ok = subprocess.run(memkit + ["outbox-done", name], env=self.env, capture_output=True, text=True)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertFalse((self.root / "outbox" / name).exists())

    def test_export_local(self):
        self.install()
        r = self.setup_sh("--export-local", "--cwd", str(self.repo))
        stage = self.root / "export" / "acme-org__billing"
        self.assertIn(f"{stage}/project/<name>.md", r.stdout)
        self.assertIn("export-finish --cwd", r.stdout)
        mem = "---\nname: {n}\ndescription: {d}\nmetadata:\n  type: project\n---\n\nbody &lt;/memory x\n"
        for scope, n in (("project", "deploy-friday"), ("general", "deploy-friday"), ("general", "small-commits")):
            (stage / scope).mkdir(parents=True, exist_ok=True)
            (stage / scope / f"{n}.md").write_text(mem.format(n=n, d=f"{scope} {n}"))
        r = self.setup_sh("--export-local", "--finish", "--cwd", str(self.repo))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        target = self.home / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(self.repo)) / "memory"
        self.assertEqual(sorted(p.name for p in target.iterdir()),
                         ["MEMORY.md", "deploy-friday.md", "general-deploy-friday.md", "small-commits.md"])
        self.assertIn("body </memory x", (target / "small-commits.md").read_text())
        index = (target / "MEMORY.md").read_text()
        self.assertIn("- [general-deploy-friday](general-deploy-friday.md) — general deploy-friday", index)
        again = self.setup_sh("--export-local", "--finish", "--cwd", str(self.repo))
        self.assertIn("exported 0 memories", again.stdout)
        self.assertEqual((target / "MEMORY.md").read_text(), index)


class SetupSafety(unittest.TestCase):
    """Round trips, refusals, state.json, dry-run and outbox-done hardening (controller rulings 1-8)."""

    def setUp(self):
        self.tmp = tempdir(self)
        self.worker = FakeWorker("ok")
        self.addCleanup(self.worker.close)
        self.home = self.tmp / "home"
        (self.home / ".claude").mkdir(parents=True)
        self.settings = self.home / ".claude" / "settings.json"
        self.claude_md = self.home / ".claude" / "CLAUDE.md"
        self.root = self.home / ".claude-memory-cloud"
        self.env = clean_env(self.home, MEMKIT_PYTHON=PY)
        self.repo = make_git_dir(self.tmp, "billing", "git@github.com:acme-org/billing.git")

    def setup_sh(self, *args):
        return subprocess.run(["bash", str(REPO / "setup.sh"), *args], capture_output=True, text=True,
                              env=self.env, cwd=str(self.repo), input="", timeout=60)

    def install(self, *extra, ok=True):
        r = self.setup_sh("--worker-url", self.worker.url, "--scope", "general=dav/claude-memory",
                          "--scope", "acme=acme-org/claude-memory", "--login", "dav", *extra)
        if ok:
            self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return r

    def state(self):
        return json.loads((self.root / "state.json").read_text())

    def files(self):
        return {p: p.read_bytes() for p in (self.settings, self.claude_md) if p.exists()}

    def tree(self):
        """Every path under HOME except ~/Library (Apple's python writes its bytecode cache there)."""
        return sorted(str(p) for p in self.home.rglob("*") if "Library" not in p.relative_to(self.home).parts[:1])

    # memory MCP allow rules ---------------------------------------------------------------------------
    def write_claude_json(self, data):
        (self.home / ".claude.json").write_text(data if isinstance(data, str) else json.dumps(data))

    def mcp_rules(self, *names):
        return [f"mcp__{n}__{t}" for n in names for t in ("memory_index", "memory_read", "memory_search")]

    def allow(self):
        return json.loads(self.settings.read_text())["permissions"]["allow"]

    def test_detects_project_and_user_scoped_servers(self):
        u = self.worker.url
        self.write_claude_json({
            "mcpServers": {"user-mem": {"url": u + "/mcp"}, "other": {"url": "https://example.com/mcp"}},
            "projects": {"/a": {"mcpServers": {"proj-mem": {"url": u + "/"}}}, "/b": {"mcpServers": "odd"},
                         "/c": 5, "/d": {"mcpServers": {"dup": {"url": u}, "user-mem": {"url": u + "/mcp"},
                                                         "x": 3, "evil": {"url": u + ".evil.com/mcp"}}}}})
        r = self.install()
        rules = self.allow()
        for n in ("user-mem", "proj-mem", "dup"):
            for rule in self.mcp_rules(n):
                self.assertIn(rule, rules)
        self.assertEqual(len([x for x in rules if x.startswith("mcp__")]), 9)
        self.assertFalse([x for x in rules if "other" in x or "evil" in x or "memory_save" in x or "memory_delete" in x])
        self.assertIn("Bash(git remote get-url origin)", rules)
        self.assertNotIn("--mcp-server", r.stdout)
        self.assertEqual(sorted(json.loads((self.root / "config.json").read_text())["mcp_servers"]),
                         ["dup", "proj-mem", "user-mem"])

    def test_no_server_found_prints_hint_and_still_installs(self):
        for label, content in (("missing", None), ("invalid", "{nope"), ("array", "[]"),
                               ("odd", {"mcpServers": [1], "projects": []})):
            with self.subTest(label):
                if (self.home / ".claude.json").exists():
                    (self.home / ".claude.json").unlink()
                if content is not None:
                    self.write_claude_json(content)
                r = self.install()
                self.assertIn("rerun with --mcp-server <name>", r.stdout.replace("Rerun", "rerun"))
                self.assertFalse([x for x in self.allow() if x.startswith("mcp__")])
                self.setup_sh("--uninstall", "--delete-cache")

    def test_mcp_server_flag_validation_and_union(self):
        for bad in ("a b", "x/y", "", "é", "a;b"):
            r = self.setup_sh("--worker-url", self.worker.url, "--scope", "general=dav/claude-memory",
                              "--login", "dav", "--mcp-server", bad)
            self.assertEqual(r.returncode, 2, bad)
            self.assertFalse(self.root.exists())
        self.write_claude_json({"mcpServers": {"found": {"url": self.worker.url + "/mcp"}}})
        r = self.install("--mcp-server", "mine", "--mcp-server", "mine_2", "--mcp-server", "found")
        self.assertNotIn("--mcp-server <name>", r.stdout)
        self.assertEqual([x for x in self.allow() if x.startswith("mcp__")], self.mcp_rules("mine", "mine_2", "found"))

    def test_dry_run_shows_mcp_rules(self):
        self.write_claude_json({"mcpServers": {"found": {"url": self.worker.url + "/mcp"}}})
        r = self.install("--dry-run", "--mcp-server", "mine")
        self.assertIn("memory MCP servers: mine, found", r.stdout)
        self.assertIn("+      \"mcp__found__memory_read\"", r.stdout)
        self.assertIn("mcp__mine__memory_search", r.stdout)
        self.assertFalse(self.root.exists())

    def test_mcp_rules_idempotent_tracked_and_uninstall_exact(self):
        pre = ["Bash(npm test *)", "mcp__mine__memory_read", "Bash(git remote get-url origin)"]
        self.settings.write_text(json.dumps({"permissions": {"allow": list(pre)}}))
        self.install("--mcp-server", "mine")
        added = self.state()["added_rules"]
        self.assertIn("mcp__mine__memory_index", added)
        self.assertIn("mcp__mine__memory_search", added)
        self.assertNotIn("mcp__mine__memory_read", added)           # the user already had it
        self.assertNotIn("Bash(git remote get-url origin)", added)
        after, st = self.files(), self.state()
        self.install()                      # rerun without the flag: stored name kept, nothing changes
        self.assertEqual((self.files(), self.state()), (after, st))
        self.assertEqual(len([x for x in self.allow() if x.startswith("mcp__")]), 3)
        self.setup_sh("--uninstall", "--delete-cache")
        self.assertEqual(self.allow(), pre)

    def test_uninstall_without_state_removes_stored_mcp_rules(self):
        self.install("--mcp-server", "mine")
        (self.root / "state.json").unlink()
        self.setup_sh("--uninstall", "--delete-cache")
        left = json.loads(self.settings.read_text()) if self.settings.exists() else {}
        self.assertEqual(left.get("permissions", {}).get("allow", []), [])

    def test_claude_md_round_trip_byte_for_byte(self):
        for label, content in (("missing", None), ("trailing newline", "# mine\nline\n"),
                               ("no trailing newline", "# mine\nline"), ("empty file", ""),
                               ("blank lines at end", "x\n\n\n"), ("crlf", "a\r\nb\r\n")):
            with self.subTest(label):
                if self.claude_md.exists():
                    self.claude_md.unlink()
                if content is not None:
                    self.claude_md.write_bytes(content.encode())
                before = self.files()
                self.install()
                self.assertIn(b"routing-rule:begin", self.claude_md.read_bytes())
                r = self.setup_sh("--uninstall", "--delete-cache")
                self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
                self.assertEqual(self.files(), before)

    def test_settings_blank_file_round_trips(self):
        self.settings.write_text("")
        self.install()
        self.setup_sh("--uninstall", "--delete-cache")
        self.assertEqual(self.settings.read_bytes(), b"")

    def test_state_schema_and_reinstall_merge(self):
        self.settings.write_text('{\n  "autoMemoryEnabled": true,\n  "permissions": {"allow": ["Read(~/.claude-memory-cloud/**)"]}\n}\n')
        self.install()
        st = self.state()
        self.assertEqual(os.stat(self.root / "state.json").st_mode & 0o777, 0o600)
        self.assertIs(st["auto_memory_previous"], True)
        self.assertNotIn("Read(~/.claude-memory-cloud/**)", st["added_rules"])    # the user already had it
        self.assertIn("Edit(~/.claude-memory-cloud/outbox/**)", st["added_rules"])
        self.assertEqual(st["created"], ["hooks", "hooks.SessionStart", "hooks.UserPromptSubmit", "hooks.PostToolUse"])
        for k in ("version", "added_rules", "created", "settings_created", "claude_md_created", "claude_md_sep",
                  "installed_at", "auto_memory_previous"):
            self.assertIn(k, st)
        first = dict(st)
        self.install()                       # reinstall: previous (true) is kept, lists unchanged
        self.assertEqual(self.state(), first)
        # a later reinstall that adds a rule unions it in (user removed one rule by hand)
        s = json.loads(self.settings.read_text())
        s["permissions"]["allow"].remove("Edit(~/.claude-memory-cloud/export/**)")
        self.settings.write_text(json.dumps(s))
        self.install()
        self.assertEqual(self.state()["added_rules"], first["added_rules"])
        self.assertIs(self.state()["auto_memory_previous"], True)
        self.setup_sh("--uninstall", "--delete-cache")
        back = json.loads(self.settings.read_text())
        self.assertIs(back["autoMemoryEnabled"], True)
        self.assertEqual(back["permissions"]["allow"], ["Read(~/.claude-memory-cloud/**)"])
        self.assertNotIn("hooks", back)

    def test_previous_non_bool_and_absent_restored_exactly(self):
        self.settings.write_text('{\n  "autoMemoryEnabled": "yes",\n  "theme": "dark"\n}\n')
        self.install()
        self.assertEqual(self.state()["auto_memory_previous"], {"value": "yes"})
        self.setup_sh("--uninstall", "--delete-cache")
        self.assertEqual(self.settings.read_text(), '{\n  "autoMemoryEnabled": "yes",\n  "theme": "dark"\n}\n')
        self.settings.write_text('{\n  "theme": "dark"\n}\n')
        self.install()
        self.assertEqual(self.state()["auto_memory_previous"], "absent")
        self.setup_sh("--uninstall", "--delete-cache")
        self.assertEqual(self.settings.read_text(), '{\n  "theme": "dark"\n}\n')

    def test_unbalanced_markers_refuse_install_and_uninstall(self):
        bad = "keep\n<!-- claude-memory-cloud:routing-rule:begin -->\nno end\n"
        self.claude_md.write_text(bad)
        self.settings.write_text('{\n  "theme": "dark"\n}\n')
        r = self.install(ok=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("routing-rule markers", r.stderr)
        self.assertEqual(self.claude_md.read_text(), bad)
        self.assertEqual(self.settings.read_text(), '{\n  "theme": "dark"\n}\n')
        self.assertFalse(self.root.exists())
        # uninstall with a good install, then break the markers
        self.claude_md.write_text("keep\n")
        self.install()
        broken = self.claude_md.read_text() + "<!-- claude-memory-cloud:routing-rule:end -->\n"
        self.claude_md.write_text(broken)
        before_settings = self.settings.read_bytes()
        r = self.setup_sh("--uninstall", "--delete-cache")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.claude_md.read_text(), broken)
        self.assertEqual(self.settings.read_bytes(), before_settings)
        self.assertTrue((self.root / "kit").exists())

    def test_bad_settings_shape_and_json_refuse(self):
        for text in ('{"hooks": null}', '{"permissions": null}', "{not json", "[]"):
            with self.subTest(text=text):
                self.settings.write_text(text)
                r = self.install(ok=False)
                self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
                self.assertEqual(self.settings.read_text(), text)
                self.assertFalse(self.root.exists())

    def test_uninstall_without_state_is_best_effort_and_warns(self):
        self.settings.write_text('{"autoMemoryEnabled": true, "theme": "dark"}\n')
        self.install()
        (self.root / "state.json").unlink()
        r = self.setup_sh("--uninstall", "--delete-cache")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("best-effort", r.stdout)
        s = json.loads(self.settings.read_text())
        self.assertNotIn("hooks", s)
        self.assertNotIn("permissions", s)
        self.assertIs(s["autoMemoryEnabled"], False)    # previous value unknown: left alone
        self.assertNotIn("routing-rule", self.claude_md.read_text() if self.claude_md.exists() else "")

    def test_uninstall_dry_run_writes_nothing(self):
        self.settings.write_text('{\n  "theme": "dark"\n}\n')
        self.claude_md.write_text("mine\n")
        self.install()
        before = self.files()
        tree = self.tree()
        r = self.setup_sh("--uninstall", "--dry-run")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("-<!-- claude-memory-cloud:routing-rule:begin -->", r.stdout)
        self.assertIn("dry run", r.stdout)
        self.assertEqual(self.files(), before)
        self.assertEqual(self.tree(), tree)

    def test_install_dry_run_shows_claude_md_and_writes_nothing(self):
        self.claude_md.write_text("mine\n")
        before = self.files()
        tree = self.tree()
        r = self.install("--dry-run")
        self.assertIn("+<!-- claude-memory-cloud:routing-rule:begin -->", r.stdout)
        self.assertIn("hooks", r.stdout)
        self.assertEqual(self.files(), before)
        self.assertEqual(self.tree(), tree)
        self.assertFalse(self.root.exists())
        self.assertFalse(self.settings.exists())

    def test_symlinked_settings_is_followed_and_kept(self):
        real = self.tmp / "dotfiles-settings.json"
        real.write_text('{\n  "theme": "dark"\n}\n')
        self.settings.symlink_to(real)
        self.install()
        self.assertTrue(self.settings.is_symlink())
        self.assertIn("hooks", json.loads(real.read_text()))
        self.setup_sh("--uninstall", "--delete-cache")
        self.assertTrue(self.settings.is_symlink())
        self.assertEqual(real.read_text(), '{\n  "theme": "dark"\n}\n')

    def test_outbox_done_refusals(self):
        self.install()
        outbox = self.root / "outbox"
        good = "20261013T180400Z-prefer-small-commits.md"
        (outbox / good).write_text("x")
        secret = self.tmp / "secret.md"
        secret.write_text("keep me")
        link = "20261013T180401Z-link.md"
        (outbox / link).symlink_to(secret)
        dirname = "20261013T180402Z-adir.md"
        (outbox / dirname).mkdir()
        from memory_kit.install import outbox_done
        errs, outs = [], []
        code = outbox_done(outbox, [link, dirname, "../secret.md", "sub/" + good, str(secret), "config.json",
                                    "20261013T180403Z-missing.md"], out=outs.append, err=errs.append)
        self.assertEqual(code, 2)
        self.assertEqual(outs, [])
        self.assertTrue(secret.exists())
        self.assertTrue((outbox / link).is_symlink())
        self.assertTrue((outbox / dirname).is_dir())
        self.assertEqual(len(errs), 7)
        self.assertEqual(outbox_done(outbox, [good], out=outs.append, err=errs.append), 0)
        self.assertFalse((outbox / good).exists())
        self.assertEqual(outbox_done(outbox, [good], out=outs.append, err=errs.append), 1)

    def test_outbox_done_cli_refuses_symlink(self):
        self.install()
        secret = self.tmp / "secret.md"
        secret.write_text("keep me")
        link = "20261013T180401Z-link.md"
        (self.root / "outbox" / link).symlink_to(secret)
        r = subprocess.run([PY, "-I", "-S", str(self.root / "kit" / "bin" / "memkit.py"), "outbox-done", link],
                           env=self.env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)
        self.assertTrue(secret.exists())

    def test_managed_settings_path_by_platform(self):
        from memory_kit.preflight import managed_settings_path
        self.assertEqual(str(managed_settings_path("linux")), "/etc/claude-code/managed-settings.json")
        self.assertEqual(str(managed_settings_path("darwin")),
                         "/Library/Application Support/ClaudeCode/managed-settings.json")

    def test_preflight_honors_managed_settings_override(self):
        self.install()
        managed = self.tmp / "managed.json"
        managed.write_text('{"autoMemoryEnabled": true}')
        env = dict(self.env, MEMKIT_MANAGED_SETTINGS=str(managed))
        memkit = [PY, "-I", "-S", str(self.root / "kit" / "bin" / "memkit.py"), "preflight", "--cwd", str(self.repo)]
        r = subprocess.run(memkit, env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("auto-memory", r.stdout)
        r = subprocess.run(memkit, env=self.env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        # install itself reports the managed override as a preflight problem (exit 1) and still installs
        r = subprocess.run(["bash", str(REPO / "setup.sh"), "--worker-url", self.worker.url], capture_output=True,
                           text=True, env=env, cwd=str(self.repo), timeout=60)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("preflight found problems", r.stdout)

    def test_force_uninstall_keeps_unknown_files_in_outbox(self):
        self.install()
        (self.root / "outbox" / "notes.txt").write_text("mine")
        r = self.setup_sh("--uninstall", "--keep-cache")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.root / "outbox" / "notes.txt").read_text(), "mine")

    def _stage(self, items):
        mem = "---\nname: {n}\ndescription: {d}\nmetadata:\n  type: project\n---\n\nbody {d}\n"
        stage = self.root / "export" / "acme-org__billing"
        for scope, n, d in items:
            (stage / scope).mkdir(parents=True, exist_ok=True)
            (stage / scope / f"{n}.md").write_text(mem.format(n=n, d=d))
        return mem

    def _target(self):
        return self.home / ".claude" / "projects" / re.sub(r"[^A-Za-z0-9]", "-", str(self.repo)) / "memory"

    def test_install_write_failure_is_clean_and_uninstall_restores(self):
        settings = '{\n  "theme": "dark"\n}\n'
        self.settings.write_text(settings)
        ro = self.tmp / "ro"
        ro.mkdir()
        self.claude_md.symlink_to(ro / "CLAUDE.md")     # dangling link into a dir we can't write to
        os.chmod(ro, 0o500)
        self.addCleanup(os.chmod, ro, 0o700)
        r = self.install(ok=False)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("setup: install stopped partway (PermissionError", r.stderr)
        self.assertIn("run ./setup.sh --uninstall to undo what was done.", r.stderr)
        self.assertNotIn("Traceback", r.stderr)
        self.assertNotEqual(self.settings.read_text(), settings)    # settings had been written before the failure
        r = self.setup_sh("--uninstall", "--delete-cache")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.settings.read_text(), settings)
        self.assertFalse(self.root.exists())

    def test_uninstall_write_failure_is_clean(self):
        self.install()
        os.chmod(self.claude_md.parent, 0o500)      # atomic write of CLAUDE.md/settings.json now fails
        self.addCleanup(os.chmod, self.claude_md.parent, 0o700)
        r = self.setup_sh("--uninstall", "--delete-cache")
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("setup: uninstall stopped partway (", r.stderr)
        self.assertIn("rerun ./setup.sh --uninstall.", r.stderr)
        self.assertNotIn("Traceback", r.stderr)

    def test_setup_sh_writes_no_bytecode(self):
        import shutil
        copy = self.tmp / "checkout"
        copy.mkdir()
        shutil.copy2(REPO / "setup.sh", copy / "setup.sh")
        shutil.copytree(REPO / "kit", copy / "kit", ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        r = subprocess.run(["bash", str(copy / "setup.sh"), "--worker-url", self.worker.url, "--scope",
                            "general=dav/claude-memory", "--login", "dav", "--dry-run"],
                           capture_output=True, text=True, env=self.env, cwd=str(self.repo), timeout=60)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(list(copy.rglob("__pycache__")) + list(copy.rglob("*.pyc")), [])
        self.assertEqual([p for p in self.home.rglob("*.pyc")], [])

    def test_export_never_overwrites_and_reserves_memory(self):
        self.install()
        mem = self._stage([("project", "foo", "new foo"), ("general", "MEMORY", "idx")])
        target = self._target()
        target.mkdir(parents=True)
        (target / "foo.md").write_text("mine")
        (target / "foo.cloud.md").write_text("older export")
        (target / "MEMORY.md").write_text("# index\n")
        r = self.setup_sh("--export-local", "--finish", "--cwd", str(self.repo))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual((target / "foo.md").read_text(), "mine")
        self.assertEqual((target / "foo.cloud.md").read_text(), "older export")
        self.assertIn("body new foo", (target / "foo.cloud-2.md").read_text())
        self.assertIn("body idx", (target / "MEMORY.cloud.md").read_text())
        self.assertEqual((target / "MEMORY.md").read_text().splitlines()[0], "# index")
        r = self.setup_sh("--export-local", "--finish", "--cwd", str(self.repo))   # idempotent
        self.assertIn("exported 0 memories", r.stdout)
        self.assertFalse((target / "foo.cloud-3.md").exists())

    def test_export_skips_a_symlinked_index(self):
        self.install()
        self._stage([("project", "foo", "new foo")])
        target = self._target()
        target.mkdir(parents=True)
        outside = self.tmp / "index.md"
        outside.write_text("# mine\n")
        (target / "MEMORY.md").symlink_to(outside)
        r = self.setup_sh("--export-local", "--finish", "--cwd", str(self.repo))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("is a symlink", r.stdout)
        self.assertIn("- [foo](foo.md)", r.stdout)
        self.assertEqual(outside.read_text(), "# mine\n")
        self.assertTrue((target / "foo.md").exists())

    def test_install_warns_when_previous_auto_memory_is_unknown(self):
        self.install()
        (self.root / "state.json").unlink()
        r = self.install()
        self.assertIn("previous auto-memory setting is unknown", r.stdout)
        self.assertIsNone(self.state()["auto_memory_previous"])
        r = self.install()      # state exists now: no repeat warning
        self.assertNotIn("unknown", r.stdout)

    def test_messages(self):
        self.install()
        (self.root / "outbox" / "20261013T180400Z-a.md").write_text("x")
        r = self.setup_sh("--uninstall")
        self.assertEqual(r.returncode, 3)
        self.assertIn("Nothing was changed.", r.stdout)
        os.unlink(self.root / "outbox" / "20261013T180400Z-a.md")
        (self.root / "cache" / "_none.md").write_text("x")
        r = self.setup_sh("--uninstall")
        self.assertIn("--delete-cache", r.stdout)
        self.install()
        self.settings.write_text("{bad")
        r = self.install(ok=False)
        self.assertEqual(r.stderr.count("Nothing was changed."), 1)

    def test_dry_run_lists_export_dir_and_backups(self):
        self.settings.write_text('{\n  "theme": "dark"\n}\n')
        r = self.install("--dry-run")
        self.assertIn(str(self.root / "export"), r.stdout)
        self.assertIn("settings.json.bak-<time>", r.stdout)


if __name__ == "__main__":
    unittest.main()
