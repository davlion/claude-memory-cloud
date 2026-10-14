import json
import os
import stat
import unittest

from helpers import FIXTURES, tempdir
from memory_kit.settings_edit import (ABSENT, DATE_ALLOW_RULE, SettingsError, detect_style, dumps,
                                      install_settings, install_file, uninstall_file, uninstall_settings)

SESSION = "/usr/bin/python3 -I -S /h/.claude-memory-cloud/kit/hooks/session_start.py"
PROMPT = "/usr/bin/python3 -I -S /h/.claude-memory-cloud/kit/hooks/user_prompt_submit.py"
ALLOW = ["Edit(~/.claude-memory-cloud/outbox/**)", "Read(~/.claude-memory-cloud/**)"]
KW = dict(session_cmd=SESSION, prompt_cmd=PROMPT, allow=ALLOW)


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
        self.assertEqual(new["permissions"]["allow"], ALLOW + [DATE_ALLOW_RULE])

    def test_install_is_idempotent_and_replaces_old_kit_hooks(self):
        _, data, _ = roundtrip("settings-plain.json")
        once = install_settings(data, **KW)
        twice = install_settings(once, **KW)
        self.assertEqual(once, twice)
        moved = install_settings(once, session_cmd=SESSION.replace("/usr/bin", "/opt"), prompt_cmd=PROMPT, allow=ALLOW)
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


if __name__ == "__main__":
    unittest.main()
