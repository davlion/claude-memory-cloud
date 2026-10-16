"""Level 3: the PostToolUse snapshot hook, run as Claude Code runs it (spec §7 G)."""
import os
import stat
import unittest

from helpers import clean_env, make_git_dir, run_hook, tempdir

INDEX = ("claude-memory response. Blocks headed [server:abc123abc123] come from the memory server.\n\n"
         "## Health [server:abc123abc123]\n✓ github_token — ok\n\n"
         "<memory-index scope=\"general\" repo=\"dav/claude-memory\">\n- [a](memories/a.md) — A\n"
         "</memory-index:abc123abc123>\n\n"
         "## Since [server:abc123abc123]\nPass this as since on later memory tool calls:\n"
         "```json\n{\"general\":\"0123\"}\n```")
TOOL = "mcp__claude_ai_claude-memory__memory_index"


class SnapshotHook(unittest.TestCase):
    def setUp(self):
        self.tmp = tempdir(self)
        self.home = self.tmp / "home"
        self.cache = self.home / ".claude-memory-cloud" / "cache"
        self.cache.mkdir(parents=True, mode=0o700)
        self.env = clean_env(self.home, GIT_CONFIG_GLOBAL="/dev/null", GIT_CONFIG_NOSYSTEM="1")
        self.repo = make_git_dir(self.tmp, "billing", "git@github.com:Acme-Org/Billing.git")
        self.plain = self.tmp / "plain"
        self.plain.mkdir()

    def fire(self, cwd, tool_input, response=None, tool=TOOL):
        payload = {"hook_event_name": "PostToolUse", "tool_name": tool, "tool_input": tool_input,
                   "tool_response": [{"type": "text", "text": INDEX}] if response is None else response,
                   "cwd": str(cwd), "session_id": "t"}
        ctx, _ = run_hook("post_tool_use.py", payload, self.env)
        self.assertEqual(ctx, "")   # silent: the snapshot never adds to Claude's context

    def snap(self, key):
        p = self.cache / f"{key}.md"
        return p.read_text() if p.exists() else None

    def test_writes_index_for_the_session_project(self):
        self.fire(self.repo, {"project": "acme-org/billing"})
        self.assertEqual(self.snap("acme-org__billing"), INDEX + "\n")
        self.assertEqual(stat.S_IMODE(os.stat(self.cache / "acme-org__billing.md").st_mode), 0o600)

    def test_project_given_as_remote_url(self):
        self.fire(self.repo, {"project": "https://github.com/Acme-Org/Billing.git"})
        self.assertEqual(self.snap("acme-org__billing"), INDEX + "\n")

    def test_outside_a_repo_writes_none_key(self):
        self.fire(self.plain, {})
        self.assertEqual(self.snap("_none"), INDEX + "\n")

    def test_string_response(self):
        self.fire(self.plain, {}, response=INDEX)
        self.assertEqual(self.snap("_none"), INDEX + "\n")

    def test_overwrites_previous_snapshot(self):
        (self.cache / "_none.md").write_text("old")
        self.fire(self.plain, {})
        self.assertEqual(self.snap("_none"), INDEX + "\n")

    def test_client_reindex_is_skipped(self):
        (self.cache / "acme-org__billing.md").write_text("old")
        self.fire(self.repo, {"project": "acme-org/billing", "scopes": ["acme"]})
        self.assertEqual(self.snap("acme-org__billing"), "old")

    def test_index_without_the_session_project_is_skipped(self):
        self.fire(self.repo, {})
        self.fire(self.repo, {"project": "other-org/thing"})
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_failed_index_is_skipped(self):
        (self.cache / "_none.md").write_text("old")
        no_since = INDEX.split("## Since")[0].strip()      # token failure: health only, no Since block
        self.fire(self.plain, {}, response=[{"type": "text", "text": no_since}])
        self.fire(self.plain, {}, response='{"error": "unavailable", "message": "x"}')
        self.fire(self.plain, {}, response={"weird": True})
        self.assertEqual(self.snap("_none"), "old")

    def test_other_tools_are_ignored(self):
        self.fire(self.plain, {}, tool="mcp__other__memory_read")
        self.assertEqual(list(self.cache.iterdir()), [])

    def test_garbage_stdin_exits_quietly(self):
        import subprocess
        from helpers import KIT, PY
        r = subprocess.run([PY, "-I", "-S", str(KIT / "hooks" / "post_tool_use.py")], input="not json",
                           capture_output=True, text=True, env=self.env, timeout=10)
        self.assertEqual((r.returncode, r.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()
