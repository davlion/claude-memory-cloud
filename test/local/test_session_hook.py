"""Level 3: the SessionStart hook — outbox (E), preflight (F), snapshot (G), compaction (H)."""
import json
import os
import shutil
import subprocess
import unittest

from helpers import (FIXTURES, KIT, PY, FakeWorker, clean_env, git_env, healthy_home, make_git_dir, run_hook,
                     tempdir)
from memory_kit.session import COMPACT_LINE


PROJECT_LINE = "Memory project for this session: acme-org/billing"
NONE_LINE = "Memory project for this session: none (no GitHub origin; omit project)"


class SessionHook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir(self)
        self.worker = FakeWorker("ok")
        self.addCleanup(self.worker.close)
        self.home = healthy_home(self.tmp, self.worker.url)
        self.root = self.home / ".claude-memory-cloud"
        self.env = clean_env(self.home)
        self.repo = make_git_dir(self.tmp, "billing", "git@github.com:acme-org/billing.git")

    def run_ss(self, source="startup", cwd=None):
        return run_hook("session_start.py", {"hook_event_name": "SessionStart", "source": source,
                                             "cwd": str(cwd or self.repo), "session_id": "t"}, self.env)

    def test_insteadof_origin_resolves_to_github_project(self):
        d = make_git_dir(self.tmp, "alias", "gh:Acme/Billing")
        subprocess.run(["git", "-C", str(d), "config", "url.git@github.com:.insteadOf", "gh:"], check=True,
                       env=git_env(self.tmp))
        self.assertEqual(self.run_ss(cwd=d)[0], "Memory project for this session: acme/billing")

    def test_git_failure_says_unknown_and_no_origin_says_none(self):
        d = make_git_dir(self.tmp, "noorigin", None)
        nogit = self.tmp / "emptybin"
        nogit.mkdir()
        self.env["PATH"] = str(nogit)   # git cannot run: origin can't be determined
        self.assertEqual(self.run_ss(cwd=d)[0],
                         "Memory project for this session: unknown (run `git remote get-url origin`)")
        self.env["PATH"] = os.environ.get("PATH", "/usr/bin:/bin")   # git works, no origin: genuinely none
        self.assertEqual(self.run_ss(cwd=d)[0], NONE_LINE)

    def test_routing_rule_tells_claude_to_run_git_when_unknown(self):
        rule = (KIT / "templates" / "routing-rule.md").read_text()
        self.assertIn("says unknown, or the hook gave no such line at all, run `git remote get-url origin`", rule)

    def queue_fixtures(self):
        for f in (FIXTURES / "outbox").iterdir():
            (self.root / "outbox" / f.name).write_text(f.read_text())

    def problem_lines(self, out):
        return [ln for ln in out.splitlines() if ln.startswith("- ")]

    # healthy / outbox ------------------------------------------------------------------------------
    def test_all_healthy_is_silent(self):
        self.assertEqual(self.run_ss()[0], PROJECT_LINE)

    def test_missing_outbox_dir_is_silent_and_recreated(self):
        shutil.rmtree(self.root / "outbox")
        self.assertEqual(self.run_ss()[0], PROJECT_LINE)
        self.assertEqual(os.stat(self.root / "outbox").st_mode & 0o777, 0o700)

    def test_outbox_counts_total_and_project(self):
        self.queue_fixtures()
        out = self.run_ss()[0]
        self.assertIn("2 memories queued in outbox (1 for this project). Once memory_index succeeds, flush them "
                      "with memory_save/memory_delete, oldest first, and delete each entry only after a successful result.", out)

    def test_outbox_non_git_total_only(self):
        self.queue_fixtures()
        out = self.run_ss(cwd=self.tmp)[0]
        self.assertIn("2 memories queued in outbox. Once", out)
        self.assertNotIn("for this project", out)

    def test_malformed_entry_counted_and_flagged(self):
        self.queue_fixtures()
        (self.root / "outbox" / "20261014T100000Z-broken.md").write_text("garbage")
        out = self.run_ss()[0]
        self.assertIn("3 memories queued in outbox", out)
        self.assertIn("1 outbox entries can't be read and won't be flushed: 20261014T100000Z-broken.md", out)

    # compaction ---------------------------------------------------------------------------------------
    def test_compact_equals_startup_plus_reindex_line(self):
        self.queue_fixtures()
        startup, compact = self.run_ss("startup")[0], self.run_ss("compact")[0]
        self.assertNotIn(COMPACT_LINE, startup)
        self.assertEqual(compact, COMPACT_LINE + "\n\n" + startup)
        self.assertEqual(self.run_ss("compact")[0].count("Call memory_index again"), 1)

    # preflight, one thing broken at a time -----------------------------------------------------------
    def assert_one_problem(self, expected):
        lines = self.problem_lines(self.run_ss()[0])
        self.assertEqual(len(lines), 1, lines)
        self.assertIn(expected, lines[0])

    def test_worker_unreachable(self):
        (self.root / "config.json").write_text(json.dumps({"worker_url": "http://127.0.0.1:9"}))
        self.assert_one_problem("Can't reach the memory server http://127.0.0.1:9. Check this machine's network/DNS "
                                "(`curl -sS http://127.0.0.1:9/health`). Saves will be queued in the outbox.")

    def test_git_runs_before_the_health_probe_starts(self):
        # On macOS a fork() after a failed DNS lookup can segfault the child, so `git` must not start after the probe.
        from datetime import datetime, timezone
        from unittest import mock
        from memory_kit import session
        from memory_kit.health import HealthResult
        from memory_kit.paths import kit_paths
        order = []

        class Probe:
            def __init__(self, *a):
                order.append("probe")

            def result(self):
                return HealthResult("ok")

        real = session.resolve_origin
        with mock.patch.object(session, "HealthProbe", Probe), \
                mock.patch.object(session, "resolve_origin", lambda cwd: (order.append("git"), real(cwd))[1]):
            r = session.session_report(cwd=str(self.repo), paths=kit_paths(self.home), env=self.env,
                                       now=datetime.now(timezone.utc))
        self.assertEqual(order, ["git", "probe"])
        self.assertEqual(r.project, ("acme-org", "billing"))

    def test_daily_limit(self):
        self.worker.mode = "429"
        self.assert_one_problem("The memory server hit its daily request limit; resets 00:00 UTC; saves are queued in the outbox.")

    def test_auto_memory_on(self):
        (self.home / ".claude" / "settings.json").write_text('{"autoMemoryEnabled": true}')
        self.assert_one_problem('Add `"autoMemoryEnabled": false` to `~/.claude/settings.json`')

    def test_auto_memory_env_var_counts_as_off(self):
        (self.home / ".claude" / "settings.json").write_text("{}")
        self.env["CLAUDE_CODE_DISABLE_AUTO_MEMORY"] = "1"
        self.assertEqual(self.run_ss()[0], PROJECT_LINE)

    def test_project_setting_overrides_user(self):
        (self.repo / ".claude").mkdir()
        (self.repo / ".claude" / "settings.json").write_text('{"autoMemoryEnabled": true}')
        self.assert_one_problem("Built-in auto-memory is on")

    def test_managed_setting_overrides_user(self):
        managed = self.tmp / "managed-settings.json"
        managed.write_text('{"autoMemoryEnabled": true}')
        self.env["MEMKIT_MANAGED_SETTINGS"] = str(managed)   # user settings say false; managed wins
        self.assert_one_problem("Built-in auto-memory is on")

    def raw(self, stdin):
        return subprocess.run([PY, "-I", "-S", str(KIT / "hooks" / "session_start.py")], input=stdin,
                              capture_output=True, text=True, env=self.env, timeout=10)

    def test_bad_stdin_is_treated_as_empty(self):
        for stdin in ("", "not json", "[]", "null", '"x"', "{}", '{"source": 5, "cwd": null}', '{"cwd": "a\\u0000b"}'):
            with self.subTest(stdin=stdin):
                r = self.raw(stdin)
                self.assertEqual((r.returncode, r.stderr), (0, ""))   # healthy: no "hook failed"
                self.assertIn("Memory project for this session:", json.loads(r.stdout)["hookSpecificOutput"]["additionalContext"])
                self.assertNotIn("preflight", r.stdout)

    def test_routing_marker_missing(self):
        (self.home / ".claude" / "CLAUDE.md").write_text("# nothing\n")
        self.assert_one_problem("The memory routing rule is missing from `~/.claude/CLAUDE.md`; rerun the "
                                "claude-memory-cloud setup script.")

    def test_scope_map_missing_or_invalid(self):
        (self.root / "scopes.json").write_text("{bad")
        self.assert_one_problem("Scope map missing or invalid; rerun the setup script")
        (self.root / "scopes.json").unlink()
        self.assert_one_problem("Scope map missing or invalid; rerun the setup script")

    def test_stale_outbox_entry(self):
        self.queue_fixtures()
        old = self.root / "outbox" / "20261013T180400Z-prefer-small-commits.md"
        old.write_text(old.read_text().replace("2026-10-13T18:04:00Z", "2020-01-01T00:00:00Z"))
        old.rename(self.root / "outbox" / "20200101T000000Z-prefer-small-commits.md")
        self.assertIn("Oldest queued memory is", "\n".join(self.problem_lines(self.run_ss()[0])))

    def test_hook_older_than_min_hook_version(self):
        self.worker.mode = "old"
        self.assert_one_problem("Memory hooks are out of date (installed 0.1.2, server needs 9.0.0); rerun the setup script.")

    def test_open_dir_reported_files_healed(self):
        f = self.root / "cache" / "_none.md"
        f.write_text("x")
        os.chmod(f, 0o644)
        out = self.run_ss(cwd=self.tmp)[0]
        self.assertEqual(self.problem_lines(out), [])          # 0644 file in a 0700 dir: fixed silently
        self.assertEqual(os.stat(f).st_mode & 0o777, 0o600)
        os.chmod(self.root / "outbox", 0o755)
        self.assert_one_problem("Memory files on this machine are readable by other users. Run `chmod 700")

    def test_runtime_under_1_5_s_with_worker_blackholed(self):
        hole = FakeWorker("blackhole")
        self.addCleanup(hole.close)
        (self.root / "config.json").write_text(json.dumps({"worker_url": hole.url}))
        out, secs = self.run_ss()
        self.assertIn("Can't reach the memory server", out)
        self.assertLess(secs, 1.5)

    # snapshot ---------------------------------------------------------------------------------------
    def test_no_snapshot_no_output(self):
        (self.root / "cache" / "dav__other.md").write_text("other repo")
        self.assertEqual(self.run_ss()[0], PROJECT_LINE)

    def test_snapshot_for_current_key(self):
        p = self.root / "cache" / "acme-org__billing.md"
        p.write_text("[server:aaaaaaaaaaaa]\n<memory-index scope=\"project\">\n- deploy-friday\n")
        os.utime(p, (1_791_972_000, 1_791_972_000))
        out = self.run_ss()[0]
        self.assertTrue(out.startswith(PROJECT_LINE + "\n\nMemory snapshot from 2026-10-14T10:00:00Z (stale; read-only)."))
        self.assertIn("- deploy-friday", out)

    def test_snapshot_non_git_uses_none_key(self):
        (self.root / "cache" / "_none.md").write_text("- general-only\n")
        self.assertIn("- general-only", self.run_ss(cwd=self.tmp)[0])

    def test_large_snapshot_truncated_and_total_under_cap(self):
        self.queue_fixtures()
        (self.root / "cache" / "acme-org__billing.md").write_text("- line of index text here\n" * 1000)
        out = self.run_ss("compact")[0]
        self.assertIn("[snapshot truncated at 8 KB", out)
        self.assertLess(len(out), 10000)

    def test_project_line_normalized_for_github_origin(self):
        for origin in ("https://github.com/Acme-Org/Billing.git", "git@github.com:Acme-Org/Billing"):
            with self.subTest(origin=origin):
                repo = make_git_dir(self.tmp, "r" + str(abs(hash(origin))), origin)
                self.assertEqual(self.run_ss(cwd=repo)[0], PROJECT_LINE)

    def test_project_line_none_without_github_origin(self):
        self.assertEqual(self.run_ss(cwd=self.tmp)[0], NONE_LINE)
        other = make_git_dir(self.tmp, "gl", "git@gitlab.com:acme/billing.git")
        self.assertEqual(self.run_ss(cwd=other)[0], NONE_LINE)
        norem = make_git_dir(self.tmp, "norem", None)
        self.assertEqual(self.run_ss(cwd=norem)[0], NONE_LINE)

    def test_project_line_counts_against_the_budget(self):
        self.queue_fixtures()
        (self.root / "cache" / "acme-org__billing.md").write_text("- line of index text here\n" * 1000)
        out = self.run_ss("compact")[0]
        self.assertIn(PROJECT_LINE, out)
        self.assertLessEqual(len(out), 9500)

    def test_cloud_session_is_silent(self):
        (self.home / ".claude" / "CLAUDE.md").unlink()
        self.env["CLAUDE_CODE_REMOTE"] = "true"
        self.assertEqual(self.run_ss()[0], "")


if __name__ == "__main__":
    unittest.main()
