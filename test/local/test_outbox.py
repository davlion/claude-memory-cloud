import os
import re
import unittest
from datetime import datetime, timezone

from helpers import FIXTURES, KIT, tempdir
from memory_kit.outbox import (OutboxEntry, OutboxFormatError, entry_filename, format_entry, parse_entry,
                               scan_outbox)

NOW = datetime(2026, 10, 14, 12, 0, tzinfo=timezone.utc)


class EntryFormat(unittest.TestCase):
    def test_fixture_round_trip(self):
        for f in sorted((FIXTURES / "outbox").iterdir()):
            with self.subTest(f=f.name):
                text = f.read_text()
                e = parse_entry(text)
                self.assertEqual(format_entry(e), text)
                self.assertEqual(entry_filename(e), f.name)

    def test_rule_example_is_the_fixture(self):
        """The flush instructions (routing rule) and the parser share one format."""
        rule = (KIT / "templates" / "routing-rule.md").read_text()
        example = re.search(r"```markdown\n(.*?)```", rule, re.S).group(1)
        fixture = (FIXTURES / "outbox" / "20261013T180400Z-prefer-small-commits.md").read_text()
        self.assertEqual(example, fixture)
        self.assertEqual(parse_entry(example).project, "acme-org/billing")

    def test_quoting_and_comments(self):
        e = OutboxEntry(name="x", op="save", scope="general", queued_at="2026-10-13T18:04:00Z",
                        description="Measure first: then fix # not a comment", type="feedback", body="b\n")
        self.assertEqual(parse_entry(format_entry(e)), e)
        spec_style = ("---\nname: x\ndescription: d\nmetadata:\n  type: user\noutbox:\n"
                      "  op: save            # save | delete\n  scope: general\n"
                      "  queued_at: 2026-10-13T18:04:00Z\n---\n\nbody\n")
        self.assertEqual(parse_entry(spec_style).op, "save")

    def test_invalid(self):
        good = (FIXTURES / "outbox" / "20261013T180400Z-prefer-small-commits.md").read_text()
        for bad in ["no frontmatter", "---\nname: x\n", good.replace("op: save", "op: upsert"),
                    good.replace("2026-10-13T18:04:00Z", "yesterday"), good.replace("project: acme-org/billing\n", ""),
                    good.replace("name: prefer-small-commits", "name: Bad Name"),
                    good.replace("  type: feedback\n", "  type: opinion\n")]:
            with self.subTest(bad=bad[:30]), self.assertRaises(OutboxFormatError):
                parse_entry(bad)


class Scan(unittest.TestCase):
    def setUp(self):
        self.d = tempdir(self)
        for f in (FIXTURES / "outbox").iterdir():
            (self.d / f.name).write_text(f.read_text())

    def test_counts_total_and_project(self):
        s = scan_outbox(self.d, ("acme-org", "billing"), NOW)
        self.assertEqual((s.total, s.for_project, s.malformed), (2, 1, []))
        self.assertAlmostEqual(s.oldest_days, 0.75, places=2)
        self.assertEqual(scan_outbox(self.d, ("dav", "other"), NOW).for_project, 0)
        self.assertEqual(scan_outbox(self.d, None, NOW).for_project, 0)

    def test_malformed_counted_and_flagged(self):
        (self.d / "20261014T100000Z-broken.md").write_text("garbage")
        os.utime(self.d / "20261014T100000Z-broken.md", (NOW.timestamp() - 86400 * 9,) * 2)
        s = scan_outbox(self.d, None, NOW)
        self.assertEqual(s.total, 3)
        self.assertEqual(s.malformed, ["20261014T100000Z-broken.md"])
        self.assertGreater(s.oldest_days, 8.9)

    def test_missing_dir(self):
        self.assertEqual(scan_outbox(self.d / "none", None, NOW).total, 0)


if __name__ == "__main__":
    unittest.main()
