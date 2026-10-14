import json
import unittest

from helpers import SCOPES, tempdir
from memory_kit.scopemap import (ScopeMapError, client_scopes_for_owner, from_scope_args, from_scopes_file,
                                 is_general_owner, load_scope_map, validate_scope_map)


class ScopeMap(unittest.TestCase):
    def test_valid(self):
        self.assertEqual(validate_scope_map(SCOPES), SCOPES)

    def test_invalid(self):
        bad = [None, {}, {"version": 2, "login": "dav", "scopes": {"general": "dav/m"}},
               {"version": 1, "login": "", "scopes": {"general": "dav/m"}},
               {"version": 1, "login": "dav", "scopes": {}},
               {"version": 1, "login": "dav", "scopes": {"project": "dav/m"}},
               {"version": 1, "login": "dav", "scopes": {"general": "not a repo"}}]
        for b in bad:
            with self.subTest(b=b), self.assertRaises(ScopeMapError):
                validate_scope_map(b)

    def test_worker_parity(self):
        # Mirrors test/scopes.test.ts / scripts/scopes-rules.mjs: the Worker has no scope-name pattern, only "project".
        ok = {"version": 1, "login": "dav", "scopes": {"my scope.v2": "a/b", "_x": "a.b/c_d-e"}}
        self.assertEqual(validate_scope_map(ok)["scopes"], ok["scopes"])
        for repo in ["no-slash", "a/b/c", "a/", "/b", "a b/c"]:
            with self.subTest(repo=repo), self.assertRaises(ScopeMapError):
                validate_scope_map({"version": 1, "login": "dav", "scopes": {"general": repo}})
        for login in ["bad login!", "-dav", "a" * 40]:
            with self.subTest(login=login), self.assertRaises(ScopeMapError):
                validate_scope_map({"version": 1, "login": login, "scopes": {"general": "a/b"}})
        validate_scope_map({"version": 1, "login": "a" * 39, "scopes": {"general": "a/b"}})

    def test_scopes_file_worker_rules(self):
        d = tempdir(self)
        f = d / "s.json"
        for body, msg in [({"bad login!": {"general": "a/b"}}, "invalid GitHub login"),
                          ({"dav": {"project": "a/b"}}, "reserved"),
                          ({"dav": {"general": "no-slash"}}, "invalid repo"),
                          ({"dav": [], "x": {}}, "scopes")]:
            f.write_text(json.dumps(body))
            with self.subTest(body=body), self.assertRaises(ScopeMapError) as cm:
                from_scopes_file(f, "dav")
            self.assertIn(msg, str(cm.exception))
        f.write_text('{"Dav": {"general": "a/b"}, "dav": {"general": "a/b"}}')
        with self.assertRaises(ScopeMapError) as cm:
            from_scopes_file(f, "dav")
        self.assertIn("duplicate login", str(cm.exception))

    def test_other_users_entries_validated(self):
        d = tempdir(self)
        f = d / "s.json"
        for body in [{"dav": {"general": "a/b"}, "other": {"project": "a/b"}},
                     {"dav": {"general": "a/b"}, "other": {"general": "bad"}},
                     {"dav": {"general": "a/b"}, "other": []},
                     {"dav": {"general": "a/b"}, "other": None}]:
            f.write_text(json.dumps(body))
            with self.subTest(body=body), self.assertRaises(ScopeMapError):
                from_scopes_file(f, "dav")

    def test_load_missing_and_corrupt(self):
        d = tempdir(self)
        with self.assertRaises(ScopeMapError):
            load_scope_map(d / "nope.json")
        (d / "bad.json").write_text("{not json")
        with self.assertRaises(ScopeMapError):
            load_scope_map(d / "bad.json")

    def test_from_scopes_file(self):
        d = tempdir(self)
        f = d / "scopes.staging.json"
        f.write_text(json.dumps({"DavLion": {"general": "davlion/claude-memory"},
                                 "friend": {"general": "friend/claude-memory"}}))
        m = from_scopes_file(f, "davlion")
        self.assertEqual(m["login"], "DavLion")
        self.assertEqual(m["scopes"], {"general": "davlion/claude-memory"})
        with self.assertRaises(ScopeMapError):
            from_scopes_file(f, None)            # two users: --login required
        with self.assertRaises(ScopeMapError):
            from_scopes_file(f, "stranger")
        f.write_text(json.dumps({"davlion": {"general": "davlion/claude-memory"}}))
        self.assertEqual(from_scopes_file(f, None)["login"], "davlion")

    def test_from_scope_args(self):
        m = from_scope_args(["general=dav/claude-memory", "acme=acme-org/claude-memory"], "dav")
        self.assertEqual(m, SCOPES)
        with self.assertRaises(ScopeMapError):
            from_scope_args(["general"], "dav")

    def test_client_lookup(self):
        self.assertEqual(client_scopes_for_owner(SCOPES, "ACME-ORG"), ["acme"])
        self.assertEqual(client_scopes_for_owner(SCOPES, "dav"), [])
        self.assertTrue(is_general_owner(SCOPES, "Dav"))
        self.assertFalse(is_general_owner(SCOPES, "acme-org"))


if __name__ == "__main__":
    unittest.main()
