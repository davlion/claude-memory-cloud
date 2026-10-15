"""The committed e2e.json and prompts.json load and fit the scenarios."""
import string
import unittest

from e2elib import config

FIELDS = {"S2": {"token"}, "S3": {"token"}, "S4": {"token"}, "S4n": {"token"}, "S5": {"token"}, "S8": {"token", "secret"},
          "S16": {"facts"}, "named_save": {"name", "body"}, "named_read": {"name"}, "named_update": {"name", "body"},
          "named_read_update": {"name", "body"}, "named_search": {"name"}, "reconcile_yes": set(), "U1": {"token"},
          "S17_move": {"name", "target"}}


class Files(unittest.TestCase):
    def setUp(self):
        self.cfg = config.load()

    def test_hosts_have_the_dirs_scenarios_use(self):
        self.assertEqual(sorted(self.cfg.hosts), ["H1", "H3", "H4"])
        for h in self.cfg.hosts.values():
            self.assertEqual(sorted(h.dirs), ["kit_repo", "no_remote", "sample_app"])
            self.assertTrue(all(p.startswith("mcp__") and p.endswith("__") for p in h.mcp_prefixes))
        self.assertIsNone(self.cfg.hosts["H1"].ssh)

    def test_every_prompt_uses_exactly_its_fields(self):
        for key, fields in FIELDS.items():
            for p in self.cfg.prompts[key]:
                with self.subTest(key=key, p=p[:30]):
                    used = {f for _, f, _, _ in string.Formatter().parse(p) if f}
                    self.assertEqual(used, fields)

    def test_routing_prompts_have_three_or_more_runs_worth(self):
        self.assertEqual(self.cfg.repeats, 3)
        for key in ("S2", "S4", "S5"):   # scenarios.REPEATED (Task 5)
            self.assertGreaterEqual(len(self.cfg.prompts[key]), 3)
        self.assertEqual(len(self.cfg.prompts["S16_facts"]), 8)

    def test_some_routing_prompts_avoid_the_hook_triggers(self):
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "kit"))
        from memory_kit.prompt import is_memory_intent
        for key in ("S2", "S4"):
            hits = [is_memory_intent(p) for p in self.cfg.prompts[key]]
            self.assertTrue(any(hits) and not all(hits), (key, hits))


if __name__ == "__main__":
    unittest.main()
