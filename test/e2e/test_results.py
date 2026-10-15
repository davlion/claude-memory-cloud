"""Grid cells and rendering; cleanup touches only this run's files."""
import tempfile
import unittest
from pathlib import Path

from e2elib import checks as C
from e2elib import results
from e2elib.cleanup import cleanup
from e2elib.gh import Commit
from fakes import CFG, HOST, FakeShell


class Cells(unittest.TestCase):
    def test_cells(self):
        self.assertEqual(results.cell([C.PASS] * 3), "PASS 3/3")
        self.assertEqual(results.cell([C.PASS, C.FAIL, C.PASS]), "FAIL 2/3")
        self.assertEqual(results.cell([C.PASS]), "PASS")
        self.assertEqual(results.cell([C.SOFT_FAIL]), "soft ✗ 0/1")
        self.assertEqual(results.cell([C.SOFT_PASS]), "soft ✓")
        self.assertEqual(results.cell([C.PASS, C.ERROR]), "ERROR 1/2")
        self.assertEqual(results.cell([C.SKIPPED]), "skipped")

    def test_render_without_records(self):
        self.assertEqual(results.render("r1", [], []), "# Level 4 results — run r1\n\nNo results recorded.\n")

    def test_record_and_render(self):
        d = Path(tempfile.mkdtemp())
        results.record(d, "H1", "S2", C.Verdict(C.PASS), "A+C")
        results.record(d, "H1", "S2", C.Verdict(C.FAIL, ["saved to x"]), "A+C")
        results.record(d, "H3", "S1", C.Verdict(C.PASS), "A+C")
        results.record(d, "H1", "S16", C.Verdict(C.SOFT_PASS, ["8 save calls, 0 failed in transit"]), "A+C")
        md = results.render("r1", results.load(d), [("H1", "Mac CLI"), ("H3", "earsvm")])
        self.assertIn("| S1 | — | PASS |", md)
        self.assertIn("| S2 | FAIL 1/2 | — |", md)
        self.assertIn("| S16 | soft ✓ | — |", md)
        self.assertIn("- **S2 on H1:** saved to x", md)
        self.assertIn("- **S16 on H1:** 8 save calls", md)
        self.assertLess(md.index("| S1 |"), md.index("| S2 |"))


class CleanupOrWarn(unittest.TestCase):
    def test_a_failing_cleanup_warns_instead_of_raising(self):
        from e2elib.cleanup import cleanup_or_warn
        from e2elib.gh import GhError

        class Gh:
            def commits_since(self, repo, since):
                raise GhError(None, "error connecting to api.github.com")

        class Ctx:
            run_id, cfg, gh = "r1", CFG, Gh()
        said = []
        self.assertEqual(cleanup_or_warn(Ctx(), "2026-10-15T12:00:00Z", [HOST], out=said.append), [])
        self.assertEqual(said, ["  cleanup failed (error connecting to api.github.com); run `run.py cleanup` later"])


class Cleanup(unittest.TestCase):
    def test_deletes_only_this_runs_files_and_outbox_entries(self):
        class Gh:
            deleted = []

            def commits_since(self, repo, since):
                return [Commit("a", "", [("memories/mine.md", "added"), ("memories/other.md", "added"),
                                         ("MEMORY.md", "modified")])] if repo == CFG.general_repo else []

            def file_text(self, repo, path, ref="HEAD"):
                return {"memories/mine.md": "x e2e-r1-03", "memories/other.md": "real memory"}.get(path)

            def delete(self, repo, path, message):
                self.deleted.append(path)
                return True

        class Ctx:
            run_id, cfg, gh = "r1", CFG, Gh()
            sh = FakeShell({"grep -l": lambda s: "/h/.claude-memory-cloud/outbox/20261015T120000Z-e2e.md\n"})

            def outbox_files(self, host, token):
                return self.sh(host, f"grep -l {token}").split()
        c = Ctx()
        removed = cleanup(c, "2026-10-15T12:00:00Z", [HOST])
        self.assertEqual(c.gh.deleted, ["memories/mine.md"])
        self.assertEqual(removed, [f"{CFG.general_repo}/memories/mine.md", "H1:outbox/20261015T120000Z-e2e.md"])
        self.assertIn("memkit.py outbox-done 20261015T120000Z-e2e.md", c.sh.seen[-1])


if __name__ == "__main__":
    unittest.main()
