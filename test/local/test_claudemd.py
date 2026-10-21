import hashlib
import re
import unittest

from helpers import FIXTURES, KIT, REPO
from memory_kit import HOOK_VERSION
from memory_kit.claudemd import BEGIN, END, MarkerError, block_sha, has_marker, remove_block, render_rule, upsert_block

# The routing rule's hash for each kit version that changed it. A template change fails test_rule_change_bumps_versions
# until HOOK_VERSION goes up and the new hash is added here; the server's MIN_HOOK_VERSION must then reach that version,
# so every machine still on the old rule is told to rerun the setup script.
RULE_PINS = {"0.1.4": "f32432794444973e3d4bf2aff7e64a4dfd65fd68847dab3e5137938beff9a93e",
             "0.1.5": "5eed7d6f61f35f044f42b4092f61d981fc95eda47d1eabe7bd06b92dc45586ff"}


def _version(v):
    return tuple(int(x) for x in v.split("."))

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
        out = render_rule(tpl, outbox_dir="/h/.claude-memory-cloud/outbox",
                          memkit_cmd="/usr/bin/python3 -I -S /h/.claude-memory-cloud/kit/bin/memkit.py",
                          source="claude-code on <hostname>")
        self.assertTrue(out.startswith(BEGIN + "\n") and out.endswith("\n" + END))
        self.assertNotIn("{{", out)
        self.assertNotIn("/cache", out)     # the PostToolUse hook writes the snapshot; Claude never does
        self.assertIn("memkit.py outbox-done <filename>", out)

    def test_block_sha_hashes_only_the_block(self):
        a = block_sha(f"# mine\n{BLOCK}\n")
        self.assertEqual(a, block_sha(f"# other text\n\n{BLOCK}\nmore\n"))
        self.assertNotEqual(a, block_sha(f"{BEGIN}\nrule, edited\n{END}\n"))
        self.assertEqual(a, hashlib.sha256(BLOCK.encode()).hexdigest())

    def test_block_sha_none_without_a_well_formed_block(self):
        self.assertIsNone(block_sha("# nothing\n"))
        self.assertIsNone(block_sha(f"{BEGIN}\n{BEGIN}\n{END}\n"))

    def test_rule_change_bumps_versions(self):
        sha = hashlib.sha256((KIT / "templates" / "routing-rule.md").read_bytes()).hexdigest()
        latest = max(RULE_PINS, key=_version)
        self.assertEqual(sha, RULE_PINS[latest],
                         "routing-rule.md changed: bump HOOK_VERSION in kit/memory_kit/__init__.py, add the new hash to "
                         "RULE_PINS, and raise MIN_HOOK_VERSION in wrangler.jsonc to that version")
        self.assertGreaterEqual(_version(HOOK_VERSION), _version(latest))

    def test_server_requires_the_kit_that_carries_this_rule(self):
        latest = max(RULE_PINS, key=_version)
        mins = re.findall(r'"MIN_HOOK_VERSION":\s*"([0-9.]+)"', (REPO / "wrangler.jsonc").read_text())
        self.assertEqual(len(mins), 2)      # staging and production
        for m in mins:
            self.assertGreaterEqual(_version(m), _version(latest),
                                    "raise MIN_HOOK_VERSION in wrangler.jsonc so machines on the old rule are told to rerun setup")

    def test_rule_keeps_examples_when_generalizing(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        saving = tpl.split("- **Saving:**")[1].split("\n- **")[0]
        self.assertIn("keep its concrete example and name the repo", saving)
        self.assertIn("client's repo", saving)
        self.assertIn("general` loads in every session", saving)

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
                  "`scope` is required", "`source`", "`since`",
                  "getaddrinfo ENOTFOUND", "`! sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`"]:
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

    def test_rule_uses_write_tool_for_outbox_only(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        out = render_rule(tpl, outbox_dir="/h/.claude-memory-cloud/outbox",
                          memkit_cmd="/usr/bin/python3 -I -S /h/.claude-memory-cloud/kit/bin/memkit.py",
                          source="claude-code on <hostname>")
        snap = next(l for l in out.splitlines() if l.startswith("- **Snapshot:**"))
        box = next(l for l in out.splitlines() if l.startswith("- **Outbox:**"))
        self.assertIn("with the Write tool (never shell redirection, heredocs or `mkdir`", box)
        self.assertNotIn("Write", snap)
        self.assertIn("if `memory_index` fails, use the session-start snapshot", snap)
        self.assertIn("never write memories to local files except the outbox below.", out)
        self.assertIn("date -u +%Y%m%dT%H%M%SZ", box)

    def test_rule_wording(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        self.assertIn("run `/mcp` to see if it's enabled in this session. Saves will be queued.", tpl)
        self.assertNotIn("unavailable — …", tpl)
        self.assertIn("keep `project` as at session start", tpl)
        flush = tpl[tpl.index("- **Flushing:**"):]
        self.assertIn("`not_reachable`", flush)
        self.assertIn("`unsupported_remote`", flush)

    def test_rule_personal_tiers_and_flush_keep_list(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        out = render_rule(tpl, outbox_dir="/h/o", memkit_cmd="m", source="claude-code on <hostname>")
        self.assertIn("not saved: personal — keep it in claude.ai memory", out)
        self.assertIn("confirmed: true", out)
        self.assertIn("never in a client scope", out)
        flush = out[out.index("- **Flushing:**"):]
        for word in ["rejected_personal", "needs_confirmation", "rejected_cross_client"]:
            self.assertIn(f"`{word}`", flush)
        self.assertIn("plus `confirmed: true` when the entry has it", flush)
        box = next(l for l in out.splitlines() if l.startswith("- **Outbox:**"))
        self.assertIn("add `confirmed: true` under `outbox:`", box)

    def test_render_rule_source(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        out = render_rule(tpl, outbox_dir="/h/o", memkit_cmd="m", source="claude-code")
        self.assertIn('`source` ("claude-code")', out)
        self.assertIn('`source` = "claude-code (outbox)"', out)
        self.assertNotIn("{{", out)


if __name__ == "__main__":
    unittest.main()


class EncryptionRule(unittest.TestCase):
    def test_rule_has_key_required(self):
        tpl = (KIT / "templates" / "routing-rule.md").read_text()
        self.assertIn("(`unavailable`, `reauth_required`, `server_limit`, `key_required`)", tpl)
        self.assertIn("On `key_required`, keep that entry and continue with the next one (its repo's key isn't registered yet); "
                      "on any other retryable error, keep the entry and stop flushing.", tpl)
