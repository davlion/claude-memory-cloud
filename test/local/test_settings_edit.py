import json
import os
import stat
import unittest

from helpers import FIXTURES, tempdir
from memory_kit.settings_edit import (ABSENT, DATE_ALLOW_RULE, GIT_ORIGIN_ALLOW_RULE, SettingsError, detect_style, dumps,
                                      install_settings, install_file, install_with_info, uninstall_file,
                                      uninstall_settings)

SESSION = "/usr/bin/python3 -I -S /h/.claude-memory-cloud/kit/hooks/session_start.py"
PROMPT = "/usr/bin/python3 -I -S /h/.claude-memory-cloud/kit/hooks/user_prompt_submit.py"
SNAPSHOT = "/usr/bin/python3 -I -S /h/.claude-memory-cloud/kit/hooks/post_tool_use.py"
ALLOW = ["Edit(~/.claude-memory-cloud/outbox/**)", "Read(~/.claude-memory-cloud/**)"]
KW = dict(session_cmd=SESSION, prompt_cmd=PROMPT, snapshot_cmd=SNAPSHOT, allow=ALLOW)


def roundtrip(name):
    text = (FIXTURES / name).read_text()
    data = json.loads(text)
    return text, data, detect_style(text, data)


class Style(unittest.TestCase):
    def test_nsjson_style_round_trips_byte_for_byte(self):
        text, data, style = roundtrip("settings-nsjson.json")
        self.assertEqual((style.key_sep, style.escape_slash, style.sort_keys, style.trailing_newline),
                         (" : ", True, True, False))
        self.assertEqual(dumps(data, style), text)

    def test_plain_style_round_trips(self):
        text, data, style = roundtrip("settings-plain.json")
        self.assertEqual(dumps(data, style), text)


class Merge(unittest.TestCase):
    def test_install_adds_and_keeps_others(self):
        _, data, _ = roundtrip("settings-nsjson.json")
        new = install_settings(data, **KW)
        self.assertIs(new["autoMemoryEnabled"], False)
        self.assertEqual(len(new["hooks"]["SessionStart"]), 2)
        self.assertEqual(new["hooks"]["SessionStart"][0], data["hooks"]["SessionStart"][0])
        self.assertEqual(new["hooks"]["SessionStart"][1],
                         {"hooks": [{"type": "command", "command": SESSION, "timeout": 5}]})
        self.assertNotIn("matcher", new["hooks"]["SessionStart"][1])     # all sources, including compact
        self.assertEqual(new["hooks"]["UserPromptSubmit"][1]["hooks"][0]["timeout"], 2)
        self.assertEqual(new["hooks"]["PostToolUse"],
                         [{"matcher": "mcp__.*__memory_index", "hooks": [{"type": "command", "command": SNAPSHOT, "timeout": 5}]}])
        self.assertEqual(new["permissions"]["allow"], ALLOW + [DATE_ALLOW_RULE, GIT_ORIGIN_ALLOW_RULE])

    def test_install_is_idempotent_and_replaces_old_kit_hooks(self):
        _, data, _ = roundtrip("settings-plain.json")
        once = install_settings(data, **KW)
        twice = install_settings(once, **KW)
        self.assertEqual(once, twice)
        moved = install_settings(once, session_cmd=SESSION.replace("/usr/bin", "/opt"), prompt_cmd=PROMPT,
                                 snapshot_cmd=SNAPSHOT, allow=ALLOW)
        self.assertEqual(len(moved["hooks"]["SessionStart"]), 1)

    def test_uninstall_is_the_inverse(self):
        for name, prev in (("settings-nsjson.json", ABSENT), ("settings-plain.json", True)):
            with self.subTest(name=name):
                text, data, style = roundtrip(name)
                new = install_settings(data, **KW)
                self.assertEqual(dumps(uninstall_settings(new, prev), style), text)

    def test_uninstall_without_state_leaves_auto_memory_alone(self):
        self.assertEqual(uninstall_settings({"autoMemoryEnabled": False}, None), {"autoMemoryEnabled": False})

    def test_uninstall_leaves_unrelated_empty_lists(self):
        self.assertEqual(uninstall_settings({"hooks": {"Stop": []}}, None), {"hooks": {"Stop": []}})

    def test_date_rule_is_narrow_and_removed_on_uninstall(self):
        self.assertEqual(DATE_ALLOW_RULE, "Bash(date -u +%Y%m%dT%H%M%SZ)")
        new = install_settings({"permissions": {"allow": ["Bash(ls *)"]}}, **KW)
        self.assertEqual(uninstall_settings(new, ABSENT), {"permissions": {"allow": ["Bash(ls *)"]}})

    def test_other_hooks_and_unknown_keys_untouched(self):
        data = {"zzz": {"deep": [1, None, {"a": 1.5}]}, "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "x"}]}],
                "SessionStart": [{"matcher": "startup", "hooks": [{"type": "command", "command": "keep"}]}]}}
        new = install_settings(data, **KW)
        self.assertEqual(new["zzz"], data["zzz"])
        self.assertEqual(new["hooks"]["Stop"], data["hooks"]["Stop"])
        self.assertEqual(new["hooks"]["SessionStart"][0], data["hooks"]["SessionStart"][0])
        self.assertEqual(uninstall_settings(new, ABSENT), data)


class Files(unittest.TestCase):
    def setUp(self):
        self.d = tempdir(self)
        self.p = self.d / "settings.json"

    def backups(self):
        return sorted(x for x in os.listdir(self.d) if ".bak-" in x)

    def test_twice_is_byte_identical_and_roundtrip_restores(self):
        orig = (FIXTURES / "settings-nsjson.json").read_text()
        self.p.write_text(orig)
        os.chmod(self.p, 0o600)
        r1 = install_file(self.p, **KW)
        first = self.p.read_text()
        self.assertEqual(r1["auto_memory_previous"], ABSENT)
        self.assertEqual(len(self.backups()), 1)
        self.assertEqual(stat.S_IMODE(self.p.stat().st_mode), 0o600)
        install_file(self.p, **KW)
        self.assertEqual(self.p.read_text(), first)
        self.assertEqual(len(self.backups()), 1)          # no change, no new backup
        uninstall_file(self.p, ABSENT)
        self.assertEqual(self.p.read_text(), orig)
        self.assertEqual(os.listdir(self.d).count("settings.json"), 1)
        self.assertFalse([x for x in os.listdir(self.d) if x.endswith(".tmp")])

    def test_previous_value_reported(self):
        self.p.write_text((FIXTURES / "settings-plain.json").read_text())
        self.assertIs(install_file(self.p, **KW)["auto_memory_previous"], True)

    def test_missing_empty_and_braces(self):
        for content in (None, "", "  \n", "{}"):
            with self.subTest(content=content):
                if self.p.exists() or self.p.is_symlink():
                    self.p.unlink()
                if content is not None:
                    self.p.write_text(content)
                r = install_file(self.p, **KW)
                self.assertEqual(r["backup"] is None, content in (None,))
                data = json.loads(self.p.read_text())
                self.assertIs(data["autoMemoryEnabled"], False)
                uninstall_file(self.p, ABSENT)
                self.assertEqual(json.loads(self.p.read_text()), {})

    def test_invalid_json_refused_nothing_changed(self):
        for bad in ('{"a": 1,}', '// c\n{}', '[1]', '{"a":'):
            with self.subTest(bad=bad):
                self.p.write_text(bad)
                with self.assertRaises(SettingsError):
                    install_file(self.p, **KW)
                with self.assertRaises(SettingsError):
                    uninstall_file(self.p, None)
                self.assertEqual(self.p.read_text(), bad)
                self.assertEqual(self.backups(), [])

    def test_symlink_resolved_and_reported(self):
        real = self.d / "real"
        real.mkdir()
        target = real / "s.json"
        target.write_text("{}")
        self.p.symlink_to(target)
        r = install_file(self.p, **KW)
        self.assertEqual(r["wrote"], str(target.resolve()))
        self.assertTrue(self.p.is_symlink())               # link itself preserved
        self.assertIn("autoMemoryEnabled", json.loads(target.read_text()))


class FixRound1(unittest.TestCase):
    def inst(self, data):
        return install_with_info(data, **KW)

    def test_user_rules_survive_uninstall(self):
        user = ["Bash(ls ~/.claude-memory-cloud/)", DATE_ALLOW_RULE, GIT_ORIGIN_ALLOW_RULE, ALLOW[1], "Bash(npm test *)"]
        data = {"permissions": {"allow": list(user)}}
        new, info = self.inst(data)
        self.assertEqual(info["added_rules"], [ALLOW[0]])          # only what was really appended
        self.assertEqual(uninstall_settings(new, ABSENT, added_rules=info["added_rules"], created=info["created"]), data)
        # unknown list: exact kit strings only, never substring (user's `ls` rule survives)
        out = uninstall_settings(new, ABSENT)
        self.assertIn("Bash(ls ~/.claude-memory-cloud/)", out["permissions"]["allow"])
        self.assertIn("Bash(npm test *)", out["permissions"]["allow"])

    def test_fallback_never_substring(self):
        d = {"permissions": {"allow": ["Bash(rm ~/.claude-memory-cloud/x)", "Read(~/.claude-memory-cloud/**)"]}}
        self.assertEqual(uninstall_settings(d, None), {"permissions": {"allow": ["Bash(rm ~/.claude-memory-cloud/x)"]}})

    def test_mixed_group_keeps_user_hook(self):
        mixed = {"matcher": "startup", "hooks": [{"type": "command", "command": "mine"},
                                                  {"type": "command", "command": SESSION}]}
        data = {"hooks": {"SessionStart": [mixed]}}
        new, info = self.inst(data)
        self.assertEqual(new["hooks"]["SessionStart"][0],
                         {"matcher": "startup", "hooks": [{"type": "command", "command": "mine"}]})
        back = uninstall_settings(new, ABSENT, added_rules=info["added_rules"], created=info["created"])
        self.assertEqual(back["hooks"]["SessionStart"], [{"matcher": "startup", "hooks": [{"type": "command", "command": "mine"}]}])
        self.assertNotIn("UserPromptSubmit", back["hooks"])
        # uninstall alone: group with only kit entries dropped, user group untouched
        self.assertEqual(uninstall_settings(data, None)["hooks"]["SessionStart"][0]["hooks"], [{"type": "command", "command": "mine"}])

    def test_reinstall_reports_unknown_previous(self):
        new, first = self.inst({"autoMemoryEnabled": True})
        self.assertIs(first["auto_memory_previous"], True)
        _, second = self.inst(new)
        self.assertIsNone(second["auto_memory_previous"])
        self.assertEqual(second["added_rules"], [])
        self.assertEqual(second["created"], [])

    def test_non_bool_auto_memory_round_trips(self):
        for raw in ("maybe", 0, None, {"a": 1}, "absent"):
            with self.subTest(raw=raw):
                data = {"autoMemoryEnabled": raw}
                new, info = self.inst(data)
                self.assertEqual(uninstall_settings(new, info["auto_memory_previous"], added_rules=info["added_rules"],
                                                    created=info["created"]), data)

    def test_preexisting_empty_containers_kept(self):
        data = {"hooks": {"SessionStart": [], "Stop": []}, "permissions": {"allow": []}}
        new, info = self.inst(data)
        self.assertEqual(info["created"], ["hooks.UserPromptSubmit", "hooks.PostToolUse"])
        back = uninstall_settings(new, ABSENT, added_rules=info["added_rules"], created=info["created"])
        self.assertEqual(back, data)
        data2 = {"hooks": {}, "permissions": {}}
        new, info = self.inst(data2)
        self.assertEqual(uninstall_settings(new, ABSENT, added_rules=info["added_rules"], created=info["created"]), data2)
        new, info = self.inst({})
        self.assertEqual(uninstall_settings(new, ABSENT, added_rules=info["added_rules"], created=info["created"]), {})

    def test_bad_shapes_refused(self):
        bad = [{"hooks": []}, {"hooks": {"SessionStart": {"hooks": []}}}, {"hooks": {"Stop": "x"}},
               {"permissions": []}, {"permissions": {"allow": "x"}},
               {"hooks": None}, {"permissions": None}, {"permissions": {"allow": None}}]
        for b in bad:
            with self.subTest(b=b):
                with self.assertRaises(SettingsError):
                    install_settings(b, **KW)
                with self.assertRaises(SettingsError):
                    uninstall_settings(b, None)

    def test_bad_shape_in_file_changes_nothing(self):
        d = tempdir(self)
        p = d / "s.json"
        p.write_text('{"hooks": {"SessionStart": {"x": 1}}}')
        with self.assertRaises(SettingsError):
            install_file(p, **KW)
        self.assertEqual(p.read_text(), '{"hooks": {"SessionStart": {"x": 1}}}')
        self.assertEqual(os.listdir(d), ["s.json"])

    def test_file_info_and_symlink_flag(self):
        d = tempdir(self)
        p = d / "s.json"
        p.write_text("{}")
        r = install_file(p, **KW)
        self.assertFalse(r["symlink"])
        self.assertEqual(set(r) >= {"auto_memory_previous", "added_rules", "created"}, True)
        link = d / "l.json"
        link.symlink_to(p)
        self.assertTrue(install_file(link, **KW)["symlink"])
        self.assertIsNone(install_file(link, **KW)["auto_memory_previous"])
        # file-level uninstall with stored info restores exactly
        uninstall_file(p, ABSENT, added_rules=r["added_rules"], created=r["created"])
        self.assertEqual(json.loads(p.read_text()), {})


if __name__ == "__main__":
    unittest.main()
