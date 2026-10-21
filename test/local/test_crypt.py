import json
import sys
import unittest
from unittest import mock

from helpers import REPO
from memory_kit import crypt

try:
    import cryptography  # noqa: F401
    HAVE = True
except ImportError:
    HAVE = False

VECTORS = json.loads((REPO / "test" / "fixtures" / "crypto-vectors.json").read_text(encoding="utf-8"))
needs = unittest.skipUnless(HAVE, "cryptography not installed")


@needs
class Vectors(unittest.TestCase):
    def test_every_vector(self):
        import base64
        for v in VECTORS:
            key = crypt.parse_key_text(v["key_text"])
            self.assertEqual(key.id, v["key_id"])
            iv = base64.b64decode(v["iv_b64"])
            self.assertEqual(crypt.seal(key.file_key, v["plaintext"], v["aad"], iv), v["sealed"])
            self.assertEqual(crypt.open_sealed(key.file_key, v["sealed"], v["aad"]), v["plaintext"])
            self.assertEqual(crypt.hmac_hex(key.mac_key, v["mac_message"]), v["mac"])

    def test_python_sealed_fixture(self):
        # The fixture the TS tests open (test/encrypted-files.test.ts); kept stable here too.
        fx = json.loads((REPO / "test" / "fixtures" / "python-sealed.json").read_text(encoding="utf-8"))
        key = crypt.parse_key_text(fx["key_text"])
        self.assertEqual(crypt.open_memory_file(key, fx["repo_id"], fx["path"], fx["file_text"]), fx["plaintext"])
        self.assertTrue(crypt.marker_signed_by(key, crypt.parse_marker(fx["marker_text"])))

    def test_key_text(self):
        t = crypt.generate_key_text()
        self.assertRegex(t, r"^cmk1_[A-Za-z0-9_-]{43}$")
        self.assertEqual(crypt.parse_key_text("  " + t + "\n").id, crypt.parse_key_text(t).id)
        for bad in ["", "cmk1_short", "cmk2_" + "A" * 43, "x" * 48]:
            with self.assertRaises(ValueError) as cm:
                crypt.parse_key_text(bad)
            self.assertNotIn(bad or "\0", str(cm.exception))
        self.assertRegex(crypt.new_repo_id(), r"^[A-Za-z0-9_-]{22}$")

    def test_open_failures(self):
        key = crypt.parse_key_text(VECTORS[0]["key_text"])
        other = crypt.parse_key_text(VECTORS[1]["key_text"])
        v = VECTORS[0]
        for args in [(other.file_key, v["sealed"], v["aad"]), (key.file_key, v["sealed"], v["aad"] + "x"),
                     (key.file_key, "AAAA", v["aad"]), (key.file_key, "!!!", v["aad"]),
                     (key.file_key, v["sealed"][:-4] + "AAAA", v["aad"])]:
            with self.assertRaises(crypt.DecryptError):
                crypt.open_sealed(*args)

    def test_marker(self):
        key = crypt.parse_key_text(VECTORS[0]["key_text"])
        m = crypt.sign_marker(key, crypt.Marker(True, "repo0", key.id))
        self.assertEqual(m.mac, VECTORS[0]["mac"])
        self.assertTrue(crypt.marker_signed_by(key, m))
        text = crypt.serialize_marker(m)
        self.assertEqual(text, json.dumps({"format": 1, "enabled": True, "repo_id": "repo0", "key_id": key.id, "mac": m.mac}, indent=2) + "\n")
        self.assertEqual(crypt.parse_marker(text), m)
        self.assertFalse(crypt.marker_signed_by(key, crypt.Marker(False, m.repo_id, m.key_id, m.mac)))
        self.assertFalse(crypt.marker_signed_by(key, crypt.Marker(True, m.repo_id, m.key_id, "")))
        self.assertFalse(crypt.marker_signed_by(crypt.parse_key_text(VECTORS[1]["key_text"]), m))
        for bad in ["", "nope", "[]", "null", json.dumps({"format": 2, "enabled": True, "repo_id": "a", "key_id": "b", "mac": "c"}),
                    json.dumps({"format": 1, "enabled": "true", "repo_id": "a", "key_id": "b", "mac": "c"}),
                    json.dumps({"format": 1, "enabled": True, "repo_id": "a", "key_id": "b"})]:
            with self.assertRaises(ValueError):
                crypt.parse_marker(bad)
        self.assertEqual(crypt.MARKER_PATH, ".claude-memory/encryption.json")

    def test_memory_file(self):
        key = crypt.parse_key_text(VECTORS[1]["key_text"])
        path = "projects/billing/memories/a.md"
        text = crypt.seal_memory_file(key, "repoX", path, "---\nname: a\n---\nsecré\n")
        self.assertTrue(text.startswith(f"---\nencrypted: claude-memory-v1\nname: a\nkey_id: {key.id}\n---\n"))
        self.assertTrue(text.endswith("\n"))
        self.assertTrue(crypt.is_encrypted_file(text))
        self.assertFalse(crypt.is_encrypted_file("---\nname: a\n---\n"))
        self.assertEqual(crypt.open_memory_file(key, "repoX", path, text), "---\nname: a\n---\nsecré\n")
        for p, r in [("projects/billing/memories/b.md", "repoX"), (path, "repoY"), ("projects/other/memories/a.md", "repoX")]:
            with self.assertRaises(crypt.DecryptError):
                crypt.open_memory_file(key, r, p, text)
        with self.assertRaises(crypt.DecryptError):
            crypt.open_memory_file(crypt.parse_key_text(VECTORS[0]["key_text"]), "repoX", path, text)
        with self.assertRaises(crypt.DecryptError):
            crypt.open_memory_file(key, "repoX", path, text.replace("name: a", "name: b"))
        with self.assertRaises(crypt.DecryptError):
            crypt.open_memory_file(key, "repoX", path, text + "\n")
        with self.assertRaises(ValueError):
            crypt.seal_memory_file(key, "repoX", "projects/billing/notes/a.md", "x")

    def test_conflict_copy_uses_original_name(self):
        key = crypt.parse_key_text(VECTORS[0]["key_text"])
        path = "memories/a.conflict-20261020T101010Z.md"
        text = crypt.seal_memory_file(key, "r", path, "x")
        self.assertIn("\nname: a\n", text)
        self.assertEqual(crypt.open_memory_file(key, "r", path, text), "x")


class NamesOnly(unittest.TestCase):
    def test_example(self):
        idx = ("# Memory index — billing\n\n- [a](memories/a.md) — secret thing\n\n## Conflicts\n"
               "- memories/a.conflict-20261020T101010Z.md — reconcile with a.md\n")
        out = crypt.names_only_index(idx)
        self.assertEqual(out, "# Memory index — billing\n\n- [a](memories/a.md)\n\n## Conflicts\n"
                              "- memories/a.conflict-20261020T101010Z.md — reconcile with a.md\n")


class NoCryptography(unittest.TestCase):
    def test_runtime_error_names_the_install(self):
        blocked = {n: None for n in ("cryptography", "cryptography.hazmat", "cryptography.hazmat.primitives",
                                     "cryptography.hazmat.primitives.ciphers", "cryptography.hazmat.primitives.ciphers.aead",
                                     "cryptography.hazmat.primitives.kdf", "cryptography.hazmat.primitives.kdf.hkdf")}
        with mock.patch.dict(sys.modules, blocked):
            with self.assertRaises(RuntimeError) as cm:
                crypt.seal(b"k" * 32, "x", "aad")
            self.assertIn("--only-binary", str(cm.exception))
            self.assertIn("kit/requirements-crypt.txt", str(cm.exception))
            with self.assertRaises(RuntimeError):
                crypt.parse_key_text("cmk1_" + "A" * 43)


if __name__ == "__main__":
    unittest.main()
