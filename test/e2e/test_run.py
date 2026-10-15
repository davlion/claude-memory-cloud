"""run.py helpers that don't touch the network."""
import unittest

import run
from e2elib import checks as C


class Guarded(unittest.TestCase):
    def test_a_crashing_scenario_becomes_an_error_row_under_its_own_id(self):
        def boom(*args):
            raise RuntimeError("GitHub unreachable")
        v = run.guarded("S2", boom, None)
        self.assertEqual(list(v), ["S2"])
        self.assertEqual(v["S2"].status, C.ERROR)
        self.assertIn("RuntimeError: GitHub unreachable", v["S2"].notes[0])

    def test_a_normal_scenario_passes_through(self):
        v = {"S1": C.Verdict(C.PASS)}
        self.assertIs(run.guarded("S1", lambda *a: v, None), v)


if __name__ == "__main__":
    unittest.main()
