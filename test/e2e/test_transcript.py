"""The stream-json parser, against a recorded-shape fixture."""
import unittest
from pathlib import Path

from e2elib.transcript import parse

FIX = Path(__file__).resolve().parent / "fixtures"


class Parse(unittest.TestCase):
    def setUp(self):
        self.t = parse((FIX / "save-general.jsonl").read_text().splitlines())

    def test_session_tools_and_bad_lines(self):
        self.assertEqual(self.t.session_id, "s-1")
        self.assertIn("mcp__claude_ai_claude-memory-staging__memory_save", self.t.tools)
        self.assertEqual(self.t.bad_lines, 1)

    def test_kit_context_is_the_additional_context_of_the_kit_hook(self):
        ctx = self.t.kit_context()
        self.assertTrue(ctx.startswith("Memory project for this session: davlion-test-client/sample-app"))
        self.assertNotIn("Session status updated", ctx)

    def test_memory_calls_results_and_status(self):
        idx = self.t.memory_calls("memory_index")[0]
        self.assertEqual(idx.input, {"project": "davlion-test-client/sample-app"})
        self.assertIn("old-one", idx.result)
        saves = self.t.memory_calls("memory_save")
        self.assertEqual([s.status for s in saves], ["created", None])
        self.assertTrue(saves[1].is_error)
        self.assertEqual(saves[0].short, "memory_save")

    def test_denials_and_final(self):
        self.assertEqual(self.t.denials, ["mcp__claude_ai_claude-memory-staging__memory_delete"])
        self.assertEqual(self.t.final_text, "Done. saved to general")
        self.assertTrue(self.t.succeeded)

    def test_empty_and_truncated_input(self):
        t = parse(["", '{"type": "assistant", "message": {"content": [{"type": "text", "text": "hi"}]}}', '{"type": "res'])
        self.assertEqual(t.final_text, "hi")
        self.assertFalse(t.succeeded)
        self.assertEqual(t.bad_lines, 1)


if __name__ == "__main__":
    unittest.main()
