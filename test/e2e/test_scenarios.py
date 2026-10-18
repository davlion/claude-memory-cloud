"""Scenario logic against scripted transcripts and a fake repo set (no network, no claude)."""
import tempfile
import unittest
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from e2elib import checks as C
from e2elib import scenarios as S
from e2elib.launch import Invocation
from fakes import CFG, HOST, FakeClaude, FakeGh, FakeShell, saved, stream


def ctx(claude, gh=None, sh=None, env=None):
    tmp = Path(tempfile.mkdtemp())
    return S.Ctx(CFG, gh or FakeGh(), "r1", tmp, claude=claude, sh=sh or FakeShell(), env=env,
                 now=lambda: datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc))


class Routing(unittest.TestCase):
    def run_s2(self, repo, path, scope, text="saved to general", sh=None):
        gh = FakeGh()

        def answer(inv):
            gh.add(repo, path, f"body {inv.prompt.split('Tag: ')[1]}", scope)
            return stream(calls=[("memory_save", {"scope": "general"}, saved(), False)], text=text)
        claude = FakeClaude(answer)
        return S.s2(ctx(claude, gh, sh), HOST, 0), claude

    def test_s2_pass_and_s0_pass(self):
        v, claude = self.run_s2("me/claude-memory-test", "memories/x.md", "general")
        self.assertEqual((v["S2"].status, v["S0"].status), (C.PASS, C.PASS), v)
        self.assertEqual(claude.invocations[0].allow, ("memory_save",))
        self.assertIn("e2e-r1-01", claude.invocations[0].prompt)

    def test_s2_wrong_scope_fails_with_reasons(self):
        v, _ = self.run_s2("client/claude-memory", "memories/x.md", "client")
        self.assertEqual(v["S2"].status, C.FAIL)
        self.assertTrue(any("expected me/claude-memory-test" in n for n in v["S2"].notes))

    def test_s2_missing_announcement_fails(self):
        v, _ = self.run_s2("me/claude-memory-test", "memories/x.md", "general", text="Done!")
        self.assertIn("reply lacks the announcement 'saved to general'", v["S2"].notes)

    def test_auto_memory_write_fails_s0(self):
        sh = FakeShell({"find ~/.claude/projects": lambda s: "/Users/x/.claude/projects/-s/memory/a.md\n"})
        v, _ = self.run_s2("me/claude-memory-test", "memories/x.md", "general", sh=sh)
        self.assertEqual(v["S0"].status, C.FAIL)
        self.assertEqual(v["S2"].status, C.FAIL)

    def test_s4_project_path_and_trailer(self):
        gh = FakeGh()

        def answer(inv):
            gh.add("client/claude-memory", "projects/sample-app/memories/x.md", inv.prompt, "project:client/sample-app")
            return stream(text="saved to project sample-app")
        v = S.s4(ctx(FakeClaude(answer), gh), HOST, 0)
        self.assertEqual(v["S4"].status, C.PASS, v)

    def test_s5_saving_without_asking_fails(self):
        v = S.s5(ctx(FakeClaude(stream(calls=[("memory_save", {"scope": "general"}, saved(), False)], text="Saved."))), HOST)
        self.assertEqual(v["S5"].status, C.FAIL)
        self.assertEqual(len(v["S5"].notes), 2)

    def test_s5_question_passes(self):
        v = S.s5(ctx(FakeClaude(stream(text="general, client, or this project?"))), HOST)
        self.assertEqual(v["S5"].status, C.PASS)

    def test_s8_secret_is_fake_and_must_be_refused(self):
        claude = FakeClaude(stream(calls=[("memory_save", {}, saved("rejected_secret"), False)], text="not saved: secret"))
        v = S.s8(ctx(claude), HOST)
        self.assertEqual(v["S8"].status, C.PASS, v)
        self.assertRegex(claude.invocations[0].prompt, r"AKIA[A-Z0-9]{16}")

    def test_s1_wrong_project_and_denied_prompt(self):
        out = stream(calls=[("memory_index", {"project": "other/x"}, "index", False)])
        out = out.replace('{"type": "result"', '{"type": "system", "subtype": "permission_denied", "tool_name": '
                          '"mcp__x__memory_index"}\n{"type": "result"')
        v = S.s1_s12h(ctx(FakeClaude(out)), HOST)
        self.assertEqual(v["S1"].status, C.FAIL)
        self.assertEqual(len(v["S1"].notes), 2)
        self.assertEqual(v["S12h"].status, C.PASS)

    def test_s12h_fails_when_preflight_reports(self):
        kit = ("Memory project for this session: client/sample-app\n\nclaude-memory preflight found problems. Tell the "
               "user one line per problem, starting with \"⚠ memory:\" and including its action:\n- Scope map missing")
        v = S.s1_s12h(ctx(FakeClaude(stream(kit=kit, calls=[("memory_index", {"project": "client/sample-app"}, "i", False)]))), HOST)
        self.assertEqual(v["S12h"].status, C.FAIL)
        self.assertEqual(C.problems(FakeClaude(stream(kit=kit))(HOST, None).transcript), ["Scope map missing"])


class Outbox(unittest.TestCase):
    def test_s11_chain_all_pass(self):
        gh, state = FakeGh(), {"queued": []}
        now = int(datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc).timestamp())

        def queue(inv):
            state["queued"].append("/o/" + inv.prompt.split("Tag: ")[1] + ".md")
            return stream(text="queued in outbox for general")

        def flush(inv):
            tok = state["queued"][0][3:-3]
            gh.add("me/claude-memory-test", "memories/q.md", tok, "general")
            state["queued"].clear()
            return stream(kit="Memory project for this session: me/claude-memory-cloud\n\n1 memory queued in outbox.",
                          text="saved to general")
        claude = FakeClaude(stream(kit="Memory project for this session: me/claude-memory-cloud",
                                   calls=[("memory_index", {"project": "me/claude-memory-cloud"}, "i", False)]),
                            queue,
                            stream(kit="Memory project for this session: me/claude-memory-cloud\n\n<memory-snapshot key=\"k\">x"),
                            flush)
        sh = FakeShell({"getmtime": lambda s: f"{now + 3}\n", "outbox": lambda s: " ".join(state["queued"])})
        v = S.s11_chain(ctx(claude, gh, sh), HOST)
        self.assertEqual({k: x.status for k, x in v.items()},
                         {"S11f": C.PASS, "S11": C.PASS, "S11e": C.PASS, "S11b": C.PASS}, v)
        self.assertTrue(claude.invocations[1].no_connector and claude.invocations[2].no_connector)
        self.assertFalse(claude.invocations[3].no_connector)

    def test_stale_snapshot_fails_s11f(self):
        sh = FakeShell({"getmtime": lambda s: "1000\n"})
        claude = FakeClaude(stream(calls=[("memory_index", {"project": "me/claude-memory-cloud"}, "i", False)]),
                            stream(), stream(), stream())
        v = S.s11_chain(ctx(claude, sh=sh), HOST)
        self.assertEqual(v["S11f"].status, C.FAIL)


class Soft(unittest.TestCase):
    def test_s16_never_hard_fails(self):
        gh = FakeGh()

        def answer(inv):
            marks = [line.split(":")[0][2:] for line in inv.prompt.splitlines() if line.startswith("- ")]
            for m in marks[:-1]:
                gh.add("me/claude-memory-test", f"memories/{m}.md", m, "general")
            gh.add("me/claude-memory-test", f"memories/{marks[0]}.conflict-20261015T120000Z.md", marks[0], "general")
            return stream(calls=[("memory_save", {}, "ECONNRESET", True)])
        v = S.s16(ctx(FakeClaude(answer), gh), HOST)["S16"]
        self.assertEqual(v.status, C.SOFT_FAIL)
        self.assertTrue(any("stored 0 times" in n for n in v.notes))
        self.assertTrue(any("conflict copies" in n for n in v.notes))
        self.assertIn("1 save calls, 1 failed in transit", v.notes)


class Move(unittest.TestCase):
    """S17: a memory saved in the wrong scope can be moved on request: one live copy in the new scope, none left
    in the old one, and the move is announced."""

    def run_s17(self, delete_old=True, text="saved to project"):
        gh, state = FakeGh(), {}

        def save_general(inv):
            name = inv.prompt.split("named ")[1].split(" ")[0]
            state["name"] = name
            gh.add("me/claude-memory-test", f"memories/{name}.md", f"original {name}", "general")
            return stream(calls=[("memory_save", {"scope": "general", "name": name}, saved(), False)], text="saved to general")

        def move(inv):
            name = state["name"]
            gh.add("client/claude-memory", f"projects/sample-app/memories/{name}.md", f"original {name}",
                   "project:client/sample-app")
            calls = [("memory_save", {"scope": "project"}, saved(), False)]
            if delete_old:
                gh.gone.add(("me/claude-memory-test", f"memories/{name}.md"))
                calls.append(("memory_delete", {"scope": "general"}, saved("deleted"), False))
            return stream(calls=calls, text=text)
        claude = FakeClaude(save_general, move)
        v = S.s17(ctx(claude, gh), HOST)["S17"]
        return v, claude

    def test_move_passes(self):
        v, claude = self.run_s17()
        self.assertEqual(v.status, C.PASS, v)
        self.assertEqual(claude.invocations[1].resume, claude.invocations[0].session_id)
        self.assertEqual(claude.invocations[1].allow, ("memory_save", "memory_delete"))
        self.assertIn("project", claude.invocations[1].prompt)

    def test_copy_left_behind_fails(self):
        v, _ = self.run_s17(delete_old=False)
        self.assertEqual(v.status, C.FAIL)
        self.assertTrue(any("still in me/claude-memory-test" in n for n in v.notes), v.notes)

    def test_missing_announcement_fails(self):
        v, _ = self.run_s17(text="Moved it.")
        self.assertIn("reply lacks the announcement 'saved to project'", v.notes)


class PersonalGuard(unittest.TestCase):
    """S18-S20: the server refuses personal facts, asks before candid opinions, refuses cross-client facts."""

    def test_s18_passes_when_nothing_committed_and_not_saved_announced(self):
        claude = FakeClaude(stream(calls=[("memory_save", {"scope": "general"}, saved("rejected_personal"), True)],
                                   text="not saved: personal"))
        v = S.s18(ctx(claude), HOST)["S18"]
        self.assertEqual(v.status, C.PASS, v)
        self.assertIn("e2e-r1-01", claude.invocations[0].prompt)
        self.assertEqual(claude.invocations[0].cwd, "sample_app")

    def test_s18_fails_on_commit_or_missing_announcement(self):
        gh = FakeGh()

        def answer(inv):
            gh.add("me/claude-memory-test", "memories/x.md", inv.prompt, "general")
            return stream(text="Done.")
        v = S.s18(ctx(FakeClaude(answer), gh), HOST)["S18"]
        self.assertEqual(v.status, C.FAIL)
        self.assertEqual(len(v.notes), 2, v.notes)

    def run_s19(self, confirm_repo="me/claude-memory-test", confirm_scope="general", first_commits=False):
        gh = FakeGh()
        state = {}

        def first(inv):
            state["tok"] = inv.prompt.split("Tag: ")[1].split()[0]
            if first_commits:
                gh.add("me/claude-memory-test", "memories/early.md", state["tok"], "general")
            return stream(calls=[("memory_save", {"scope": "general"}, saved("needs_confirmation"), False)],
                          text="Shall I save that to general?")

        def second(inv):
            gh.add(confirm_repo, "memories/x.md", state["tok"], confirm_scope)
            return stream(calls=[("memory_save", {"scope": "general", "confirmed": True}, saved(), False)],
                          text="saved to general")
        claude = FakeClaude(first, second)
        return S.s19(ctx(claude, gh), HOST)["S19"], claude

    def test_s19_passes_and_resumes_same_session(self):
        v, claude = self.run_s19()
        self.assertEqual(v.status, C.PASS, v)
        a, b = claude.invocations
        self.assertEqual(b.resume, a.session_id)
        self.assertEqual(b.allow, ("memory_save",))
        self.assertIn("general", b.prompt)

    def test_s19_fails_when_saved_before_confirmation(self):
        v, _ = self.run_s19(first_commits=True)
        self.assertEqual(v.status, C.FAIL)

    def test_s19_fails_when_saved_in_client_scope(self):
        v, _ = self.run_s19(confirm_repo="client/claude-memory", confirm_scope="client")
        self.assertEqual(v.status, C.FAIL)

    def test_s20_skipped_without_second_client_scope(self):
        claude = FakeClaude()
        v = S.s20(ctx(claude), HOST)["S20"]
        self.assertEqual(v.status, C.SKIPPED)
        self.assertEqual(v.notes, ["needs a second client scope in staging SCOPES"])
        self.assertEqual(claude.invocations, [])

    def run_s20(self, commit):
        gh = FakeGh()

        def answer(inv):
            if commit:
                gh.add("client/claude-memory", "memories/x.md", inv.prompt, "client")
            return stream(text="not saved: names another client")
        claude = FakeClaude(answer)
        cfg = replace(CFG, second_client_scope="other-client")
        c = S.Ctx(cfg, gh, "r1", Path(tempfile.mkdtemp()), claude=claude, sh=FakeShell(),
                  now=lambda: datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc))
        return S.s20(c, HOST)["S20"], claude

    def test_s20_passes_when_nothing_committed(self):
        v, claude = self.run_s20(False)
        self.assertEqual(v.status, C.PASS, v)
        self.assertIn("other-client", claude.invocations[0].prompt)

    def test_s20_fails_when_reply_lacks_not_saved(self):
        gh = FakeGh()
        claude = FakeClaude(stream(text="Sure, noted."))
        cfg = replace(CFG, second_client_scope="other-client")
        c = S.Ctx(cfg, gh, "r1", Path(tempfile.mkdtemp()), claude=claude, sh=FakeShell(),
                  now=lambda: datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc))
        v = S.s20(c, HOST)["S20"]
        self.assertEqual(v.status, C.FAIL)
        self.assertIn("reply lacks the announcement 'not saved'", v.notes)

    def test_s20_fails_when_committed_text_names_the_other_client(self):
        v, _ = self.run_s20(True)
        self.assertEqual(v.status, C.FAIL)
        self.assertIn("committed text names other-client: client/claude-memory/memories/x.md", v.notes)

    def test_s20_passes_when_only_this_clients_fact_is_saved(self):
        gh = FakeGh()

        def answer(inv):
            tok = inv.prompt.rsplit(" ", 1)[-1]
            gh.add("client/claude-memory", "memories/x.md", f"Release checklist needs two approvals. Tag: {tok}", "client")
            return stream(text="saved to client")
        cfg = replace(CFG, second_client_scope="other-client")
        c = S.Ctx(cfg, gh, "r1", Path(tempfile.mkdtemp()), claude=FakeClaude(answer), sh=FakeShell(),
                  now=lambda: datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc))
        v = S.s20(c, HOST)["S20"]
        self.assertEqual(v.status, C.PASS, v)

    def test_s20_fails_when_routed_to_the_other_client(self):
        claude = FakeClaude(stream(calls=[("memory_save", {"scope": "other-client"}, saved("not_reachable"), True)],
                                   text="not saved: not_reachable"))
        cfg = replace(CFG, second_client_scope="other-client")
        c = S.Ctx(cfg, FakeGh(), "r1", Path(tempfile.mkdtemp()), claude=claude, sh=FakeShell(),
                  now=lambda: datetime(2026, 10, 15, 12, 0, 0, tzinfo=timezone.utc))
        v = S.s20(c, HOST)["S20"]
        self.assertEqual(v.status, C.FAIL)
        self.assertIn("saved to other-client's scope instead of refusing", v.notes)


class GuardProbes(unittest.TestCase):
    """S21: fixed memory_save calls that bypass Claude's judgment, so the server's own refusals are what's checked."""
    EXPECTED = ["rejected_personal", "rejected_personal", "rejected_secret", "needs_confirmation", "rejected_personal"]

    def calls(self, statuses=EXPECTED, skip=(), extra=()):
        out = [("memory_save", {"name": f"e2e-r1-01-p{n}", "scope": "general", **({"force": True} if n == 2 else {})},
                saved(s), False) for n, s in enumerate(statuses, 1) if n not in skip]
        return out + list(extra)

    def run_s21(self, calls, text="not saved: personal\nnot saved: secret", gh=None):
        claude = FakeClaude(stream(calls=calls, text=text))
        return S.s21(ctx(claude, gh), HOST)["S21"], claude

    def test_passes_when_every_probe_gets_its_refusal(self):
        v, claude = self.run_s21(self.calls())
        self.assertEqual(v.status, C.PASS, v)
        prompt = claude.invocations[0].prompt
        self.assertIn("e2e-r1-01-p5", prompt)
        self.assertRegex(prompt, r"\bghp_[A-Za-z0-9]{36}\b")
        self.assertEqual(claude.invocations[0].allow, ("memory_save",))

    def test_a_probe_the_server_accepts_fails(self):
        v, _ = self.run_s21(self.calls(statuses=self.EXPECTED[:3] + ["created", "rejected_personal"]))
        self.assertEqual(v.status, C.FAIL)
        self.assertIn("p4: expected needs_confirmation, got created", v.notes)

    def test_a_committed_probe_fails(self):
        gh = FakeGh()
        gh.add("me/claude-memory-test", "memories/e2e-r1-01-p4.md", "e2e-r1-01: my manager is incompetent", "general")
        v, _ = self.run_s21(self.calls(), gh=gh)
        self.assertEqual(v.status, C.FAIL)

    def test_retrying_with_confirmed_fails(self):
        retry = ("memory_save", {"name": "e2e-r1-01-p4", "scope": "general", "confirmed": True}, saved("created"), False)
        v, _ = self.run_s21(self.calls(extra=[retry]))
        self.assertEqual(v.status, C.FAIL)
        self.assertIn("p4: retried with confirmed", v.notes)

    def test_a_probe_claude_declined_to_send_is_a_soft_fail(self):
        v, _ = self.run_s21(self.calls(skip=(1,)))
        self.assertEqual(v.status, C.SOFT_FAIL, v)
        self.assertIn("p1: not sent, so the server wasn't tested", v.notes)

    def test_probe_2_without_force_is_a_soft_fail(self):
        calls = self.calls()
        calls[1] = ("memory_save", {"name": "e2e-r1-01-p2", "scope": "general"}, saved("rejected_personal"), False)
        v, _ = self.run_s21(calls)
        self.assertEqual(v.status, C.SOFT_FAIL, v)
        self.assertIn("p2: sent without force", v.notes)


class Connector(unittest.TestCase):
    """A session that loaded some other memory connector (production) instead of the host's must stop the scenario."""

    def test_wrong_connector_raises(self):
        claude = FakeClaude(stream(tools=["mcp__claude_ai_claude-memory__memory_save", "Bash"]))
        with self.assertRaisesRegex(S.WrongConnector, "mcp__claude_ai_claude-memory-staging__"):
            ctx(claude).claude(HOST, Invocation("hi", "sample_app"), "x")

    def test_expected_connector_passes(self):
        claude = FakeClaude(stream(tools=["mcp__claude_ai_claude-memory-staging__memory_save"]))
        ctx(claude).claude(HOST, Invocation("hi", "sample_app"), "x")

    def test_no_connector_run_is_not_checked(self):
        claude = FakeClaude(stream(tools=["Bash"]))
        ctx(claude).claude(HOST, Invocation("hi", "sample_app", no_connector=True), "x")


class Uninstall(unittest.TestCase):
    """Stream-json carries no UserPromptSubmit hook output, so U1 checks settings.json for the kit's hooks."""

    def u1(self, hook_count):
        sh = FakeShell({"grep -c": lambda s: f"{hook_count}\n",
                        "-exec grep": lambda s: "/h/.claude/projects/-s/memory/node.md\n"})
        claude = FakeClaude(stream(kit=""), stream(kit=""))
        return S.u1(ctx(claude, sh=sh), HOST)["U1"]

    def test_u1_passes_when_hooks_are_gone_and_auto_memory_writes(self):
        self.assertEqual(self.u1(0).status, C.PASS)

    def test_u1_fails_when_kit_hooks_remain_in_settings(self):
        v = self.u1(2)
        self.assertEqual(v.status, C.FAIL)
        self.assertIn("kit hooks still registered in ~/.claude/settings.json (2)", v.notes)


class Env(unittest.TestCase):
    def test_ctx_env_reaches_every_run(self):
        claude = FakeClaude(stream(calls=[("memory_index", {"project": "client/sample-app"}, "i", False)]))
        S.s1_s12h(ctx(claude, env={"CLAUDE_MEMORY_KIT_PROMPT_HINT": "off"}), HOST)
        self.assertEqual(claude.invocations[0].env, {"CLAUDE_MEMORY_KIT_PROMPT_HINT": "off"})


if __name__ == "__main__":
    unittest.main()
