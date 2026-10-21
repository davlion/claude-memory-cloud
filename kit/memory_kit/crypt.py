"""Encryption-at-rest formats, mirroring src/crypto.ts and src/encrypted-files.ts byte for byte. The only kit module
(with memcrypt) that needs a third-party package: `cryptography` is imported inside the functions."""
from __future__ import annotations

import base64
import binascii
import hmac as _hmac
import json
import re
import secrets
from dataclasses import dataclass
from typing import Any, Optional

KEY_PREFIX = "cmk1_"
MARKER_PATH = ".claude-memory/encryption.json"
_INSTALL = "python3 -m pip install --require-hashes --only-binary :all: -r kit/requirements-crypt.txt"


class DecryptError(Exception):
    """Any open failure (wrong key, wrong AAD, tampering, malformed blob); never says which."""

    def __init__(self) -> None:
        super().__init__("decryption failed")


@dataclass(frozen=True)
class RepoKey:
    file_key: bytes
    mac_key: bytes
    id: str


@dataclass(frozen=True)
class Marker:
    enabled: bool
    repo_id: str
    key_id: str
    mac: str = ""


def _need(name: str) -> Any:
    try:
        if name == "aead":
            from cryptography.hazmat.primitives.ciphers.aead import AESGCM
            return AESGCM
        from cryptography.hazmat.primitives import hashes
        from cryptography.hazmat.primitives.kdf.hkdf import HKDF
        return HKDF, hashes.SHA256
    except ImportError:
        raise RuntimeError(f"The 'cryptography' package is required for encrypted memories. Install it with: {_INSTALL}") from None


def _b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def generate_key_text() -> str:
    return KEY_PREFIX + _b64url(secrets.token_bytes(32))


def new_repo_id() -> str:
    return _b64url(secrets.token_bytes(16))


_KEY_RE = re.compile(r"cmk1_[A-Za-z0-9_-]{43}\Z")


def parse_key_text(text: str) -> RepoKey:
    """Derives the file key, marker-MAC key and key ID; the error never echoes the input."""
    t = text.strip()
    if not _KEY_RE.match(t):
        raise ValueError("That isn't a claude-memory repo key.")
    HKDF, sha256 = _need("hkdf")
    raw = base64.urlsafe_b64decode(t[len(KEY_PREFIX):] + "=")

    def derive(info: str, n: int) -> bytes:
        return HKDF(algorithm=sha256(), length=n, salt=None, info=info.encode()).derive(raw)

    return RepoKey(derive("claude-memory v1 file-key", 32), derive("claude-memory v1 marker-mac", 32),
                   derive("claude-memory v1 key-id", 8).hex())


def seal(file_key: bytes, plaintext: str, aad: str, iv: Optional[bytes] = None) -> str:
    """Standard base64 of iv(12) + ciphertext + tag(16); `iv` is for tests only."""
    aesgcm = _need("aead")
    iv = secrets.token_bytes(12) if iv is None else iv
    return base64.b64encode(iv + aesgcm(file_key).encrypt(iv, plaintext.encode("utf-8"), aad.encode("utf-8"))).decode("ascii")


def open_sealed(file_key: bytes, sealed: str, aad: str) -> str:
    aesgcm = _need("aead")
    try:
        b = base64.b64decode(sealed, validate=True)
        if len(b) < 28:
            raise ValueError
        return aesgcm(file_key).decrypt(b[:12], b[12:], aad.encode("utf-8")).decode("utf-8")
    except Exception:
        raise DecryptError() from None


def hmac_hex(mac_key: bytes, message: str) -> str:
    return _hmac.new(mac_key, message.encode("utf-8"), "sha256").hexdigest()


def _message(m: Marker) -> str:
    return f"claude-memory-marker-v1\n1\n{'true' if m.enabled else 'false'}\n{m.repo_id}\n{m.key_id}"


def parse_marker(text: str) -> Marker:
    try:
        j = json.loads(text)
    except ValueError:
        j = None
    ok = (isinstance(j, dict) and type(j.get("format")) is int and j["format"] == 1 and isinstance(j.get("enabled"), bool)
          and all(isinstance(j.get(k), str) for k in ("repo_id", "key_id", "mac")))
    if not ok:
        raise ValueError("The repo's encryption marker is invalid.")
    return Marker(j["enabled"], j["repo_id"], j["key_id"], j["mac"])


def sign_marker(key: RepoKey, m: Marker) -> Marker:
    return Marker(m.enabled, m.repo_id, m.key_id, hmac_hex(key.mac_key, _message(m)))


def marker_signed_by(key: RepoKey, m: Marker) -> bool:
    return _hmac.compare_digest(hmac_hex(key.mac_key, _message(m)).encode(), m.mac.encode("utf-8"))


def serialize_marker(m: Marker) -> str:
    return json.dumps({"format": 1, "enabled": m.enabled, "repo_id": m.repo_id, "key_id": m.key_id, "mac": m.mac},
                      indent=2, ensure_ascii=False) + "\n"


_FILE_RE = re.compile(r"---\nencrypted: claude-memory-v1\nname: ([a-z0-9][a-z0-9-]{0,63})\nkey_id: ([0-9a-f]{16})\n---\n([A-Za-z0-9+/]+={0,2})\n?")
_PATH_RE = re.compile(r"memories/([a-z0-9][a-z0-9-]{0,63})(\.conflict-[0-9]{8}T[0-9]{6}Z(?:-[0-9]{1,3})?)?\.md")
_TAIL_RE = re.compile(r"(?:^|/)(memories/[^/]+)\Z")


def is_encrypted_file(text: str) -> bool:
    return text.startswith("---\nencrypted: claude-memory-v1\n")


def _aad(repo_id: str, full_path: str) -> str:
    return f"claude-memory-v1\n{repo_id}\n{full_path}"


def _name_of(full_path: str) -> Optional[str]:
    """The memory name a path stands for (a conflict copy's original), from its `memories/...` tail."""
    t = _TAIL_RE.search(full_path)
    m = _PATH_RE.fullmatch(t.group(1)) if t else None
    return m.group(1) if m else None


def seal_memory_file(key: RepoKey, repo_id: str, full_path: str, plaintext: str, iv: Optional[bytes] = None) -> str:
    name = _name_of(full_path)
    if not name:
        raise ValueError("Not a memory file path.")
    blob = seal(key.file_key, plaintext, _aad(repo_id, full_path), iv)
    return f"---\nencrypted: claude-memory-v1\nname: {name}\nkey_id: {key.id}\n---\n{blob}\n"


def open_memory_file(key: RepoKey, repo_id: str, full_path: str, text: str) -> str:
    m = _FILE_RE.fullmatch(text)
    if not m or m.group(2) != key.id or m.group(1) != _name_of(full_path):
        raise DecryptError()
    return open_sealed(key.file_key, m.group(3), _aad(repo_id, full_path))


_NAMES_RE = re.compile(r"^(- \[[^\]]+\]\([^)]+\)) — [^\n\r  ]*(?=[\n\r  ]|\Z)", re.MULTILINE)


def names_only_index(text: str) -> str:
    return _NAMES_RE.sub(r"\1", text)
