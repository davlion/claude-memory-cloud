import unittest

from helpers import FIXTURES, KIT
from memory_kit.claudemd import BEGIN, END, MarkerError, has_marker, remove_block, render_rule, upsert_block

BLOCK = f"{BEGIN}\nrule\n{END}"


class Block(unittest.TestCase):
    def test_insert_then_remove_restores_text(self):
        for text in ["", "# rules\n", "# rules", "a\n\n"]:
            with self.subTest(text=text):
                new, sep = upsert_block(text, BLOCK)
                self.assertTrue(has_marker(new))
                self.assertEqual(remove_block(new, sep), text)

    def test_rerun_replaces_in_place(self):
        new, _ = upsert_block("# rules\n", BLOCK)
        again, sep = upsert_block(new + "after\n", f"{BEGIN}\nrule v2\n{END}")
        self.assertIsNone(sep)
        self.assertEqual(again, f"# rules\n\n{BEGIN}\nrule v2\n{END}\nafter\n")

    def test_remove_without_block_is_noop(self):
        self.assertEqual(remove_block("# rules\n", "\n"), "# rules\n")

    def test_render_rule_fills_placeholders(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        out = render_rule(tpl, outbox_dir="/h/.claude-memory-cloud/outbox", cache_dir="/h/.claude-memory-cloud/cache",
                          memkit_cmd="/usr/bin/python3 -I -S /h/.claude-memory-cloud/kit/bin/memkit.py")
        self.assertTrue(out.startswith(BEGIN + "\n") and out.endswith("\n" + END))
        self.assertNotIn("{{", out)
        self.assertIn("/h/.claude-memory-cloud/cache/<key>.md", out)
        self.assertIn("memkit.py outbox-done <filename>", out)

    def test_template_example_matches_task5_fixture(self):
        fx = FIXTURES / "outbox" / "20261013T180400Z-prefer-small-commits.md"
        if not fx.exists():
            self.skipTest("Task 5 fixture not present yet")
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        example = tpl.split("```markdown\n")[1].split("\n```")[0]
        self.assertEqual(example.strip(), fx.read_text().strip())

    def test_flush_rule_conditions(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        flush = tpl[tpl.index("- **Flushing:**"):]
        self.assertIn("ONLY after a result of `created`, `updated` or `deleted`", flush)
        self.assertIn("`conflict` for a `memory_save`", flush)
        self.assertIn("`conflict` for a `memory_delete` (nothing was deleted)", flush)
        for word in ["conflict", "exists", "similar_found", "not_found", "rejected_secret", "repo_public", "write_rejected",
                     "invalid", "internal", "no_memory_repo_for_owner", "unknown_scope", "access_denied"]:
            self.assertIn(word, flush)

    def test_rule_agrees_with_worker(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        for s in ["[server:<code>]", "saved to <scope>", "queued in outbox for <scope>", "not saved: <reason>",
                  "unavailable", "reauth_required", "server_limit", "memory connector unavailable", "once at session start",
                  "`scope` is required", "`source`", "`since`"]:
            self.assertIn(s, tpl)

    def test_broken_markers_raise_and_leave_text_alone(self):
        cases = {"orphan begin": f"a\n{BEGIN}\nuser stuff\n",
                 "orphan end": f"a\n{END}\nuser stuff\n",
                 "end before begin": f"{END}\nx\n{BEGIN}\n",
                 "duplicate blocks": f"{BEGIN}\n1\n{END}\nmid\n{BEGIN}\n2\n{END}\n"}
        for name, text in cases.items():
            for fn in (lambda t: upsert_block(t, BLOCK), lambda t: remove_block(t, "\n")):
                with self.subTest(case=name):
                    with self.assertRaises(MarkerError) as cm:
                        fn(text)
                    self.assertIn("CLAUDE.md", str(cm.exception))

    def test_rule_uses_write_tool_for_snapshot_and_outbox(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        out = render_rule(tpl, outbox_dir="/h/.claude-memory-cloud/outbox", cache_dir="/h/.claude-memory-cloud/cache",
                          memkit_cmd="/usr/bin/python3 -I -S /h/.claude-memory-cloud/kit/bin/memkit.py")
        snap = next(l for l in out.splitlines() if l.startswith("- **Snapshot:**"))
        box = next(l for l in out.splitlines() if l.startswith("- **Outbox:**"))
        for line in (snap, box):
            self.assertIn("with the Write tool (never shell redirection, heredocs or `mkdir`", line)
        self.assertIn("date -u +%Y%m%dT%H%M%SZ", box)

    def test_rule_wording(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        self.assertIn("run `/mcp` to see if it's enabled in this session. Saves will be queued.", tpl)
        self.assertNotIn("unavailable — …", tpl)
        self.assertIn("keep `project` as at session start", tpl)
        self.assertIn("only after a `memory_index` call that included the session's project", tpl)
        flush = tpl[tpl.index("- **Flushing:**"):]
        self.assertIn("`not_reachable`", flush)
        self.assertIn("`unsupported_remote`", flush)


if __name__ == "__main__":
    unittest.main()
