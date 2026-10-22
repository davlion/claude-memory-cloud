# Encryption at Rest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Optional per-memory-repo encryption of memory descriptions and bodies at rest in GitHub, decrypted only inside the Worker, with a key page for repo owners and local encrypt/decrypt/rotate commands.

**Architecture:** A new `EncryptingStore` wraps `GitHubStore` behind the existing `Store` interface: snapshots (and the KV cache) hold ciphertext and are decrypted in memory; commits encrypt memory files just before they're written. Repo keys live in `OAUTH_KV`, wrapped under a Worker master key; the Worker also keeps a no-expiry record of each encrypted repo so a deleted or unsigned marker can't turn encryption off. A browser key page (its own GitHub sign-in) turns encryption on (fresh repo or in-place squash) and registers, removes or stops keys. A Python `memcrypt` command does the same on a temporary clone with the pinned `cryptography` package. Both implementations share one file format, pinned by shared test vectors.

**Tech Stack:** TypeScript on Cloudflare Workers (WebCrypto AES-256-GCM, HKDF-SHA256, HMAC-SHA256), vitest in workerd; Python 3.9+ (`cryptography`, pinned with hashes, wheels only, for `memcrypt` only), unittest.

**Spec:** `docs/superpowers/specs/2026-10-20-encryption-at-rest-design.md`

**Permissions (decided):** turning on, turning back on and stopping need **admin** on the repo (`mayChangeEncryption`, Task 9). Registering and removing a key need write access plus the key.

## Global Constraints

- Branch `encryption-at-rest`. Every commit ends with `Co-Authored-By: <implementing model> <noreply@anthropic.com>`.
- Test-first for every task: red, then green. `npm test`, `npm run typecheck` and `npm run test:local` pass at the end of every task.
- No new npm dependencies: WebCrypto only.
- The kit stays Python 3.9+ standard library only, **except** `kit/memory_kit/crypt.py` and `kit/memory_kit/memcrypt.py`. Those use `cryptography`, pinned to an exact version with hashes (`kit/requirements-crypt.txt`) and installed with `pip install --require-hashes --only-binary :all:`.
- Never write a plaintext memory file to an encrypted repo (as defined in Task 5). Never put plaintext of an encrypted repo's memories in `CACHE_KV`, in `MEMORY.md`, or in a commit message. Never seal a file the memory tool didn't save itself.
- Key text (repo or master) never appears in logs, error messages, URLs or GET parameters. POST bodies only.
- Encrypted: description, body and type. Readable: names (filenames, the encrypted file's `name:` line, names-only `MEMORY.md`, commit messages).
- User-facing text says "memory tool" or nothing rather than "server", except where the operator is meant ("the memory server's operator").
- The local machine is inside the trusted boundary; only the session-start snapshot is reduced to names.
- Server instructions stay within `MAX_INSTRUCTIONS` (4000 characters).
- Versions bump once, in Task 12: `HOOK_VERSION`, `WORKER_VERSION`, `MIN_HOOK_VERSION` → `0.1.5`.

### Fixed formats (both implementations, byte for byte)

| Item | Format |
|---|---|
| Repo key text | `cmk1_` + base64url (no padding) of 32 random bytes (the raw key) |
| Derived keys | HKDF-SHA256, salt empty, ikm = raw key. `info` = `claude-memory v1 file-key` (32 bytes, AES-256-GCM), `claude-memory v1 key-id` (8 bytes), `claude-memory v1 marker-mac` (32 bytes, HMAC-SHA256) |
| Key ID | lower-case hex of the 8-byte `key-id` output (16 chars) |
| Master key (`MEMORY_MASTER_KEY` secret) | standard base64 of 32 bytes (`openssl rand -base64 32`) |
| Repo ID | base64url (no padding) of 16 random bytes |
| Marker path | `.claude-memory/encryption.json` at the repo root |
| Marker JSON | `{"format": 1, "enabled": <bool>, "repo_id": "…", "key_id": "…", "mac": "…"}`, written `JSON.stringify(m, null, 2) + "\n"` |
| Marker MAC | lower-case hex HMAC-SHA256(marker-mac key, `claude-memory-marker-v1\n1\n<true\|false>\n<repo_id>\n<key_id>`) |
| AAD | UTF-8 of `claude-memory-v1\n<repo_id>\n<path from repo root>` (e.g. `projects/billing/memories/a.md`) |
| Sealed blob | standard base64 of `iv (12 bytes) ‖ ciphertext ‖ tag (16 bytes)`; AES-256-GCM with the file key; payload = the plaintext file's exact UTF-8 bytes |
| Encrypted memory file | `---\nencrypted: claude-memory-v1\nname: <name>\nkey_id: <key id>\n---\n<sealed blob>\n` |
| Encrypted-file regex | `^---\nencrypted: claude-memory-v1\nname: ([a-z0-9][a-z0-9-]{0,63})\nkey_id: ([0-9a-f]{16})\n---\n([A-Za-z0-9+/]+={0,2})\n?$` |
| `<name>` | from the path (`parseMemoryPath(...).name`; the original's name for a conflict copy), never from YAML |
| Names-only index | each line matching `^(- \[[^\]]+\]\([^)]+\)) — .*$` becomes its first group |
| KV keys (`OAUTH_KV`) | `repokey:v1:<repo lower>` (wrapped key, TTL per setting), `repoenc:v1:<repo lower>` (`{repo_id, key_id, enabled}`, no TTL), `switching:v1:<repo lower>` (TTL 300), `moving:v1:<repo lower>` (`{to, repo_id}`, no TTL), `keysession:`, `keystate:`, `keypending:` |
| Commit trailers | `Memory-Source: key page (<login>)` or `Memory-Source: memcrypt on <hostname>`, plus `Memory-Scope: *` |

## Review Focus

1. **Someone with write access deletes the marker, or edits it to `enabled: false`, without the key.** Expect: the repo is still treated as encrypted: no plaintext saves, the index file stays names-only, a ✗ health line (Task 5 test `deleted or unsigned marker keeps the repo encrypted`).
2. **A save arrives while switch-on is running, or between a fresh-repo write and the user's rename.** Expect: a retryable `unavailable` that queues in Claude Code. Nothing is lost, and nothing lands in the repo that's about to be deleted (Task 5 tests `saves wait while switching` and `saves wait while moving`; Task 7 `aborts when the ref moved`; Task 11 `--force-with-lease`).
3. **The registered key doesn't match the repo** (after a local `rotate`, or a pasted old key). Expect: treated as missing: reads locked, saves `key_required`, health says so. Nothing is written with the wrong key (Task 5 test `mismatched key is treated as missing`).
4. **A tampered, swapped or moved ciphertext file.** Expect: that file is unreadable (not indexed, not served, never overwritten blind), and the others still load (Task 5 test `tampered file is unreadable, others still load`).
5. **Descriptions leaking through side channels** of an encrypted repo: stored `MEMORY.md`, the KV snapshot cache, commit messages. Expect: none contain description or body text (Task 5 test `no plaintext reaches GitHub or the cache`).

---

### Task 1: Crypto primitives

**Files:**
- Create: `src/crypto.ts`
- Create: `test/fixtures/crypto-vectors.json`
- Test: `test/crypto.test.ts`

**Interfaces:**
- Produces:
  - `KEY_PREFIX = "cmk1_"`
  - `interface RepoKey { fileKey: CryptoKey; macKey: CryptoKey; id: string }`
  - `generateKeyText(): string`
  - `parseKeyText(text: string): Promise<RepoKey>`: trims whitespace; derives the three keys by HKDF; throws `OpError("invalid", "That isn't a claude-memory repo key.")` on a bad prefix or length, never echoing the input
  - `class DecryptError extends Error`
  - `seal(key: CryptoKey, plaintext: string, aad: string, iv?: Uint8Array): Promise<string>`: `iv` only for tests
  - `open(key: CryptoKey, sealed: string, aad: string): Promise<string>`: throws `DecryptError`
  - `hmacHex(key: CryptoKey, message: string): Promise<string>`
  - `parseMasterKey(text: string): Promise<CryptoKey>`: throws `Error("MEMORY_MASTER_KEY must be base64 of 32 bytes")`
  - `newRepoId(): string`

- [ ] **Step 1: Write the failing tests** in `test/crypto.test.ts`:
  - `generateKeyText` matches `/^cmk1_[A-Za-z0-9_-]{43}$/`, and two calls differ.
  - `parseKeyText(" " + k + "\n")` works; `id` matches `/^[0-9a-f]{16}$/` and is stable across parses.
  - Bad text rejects with `code: "invalid"`, and the message doesn't contain the input.
  - Round trip: `open(k.fileKey, await seal(k.fileKey, "é memory", "aad"), "aad")` returns `"é memory"`.
  - A different AAD, a flipped byte, or another key rejects with `DecryptError`. Two seals of the same text differ.
  - **Vectors:** for each entry in `crypto-vectors.json` (`{ key_text, key_id, iv_b64, aad, plaintext, sealed, mac_message, mac }`), the `id`, the `sealed` text with the given `iv`, the `open` result and `hmacHex(macKey, mac_message)` all match.
- [ ] **Step 2: Run** `npx vitest run test/crypto.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement `src/crypto.ts`** with WebCrypto (`HKDF` → `AES-GCM`/`HMAC`). Generate `crypto-vectors.json` once from it, with 3 entries: an ASCII memory, a non-ASCII one, and an empty body. Commit it; Python checks against it in Task 10.
- [ ] **Step 4: Run** `npx vitest run test/crypto.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(crypto): AES-GCM sealing, HKDF-derived keys, repo key text`

### Task 2: Encrypted file, signed marker and names-only index formats

**Files:**
- Create: `src/encrypted-files.ts`
- Modify: `src/memory.ts` (add `namesOnlyIndex`)
- Test: `test/encrypted-files.test.ts`, `test/memory.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `MARKER_PATH = ".claude-memory/encryption.json"`
  - `interface Marker { enabled: boolean; repoId: string; keyId: string; mac: string }`
  - `parseMarker(text: string): Marker`: throws `OpError("internal", "…encryption marker is invalid…", "Restore .claude-memory/encryption.json in the memory repo.")` on bad JSON, `format !== 1`, or bad fields
  - `signMarker(key: RepoKey, m: Omit<Marker, "mac">): Promise<Marker>`
  - `markerSignedBy(key: RepoKey, m: Marker): Promise<boolean>`
  - `serializeMarker(m: Marker): string`
  - `isEncryptedFile(text: string): boolean`
  - `aadFor(repoId: string, fullPath: string): string`
  - `sealMemoryFile(key: RepoKey, repoId: string, fullPath: string, plaintext: string, iv?: Uint8Array): Promise<string>`
  - `openMemoryFile(key: RepoKey, repoId: string, fullPath: string, text: string): Promise<string>`: throws `DecryptError` on a regex mismatch, `key_id` ≠ `key.id`, `name` ≠ the path's name, or a failed `open`
  - In `src/memory.ts`: `namesOnlyIndex(text: string): string`

- [ ] **Step 1: Write the failing tests:**
  - `signMarker` → `serializeMarker` → `parseMarker` → `markerSignedBy` is true. Flipping `enabled`, `repoId` or `keyId` makes it false, and so does checking with another key. `format: 2` throws `internal`.
  - A sealed `projects/billing/memories/a.md` matches the regex, contains `name: a`, and doesn't contain the description or body. It opens back to the original.
  - A conflict copy gets `name: a`. A memory named `123` round-trips with the header line exactly `name: 123`.
  - Opening at another path or with another `repoId` throws `DecryptError`.
  - `isEncryptedFile` is false for `serializeMemory(mem)` and true for a sealed file.
  - `namesOnlyIndex` keeps the heading and the Conflicts section and drops ` — secret thing`.
- [ ] **Step 2: Run** `npx vitest run test/encrypted-files.test.ts test/memory.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** per the format table. Parse the encrypted header with the fixed regex, never YAML.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(crypto): encrypted memory file and signed marker formats`

### Task 3: Snapshots carry the marker

**Files:**
- Modify: `src/store.ts` (`Snapshot`, `FileEntry`, `GitHubStore.snapshot`, cache key)
- Modify: `test/fake-store.ts`
- Test: `test/store.test.ts`

**Interfaces:**
- Produces:
  - `Snapshot.marker: string | null`: raw text of `MARKER_PATH` at the repo root (any prefix), or null
  - `FileEntry.locked?: true` and `FileEntry.outside?: true`: set only by `EncryptingStore`
  - `interface EncryptionStatus { encrypted: boolean; enabled: boolean; key: "ok" | "missing" | "mismatch" | "unsupported"; markerProblem: boolean; sealed: number; outside: number }`, defined here and filled in Task 5
  - `Snapshot.encryption?: EncryptionStatus`
  - The snapshot cache key becomes `snap:v3:<repo>:<commit>:<prefix>`
  - `FakeStore` returns `marker` from `.claude-memory/encryption.json`

- [ ] **Step 1: Write the failing tests:**
  - The marker text is returned in `marker` for any prefix, fetched in the same GraphQL query (`count(calls, "/graphql") === 1`).
  - Without the file, `marker === null`.
  - An unreadable marker blob throws `code: "internal"`.
  - The cache round-trips `marker`, and the key starts with `snap:v3:dav/mem:`.
- [ ] **Step 2: Run** `npx vitest run test/store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(store): snapshots carry the encryption marker`

### Task 4: Key ring and encrypted-repo records

**Files:**
- Create: `src/keyring.ts`
- Modify: `src/env.ts` (`MEMORY_MASTER_KEY?: string; REPO_KEY_TTL_SECONDS?: string`)
- Modify: `vitest.config.ts` (bind a test `MEMORY_MASTER_KEY`), `wrangler.jsonc` (comment documenting both)
- Test: `test/keyring.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces `class KeyRing`:
  - `constructor(kv: KVNamespace, master: CryptoKey, ttlSeconds: number)`
  - `static fromEnv(env: Env): Promise<KeyRing | null>`: null without `MEMORY_MASTER_KEY`; throws on a malformed one
  - `get(repo): Promise<RegisteredKey | null>`, memoized per instance, where `RegisteredKey = { key: RepoKey; registeredBy: string; registeredAt: number; expiresAt: number | null }`
  - `put(repo, keyText, login, now): Promise<{ expiresAt: number | null }>`
  - `remove(repo): Promise<void>`
  - `getRecord(repo): Promise<EncryptedRepoRecord | null>` and `putRecord(repo, r: EncryptedRepoRecord): Promise<void>`, where `EncryptedRepoRecord = { repoId: string; keyId: string; enabled: boolean }`, no TTL
  - `isSwitching(repo): Promise<boolean>`, `setSwitching(repo): Promise<void>` (TTL 300), `clearSwitching(repo): Promise<void>`
  - `getMove(repo): Promise<{ to: string; repoId: string } | null>`, `setMove(repo, to, repoId)`, `clearMove(repo)`
  - `wrapText(text: string, aad: string): Promise<string>` and `unwrapText(sealed: string, aad: string): Promise<string | null>`, for Tasks 8–9 (session token, pending key)
  - The KV value for a key is `{ sealed, key_id, by, at, expires_at }`. `sealed` is the key text wrapped with AAD `repokey-v1\n<repo lower>`.

- [ ] **Step 1: Write the failing tests:**
  - `put` then `get` gives the same `key.id`. The raw KV value contains neither the key text nor its body.
  - TTL unset or `0`: `expiresAt === null` and no `expirationTtl`. TTL `86400` is passed through; `10` is clamped to 60.
  - A value wrapped under another master key, or copied to another repo's KV key, gives `get` → `null`.
  - `remove` works. Records persist without TTL and survive `remove`. The switching flag has TTL 300. Moves round-trip and clear.
  - `fromEnv` returns null without the secret.
- [ ] **Step 2: Run** `npx vitest run test/keyring.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run test/keyring.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(keys): repo key ring, encrypted-repo records and switch flags in KV`

### Task 5: EncryptingStore

**Files:**
- Create: `src/encrypting-store.ts`
- Modify: `src/errors.ts` (add `"key_required"` to `ErrorCode` and `RETRYABLE`)
- Test: `test/encrypting-store.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
  - `class EncryptingStore implements Store`:
    - `constructor(inner: Store, keys: KeyRing | null, keysUrl: string)`
    - `snapshot`, `commit`, and `cacheWriteFailed` delegated to `inner`
  - `keyRequired(repo: string, keysUrl: string): OpError`: code `key_required`, message `"<repo> is encrypted and its key isn't registered, so this can't be saved yet."`, action `"Register the repo's key (from your password manager) at <keysUrl>?repo=<repo>, then try again."`

**Deciding a repo's state** (per snapshot; `rec` = `getRecord(repo)`, `m` = parsed marker, `k` = registered key):
1. If `m` is signed by `k` (`markerSignedBy`): `m` is authoritative. Set `enabled = m.enabled`. If `rec` differs, `putRecord` to match.
2. Otherwise, if `rec` exists: use `rec` (`enabled`, `repoId`). Set `markerProblem = true` when `m` is missing or its fields differ from `rec`.
3. Otherwise, if `m` exists (unverifiable): `enabled = m.enabled`, but `enabled` is forced `true` when any sealed file exists and `m.enabled` is false. `markerProblem` is set in that forced case.
4. Otherwise, if any sealed file exists: `encrypted`, `enabled = true`, `markerProblem = true`.
5. Otherwise: not encrypted. Pass everything through unchanged; no `encryption` field.

`encrypted = enabled || sealed > 0`. `key` is `"unsupported"` without a key ring, `"missing"` without `k`, `"mismatch"` when `k.key.id` ≠ the repo's key ID, otherwise `"ok"`.

**Snapshot:**
- Sealed files decrypt when `key === "ok"`. Otherwise they come back `{ locked: true, content: "" }`.
- A failed decrypt gives `{ unreadable: true, content: "" }`.
- When `enabled`, plaintext memory files come back with `outside: true` (content kept).

**Commit rules:**
- `isSwitching(repo)` or `getMove(repo)` → throw `OpError("unavailable", "Encryption is being turned on for this memory repo.", <switching: "Try again in a minute."; moving: "Finish the move on the key page: <keysUrl>?repo=<repo>">)`. A move clears itself when a snapshot of `repo` shows a marker signed by `k` with the move's `repoId` (the rename is done).
- Repo encrypted: `MEMORY.md` changes go through `namesOnlyIndex`.
- `enabled`:
  - no key ring: throw `OpError("write_rejected", "<repo> is an encrypted memory repo and this memory server doesn't support encryption. Not saved.", "Ask the memory server's operator to turn on encryption, or use one that has it.")`
  - key not ok: throw `keyRequired`
  - otherwise each memory change with content is sealed at `prefix + path` with the repo ID. Nothing else is touched (no auto-sealing of outside files).
- Not `enabled`: memory changes are written as given.
- A commit of only deletes plus `MEMORY.md` never needs the key.

- [ ] **Step 1: Write the failing tests** (FakeStore inner, real `KeyRing` on `env.OAUTH_KV`):
  - **Round trip:** with the key registered and a signed `enabled: true` marker, a save is stored sealed and reads back as plaintext.
  - **`no plaintext reaches GitHub or the cache`:** after saving `quiet harbor` / `tide tables`, no file text (including `MEMORY.md`) and no commit message contains either. With a `GitHubStore` inner over mocked fetch and `env.CACHE_KV`, neither does the cached `snap:v3:` value.
  - **`deleted or unsigned marker keeps the repo encrypted`:** with `rec` set, (a) deleting the marker, (b) replacing it with an unsigned `enabled: false`, and (c) changing `repo_id` each give `markerProblem: true`, a sealed save, and a names-only `MEMORY.md`. With no key, the save rejects `key_required` (never plaintext). With no `rec` but a sealed file present, deleting the marker still blocks plaintext saves.
  - **Legit stop:** a marker signed `enabled: false` → new saves plaintext, `rec.enabled` updated to false, earlier sealed files still sealed, `MEMORY.md` still names-only.
  - **`mismatched key is treated as missing`:** `key: "mismatch"`, files locked, save `key_required`, no commit.
  - **Missing key:** names listed, save `key_required`, delete succeeds.
  - **No key ring:** `key: "unsupported"`, save `write_rejected`, no commit.
  - **`tampered file is unreadable, others still load`.**
  - **Outside files:** with `enabled`, a hand-added plaintext `memories/b.md` comes back `outside: true` and stays plaintext through an unrelated save. Saving `b` itself seals it.
  - **`saves wait while switching`** and **`saves wait while moving`:** reject `unavailable` with the right action; no commit. A move clears once the signed marker with its `repoId` appears.
  - **No marker, no record, no sealed files:** identical behavior to the inner store.
- [ ] **Step 2: Run** `npx vitest run test/encrypting-store.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(store): EncryptingStore seals and opens memory files`

### Task 6: Tools, health lines and wiring

**Files:**
- Modify: `src/operations.ts` (`entries`, `flaggedNames`, `readMemories`, `searchMemories`, `getIndexVersioned`)
- Modify: `src/tools.ts` (`ToolDeps.keysUrl: string`; `encrypted="true"` on `<memory-index` for encrypted scopes; `gather` pushes encryption checks; `memory_save` description gains: "In a scope marked encrypted, choose names that don't give away the content: names stay readable.")
- Modify: `src/health.ts` (`encryptionChecks`), `src/instructions.ts` (retryable list), `src/mcp-api.ts` (build `EncryptingStore`)
- Test: `test/operations.test.ts`, `test/tools.test.ts`, `test/health.test.ts`, `test/wiring.test.ts`

**Interfaces:**
- Consumes: Task 5.
- Produces:
  - `IndexResult.encryption?: EncryptionStatus`
  - Index entry text: locked → `(encrypted; key not registered)`; outside → `(unencrypted, added outside the memory tool) <description>`
  - `encryptionChecks(t: Target, repo: string, s: EncryptionStatus, keysUrl: string): Check[]`. Check name `encryption:<scopeLabel>`. Several lines can apply:

| Condition | Status | Detail | Action |
|---|---|---|---|
| `markerProblem` | fail | `encrypted, but the encryption marker is missing or not signed` | `Someone may have tried to turn encryption off. Saves stay encrypted. Review recent commits: https://github.com/<repo>/commits` |
| key `unsupported` | fail | `encrypted repo, but this memory server doesn't support encryption` | `Ask the memory server's operator to turn on encryption.` |
| key `missing` | warn | `encrypted, key not registered` | `Register the key from your password manager: <keysUrl>?repo=<repo>. Saves are queued until then.` |
| key `mismatch` | warn | `encrypted, the registered key doesn't match (rotated?)` | same as missing |
| `outside > 0` | warn | `encrypted, N memories unencrypted, added outside the memory tool` | `Review them; saving one through Claude encrypts it.` |
| `!enabled && sealed > 0` | warn | `encryption off, N memories still encrypted` | `Turn it back on at <keysUrl>?repo=<repo>, or decrypt the repo with memcrypt (docs/ENCRYPTION.md).` |
| `enabled`, key ok, no problems | ok | `encrypted` | none |

- [ ] **Step 1: Write the failing tests:**
  - An encrypted scope's index tag has `encrypted="true"`; Health has `✓ encryption:general — encrypted`; entries show decrypted descriptions.
  - Key missing: entries read `(encrypted; key not registered)`. `memory_read` returns `error="key_required"` with the link. `memory_search` lists `✗ general — key_required: …`.
  - `memory_save` returns `error: "key_required"`, `retryable: true`.
  - An outside file is listed with the prefix, and the warn line appears.
  - Each table row (health.test.ts).
  - `INSTRUCTIONS` contains `unavailable, reauth_required, server_limit, key_required`, and `instructionsFor` with 30 clients stays ≤ `MAX_INSTRUCTIONS`.
  - Wiring: `mcpApi` builds `EncryptingStore` (null key ring without the secret) with `keysUrl = PUBLIC_URL + "/keys"`.
- [ ] **Step 2: Run** `npx vitest run test/operations.test.ts test/tools.test.ts test/health.test.ts test/wiring.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Locked files are listed but not searched, are skipped by the personal audit, and their `version` still works for update and delete.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(tools): encrypted scopes in index, read, search and health`

### Task 7: Switch-on core: fresh repo and in-place squash

**Files:**
- Modify: `src/store.ts` (`GitHubStore.readTree`, `GitHubStore.extraRefs`, `GitHubStore.replaceHistory`, `GitHubStore.writeFirstCommit`)
- Create: `src/switch-on.ts`
- Test: `test/store.test.ts`, `test/switch-on.test.ts`

**Interfaces:**
- Produces:
  - `interface TreeFile { path: string; mode: string; sha: string; text: string | null }`. `text` only for memory files, `MEMORY.md` files and the marker; null if unreadable.
  - `GitHubStore.readTree(repo): Promise<{ head: string | null; branch: string; isPrivate: boolean; files: TreeFile[] }>`
  - `GitHubStore.extraRefs(repo): Promise<{ branches: number; tags: number; pulls: number }>`: counts other branches, tags, and pull requests in any state
  - `GitHubStore.replaceHistory(repo, expectedHead, files: { path; mode; sha?; content? }[], message)`:
    - creates the tree (no `base_tree`) and a root commit (`parents: []`)
    - re-reads the ref and throws `OpError("unavailable", "The memory repo changed during switch-on; nothing was changed.", "Try again.")` if it moved
    - `PATCH`es with `force: true`
    - 409/422 → `write_rejected`, naming the force-push rule
  - `GitHubStore.writeFirstCommit(repo, files, message)`: for an empty repo only. Creates a placeholder with the contents API (the Git Data API can't write to an empty repo), then a root commit with `files`, then force-moves the branch to it. Refuses with `invalid` if the repo isn't empty.
  - `planEncryptedTree(files: TreeFile[], key: RepoKey, existing: Marker | null): Promise<{ files: { path; mode; sha?; content? }[]; marker: Marker }>`:
    - seals every plaintext memory file at the root and under `projects/*/`
    - keeps already-sealed files only if they open with `key` (else `OpError("invalid", "That key doesn't match this repo.")`)
    - writes every `MEMORY.md` names-only and the signed marker (`repoId` kept from `existing`, else new)
    - keeps other files by SHA and mode
    - aborts with `write_rejected` listing unreadable memory files
  - `switchOnInPlace(store, keys: KeyRing, cache: KVNamespace, repo, key, login): Promise<{ url: string }>`:
    - refuses non-private (`repo_public`) and any `extraRefs` > 0 (`invalid`, naming what to delete; pull requests can't be deleted, so suggest the fresh-repo path)
    - `setSwitching` → plan → `replaceHistory` → `putRecord({ repoId, keyId, enabled: true })` → `put` key → delete `CACHE_KV` keys with prefix `snap:v3:<repo>:` → `clearSwitching` (in `finally`)
    - message `encrypt: switch on, history squashed` + trailers
  - `switchOnFresh(store, keys, repo, newRepo, key, login): Promise<{ url: string }>`:
    - `newRepo` must be private, reachable, writable and empty, and different from `repo`
    - plan from `repo`'s tree; `writeFirstCommit(newRepo, …)` with message `encrypt: fresh encrypted copy of <repo>` + trailers
    - `setMove(repo, newRepo, repoId)`, `putRecord(repo, …)`, and `put` the key under `repo` (the final name after the rename)

- [ ] **Step 1: Write the failing tests** (mocked fetch):
  - In place: no `base_tree`, `parents: []`, `force: true`. Memory files at root and `projects/billing/` are sealed; `README.md` keeps its SHA and mode. Both `MEMORY.md` are names-only. The marker is signed.
  - **`aborts when the ref moved`:** no PATCH, switching flag cleared.
  - An extra branch, tag or pull request → `invalid` before any write. A 422 on PATCH → `write_rejected`.
  - An unreadable memory blob aborts before any POST.
  - Snapshot cache keys for the repo are deleted after success.
  - Fresh: a non-empty target → `invalid`. Success writes one root commit to `newRepo`, sets the move, the record and the key under the old name, and leaves `repo` itself untouched.
  - Re-enable (signed `enabled: false` marker, some sealed files) keeps `repoId` and the sealed files.
- [ ] **Step 2: Run** `npx vitest run test/store.test.ts test/switch-on.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(switch-on): fresh-repo move and in-place squash`

### Task 8: Key page sign-in, session and hardening

**Files:**
- Create: `src/key-page.ts`
- Modify: `src/github-auth.ts` (`exchangeCode(env, code, verifier, redirectUri = \`${env.PUBLIC_URL}/callback\`)`)
- Modify: `src/index.ts` (route `/keys` and `/keys/*` to `keyPage`; rate-limit `GET /keys/login`, `GET /keys/callback` and every `/keys` POST with `AUTH_RATE_LIMIT`)
- Test: `test/key-page.test.ts`

**Interfaces:**
- Consumes: `isAllowedUser`, `s256`, `esc`, `KeyRing` (incl. `wrapText`/`unwrapText`), `REPO_RE` (export it from `src/scopes.ts`).
- Produces:
  - `keyPage.fetch(req, env): Promise<Response>`
  - Session `keysession:<id>` (TTL 3600) = `{ login, id, csrf, token: wrapText(ghToken, "keysession-v1\n<id>") }`. Cookie `__Host-keys=<id>; Path=/; Secure; HttpOnly; SameSite=Strict`.
  - `requireSession(req, env): Promise<KeySession | Response>`
  - Every POST checks the form's `csrf` against the session's, else 403.
  - Every response carries `Cache-Control: no-store`, `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer`.

**Behavior:**
- Without `MEMORY_MASTER_KEY`: every route says encryption isn't turned on for this memory server.
- `GET /keys/login`:
  - PKCE; `redirect_uri = PUBLIC_URL + "/keys/callback"`
  - random `state`; KV `keystate:<state>` = `{ verifier, repo }` (TTL 600)
  - a pre-login cookie `__Host-keys-login=<state>; Path=/; Secure; HttpOnly; SameSite=Lax`
  - `repo` (from `?repo=`) is kept only if it matches `REPO_RE`
- `GET /keys/callback`:
  - the `state` must match the pre-login cookie and be one-time
  - exchange, `GET /user`, `isAllowedUser` (else the "isn't on this memory server" page)
  - create the session; clear the pre-login cookie
  - 302 to the fixed path `/keys`, plus `?repo=<validated repo>`
- `GET /keys`: the user's memory repos (unique values in their `SCOPES` entry) that are reachable and writable, each with its state and action forms (Task 9). Key inputs carry `autocomplete="off"`.

- [ ] **Step 1: Write the failing tests:**
  - No secret → the "not turned on" page.
  - No session → 302 to `/keys/login`.
  - The login redirect has S256, the right `redirect_uri`, and sets the pre-login cookie.
  - A callback without the matching pre-login cookie → 400. A replayed `state` → 400.
  - A non-allowlisted login → 403.
  - Success sets `__Host-keys` with HttpOnly, Secure, SameSite=Strict, and the stored session's `token` isn't the raw token.
  - Security headers are present on every route.
  - `?repo=<script>` is dropped.
  - The repo list for `dav` (mocked GitHub).
  - A POST with a bad `csrf` → 403.
- [ ] **Step 2: Run** `npx vitest run test/key-page.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Style follows `consentPage`: minimal inline CSS, no external resources, `esc` on all user text.
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(keys): key page sign-in, session and hardening`

### Task 9: Key page actions

**Files:**
- Modify: `src/key-page.ts`
- Test: `test/key-page.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 7, 2.
- Produces:
  - `mayChangeEncryption(perms: { push?: boolean; admin?: boolean }): boolean`. Returns `perms.admin === true`. The permissions come from the installation repository list (`permissions.admin`), already fetched by `scopeReachabilityDetailed`; add `admin` to its `InstRepo` type and to `ScopeReach` as `admin: boolean`.
  - Routes (all POST, CSRF-checked, `repo` must be in the user's `SCOPES` and writable; turn-on, confirm and stop also need `mayChangeEncryption`):

| Route | Fields | Effect |
|---|---|---|
| `/keys/turn-on` | `repo` | Not encrypted: generate a key, store it via `wrapText` in `keypending:<session>:<repo>` (TTL 900), show it once with "save this in your password manager now". Signed `enabled: false` marker: ask for the existing key instead. Then show the path choice (fresh repo, recommended; or in place) and that path's warning. |
| `/keys/turn-on/confirm` | `repo`, `key`, `confirm_repo`, `path` (`fresh`\|`in-place`), `new_repo` (fresh only) | `key` equals the pending key (new) or matches the marker's key ID (re-enable). `confirm_repo` equals `repo` (case-insensitive). Then `switchOnFresh` or `switchOnInPlace`. Fresh: show the remaining steps (delete `<repo>`, rename `<new_repo>` to `<repo>`); GitHub keeps a deleted repo restorable by its owner for 90 days. In place: show the commit link and the purge request link. Any failure: the message, nothing changed. |
| `/keys/register` | `repo`, `key` | `key.id` must equal the repo's key ID from the marker or record (else "This isn't the key for <repo>."). If the marker is signed by it and the record differs, update the record. Then `put`. |
| `/keys/remove` | `repo`, `key` | The key must match the repo's key ID; then `remove`. |
| `/keys/stop` | `repo`, `key` | The key must match. Commit a marker signed with `enabled: false` (`GitHubStore.commit`, prefix `""`, message `encrypt: stop encrypting new saves` + trailers), update the record. Then say existing memories stay encrypted and decrypting is `memcrypt decrypt`. |

**Fixed warning copy:**
- In place: "Turning on encryption replaces this repo's whole history with a single commit. Past changes and their log are gone. The old commits stay readable through the repo's activity log by anyone with read access until GitHub Support purges them: request that at https://support.github.com/request after this finishes. Clones and forks made before now keep the old plaintext. A rule that blocks force pushes on the branch must be lifted first. Without this key your memories can't be read: keep it in your password manager. To continue, paste the key back and type the repo name."
- Fresh: "Your encrypted memories will be written to a new, empty private repo. Then you delete this repo and rename the new one to this name. Until you do, saves wait. Deleting is what removes the old plaintext; clones and forks made before now keep it. Without this key your memories can't be read: keep it in your password manager. To continue, paste the key back and type the repo name."

- [ ] **Step 1: Write the failing tests:**
  - Turn-on in place: the key shown once; confirm → sealed tree, forced PATCH, key and record stored.
  - Turn-on fresh: confirm → writes to `new_repo` only, sets the move, and the response lists the rename steps.
  - A wrong pasted key, wrong `confirm_repo`, expired pending key, or non-empty `new_repo` → an error and no GitHub writes.
  - The generated key never appears in a header or URL.
  - Register or remove with a non-matching key is refused. Stop without the key → refused; with it → a signed `enabled: false` marker committed.
  - A repo not in `SCOPES` → 403.
  - A user with write but not admin: turn-on, confirm and stop → 403 with "Only an admin of <repo> can turn encryption on or off." Register and remove still work.
  - `mayChangeEncryption({ push: true })` is false; `{ push: true, admin: true }` is true.
- [ ] **Step 2: Run** `npx vitest run test/key-page.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm test && npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(keys): turn on, register, remove and stop from the key page`

### Task 10: Python crypto core, pinned dependency, shared vectors

**Files:**
- Create: `kit/requirements-crypt.in` (`cryptography==<version>`), `kit/requirements-crypt.txt` (generated with hashes)
- Create: `kit/memory_kit/crypt.py`
- Modify: `.github/workflows/test.yml` (new `crypt` job)
- Test: `test/local/test_crypt.py`

**Interfaces:**
- Produces, in `memory_kit.crypt` (mirroring Tasks 1–2, same names in snake_case):
  - `generate_key_text()`
  - `parse_key_text(text) -> RepoKey`, with `RepoKey(file_key: bytes, mac_key: bytes, id: str)`
  - `seal(file_key, plaintext, aad, iv=None)`
  - `open_sealed(file_key, sealed, aad)`, raising `DecryptError`
  - `hmac_hex(mac_key, message)`
  - `new_repo_id()`
  - `parse_marker`, `sign_marker`, `marker_signed_by`, `serialize_marker`
  - `is_encrypted_file`, `seal_memory_file`, `open_memory_file`
  - `names_only_index`
  - `MARKER_PATH`
  - `cryptography` (AESGCM, HKDF) is imported inside the functions. Without it they raise `RuntimeError` naming `python3 -m pip install --require-hashes --only-binary :all: -r kit/requirements-crypt.txt`.

- [ ] **Step 1: Pin.**
  - Pick the newest `cryptography` release that is at least two weeks old and supports Python 3.9.
  - Generate `kit/requirements-crypt.txt` with `python3 -m piptools compile --generate-hashes --output-file kit/requirements-crypt.txt kit/requirements-crypt.in` (pip-tools in a throwaway venv). Every line, transitive ones included, must be `==` with `--hash`.
  - Verify: `python3 -m pip install --require-hashes --only-binary :all: -r kit/requirements-crypt.txt` in a fresh venv. Expected: installs.
- [ ] **Step 2: Write the failing tests** (`skipUnless` cryptography):
  - Every vector matches (`id`, `sealed`, `open`, `mac`).
  - Seal/open and sign/verify round-trip; a wrong path → `DecryptError`.
  - `names_only_index` equals the TS output for the Task 2 example.
  - An unskipped test: the import works without cryptography, and `seal` then raises `RuntimeError` mentioning `--only-binary`.
- [ ] **Step 3: Run** `python3 -m unittest test.local.test_crypt` (venv). Expected: FAIL.
- [ ] **Step 4: Implement.**
- [ ] **Step 5: Add the CI job** `crypt` (Python `3.9` and `3.x`, ubuntu-latest, `actions/*` pinned by SHA as in the existing jobs): install with `--require-hashes --only-binary :all:`, then `python3 -m unittest discover -s test/local -p 'test_*crypt*.py'`.
- [ ] **Step 6: Run** `npm run test:local` (crypt tests skip) and the crypt tests in the venv. Expected: PASS both.
- [ ] **Step 7: Commit** `feat(kit): pinned cryptography and the shared encryption format in Python`

### Task 11: `memcrypt` encrypt / decrypt / rotate

**Files:**
- Create: `kit/memory_kit/memcrypt.py`, `kit/bin/memcrypt.py`
- Test: `test/local/test_memcrypt.py` (git isolated as in `helpers.py`; local bare repos as remotes)

**Interfaces:**
- Consumes: Task 10.
- Produces the CLI `python3 kit/bin/memcrypt.py <cmd> <remote-url> [options]`:
  - It works in a fresh `git clone` inside a `tempfile.mkdtemp()` directory that is deleted in a `finally` block, never in the user's own clone.
  - Key input, in order:
    - `--key-op <op://…>` (runs `op read`)
    - `--key-env <VAR>`
    - otherwise a `getpass` prompt
  - `rotate` takes its new key from `--new-key-env <VAR>`; without it a new key is generated.
  - Key variables are removed from the environment passed to every `git` subprocess.
  - Confirmation: type `owner/repo` interactively, or pass `--confirm <owner/repo>` (scripts, tests).
  - A generated key is printed once, then must be pasted back (or given via `--confirm-key-env <VAR>`).
  - Path: `--to <new-remote-url>` (fresh repo, must be empty) or `--in-place`. Interactive runs ask, recommending fresh.

| Command | Behavior |
|---|---|
| `encrypt` | Refuses an already-encrypted repo ("use rotate"). For `--in-place`, refuses extra branches or tags (`git ls-remote`). Seals plaintext memories (keeping sealed ones that open with the key), writes names-only `MEMORY.md`s and a signed marker, then warns (same copy as Task 9) and confirms. In place: orphan commit, then `git push --force-with-lease=<branch>:<old head>`. Fresh: push to `--to`, then print the delete-and-rename steps. Trailers as in the format table. |
| `decrypt` | Needs the key. Warns that plaintext goes back into history, then confirms. Opens every sealed file and writes a marker signed with `enabled: false`. One normal commit `encrypt: decrypt all`, normal push. Then: "Register this key on the key page once more so the memory tool sees the change, or remove it." |
| `rotate` | The old key must sign the current marker. Re-seals every sealed memory with the new key and signs a new marker. Asks: fresh repo, squash in place, or a normal commit (old-key ciphertext stays in history). Ends with "Register the new key: <server>/keys?repo=<repo>" (`--server`). |

- [ ] **Step 1: Write the failing tests:**
  - `encrypt --in-place`: origin has one parentless commit, every memory file matches the regex, and no reachable object holds a plaintext description (`git rev-list --objects --all` plus `cat-file`). The marker verifies.
  - `encrypt --to <empty bare>`: the new remote holds the encrypted commit, and the old one is untouched.
  - In place, against a moved origin → the push fails and origin is unchanged.
  - A wrong `--confirm` aborts. An already-encrypted repo exits non-zero with "use rotate".
  - The temp directory is gone afterwards (success and failure).
  - The key variable isn't in the environment `git` receives (record it with a `GIT_SSH_COMMAND`-free fake `git` on `PATH`, or by inspecting the `subprocess.run` calls).
  - `decrypt` restores the exact original bytes and writes a signed `enabled: false` marker.
  - `rotate` gives files that open with the new key only and a marker signed by it.
  - Files produced by the TS side (vectors) open.
- [ ] **Step 2: Run** `python3 -m unittest test.local.test_memcrypt` (venv). Expected: FAIL.
- [ ] **Step 3: Implement** with `subprocess.run([...], check=True, env=<scrubbed>)`, list arguments, never a shell.
- [ ] **Step 4: Run** the crypt tests plus `npm run test:local`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kit): memcrypt encrypt, decrypt and rotate`

### Task 12: Kit: names-only snapshot, routing rule, versions

**Files:**
- Modify: `kit/memory_kit/snapshot.py` (`snapshot_from_tool_use` strips descriptions in encrypted index blocks)
- Modify: `kit/templates/routing-rule.md` (Outbox and Flushing bullets)
- Modify: `kit/memory_kit/__init__.py` (`HOOK_VERSION = "0.1.5"`), `wrangler.jsonc` (`WORKER_VERSION`, `MIN_HOOK_VERSION` → `0.1.5`, both envs)
- Test: `test/local/test_snapshot.py`, `test/local/test_setup.py`, plus `test/config.test.ts` if it pins versions

**Interfaces:**
- Produces: `names_only_encrypted(text: str) -> str` in `snapshot.py`. Inside each `<memory-index …>` block whose opening tag has `encrypted="true"`, lines matching the names-only regex lose their ` — …` tail.

**Rule text:**
- Outbox: the retryable list becomes `` (`unavailable`, `reauth_required`, `server_limit`, `key_required`) ``.
- Flushing, last sentence: "On `key_required`, keep that entry and continue with the next one (its repo's key isn't registered yet); on any other retryable error, keep the entry and stop flushing."

- [ ] **Step 1: Write the failing tests:**
  - An encrypted general block (`- [a](memories/a.md) — quiet harbor`) is stored as `- [a](memories/a.md)`, while a plain project block keeps its descriptions.
  - The installed rule has both changes.
- [ ] **Step 2: Run** `npm run test:local`. Expected: FAIL.
- [ ] **Step 3: Implement** and bump the versions.
- [ ] **Step 4: Run** `npm run test:local && npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(kit): names-only snapshot for encrypted scopes; key_required in the outbox rule`

### Task 13: Docs

**Files:**
- Create: `docs/ENCRYPTION.md`
- Modify: `README.md`, `docs/THREAT-MODEL.md`, `docs/DECISIONS.md`, `docs/FAQ.md`, `docs/QUICKSTART.md`, `docs/QUICKSTART-FRIEND.md`

**Content each must carry:**
- `ENCRYPTION.md` (for repo owners):
  - precondition: a password manager
  - the spec's trust table, verbatim, including "the local machine is inside the trusted boundary"
  - what encryption doesn't detect (rollback, deletion)
  - both switch-on paths and why fresh is recommended; the activity-log fact and the purge request link; the 90-day restore window of a deleted repo
  - registering, the TTL, removing, stopping (needs the key)
  - outside-added files and how they're marked
  - choosing names that don't give away content
  - installing `memcrypt` (venv + `--require-hashes --only-binary :all:`) and its three commands; never run it through Claude
  - what happens when the key is missing (queued saves)
  - leaving a host
  - an encrypted repo needs a memory server with this feature
- `QUICKSTART.md` (operator):
  - `openssl rand -base64 32 | npx wrangler secret put MEMORY_MASTER_KEY [--env production]`
  - back up the master key in a password manager
  - add `<PUBLIC_URL>/keys/callback` to the GitHub App's callback URLs
  - optional `REPO_KEY_TTL_SECONDS`
  - bump `wrangler.local.jsonc` versions to 0.1.5
  - re-run `./setup.sh` on each machine
- `README.md`: "Plain Markdown in your repos", unless you turn on encryption (link).
- `THREAT-MODEL.md`: a new section with the trust table, the residual copies, the marker-signing control, rollback and deletion, and that the host can read while a key is registered.
- `DECISIONS.md`: Worker-side; owner-held key; per repo; names readable; fresh repo over squash; signed marker and record; no auto-sealing; `cryptography` pinned.
- `FAQ.md` "Who can see my memories?": add the encrypted case.
- `QUICKSTART-FRIEND.md` "What your host can see": encryption protects from GitHub, not from the host.

- [ ] **Step 1: Write the docs** in the existing voice, saying "memory tool" rather than "server" where the operator isn't meant.
- [ ] **Step 2: Check** names agree: `grep -n "MEMORY_MASTER_KEY\|REPO_KEY_TTL_SECONDS\|keys/callback\|requirements-crypt\|only-binary" -r docs src kit .github`. Expected: consistent.
- [ ] **Step 3: Commit** `docs: encryption at rest`

### Task 14: Staging verification (with the user)

Run by the user with the implementer, against staging and throwaway test repos.

- [x] **Step 1:** Set the staging master key, add the callback URL to the staging GitHub App, run `npm run deploy:staging`.
- [x] **Step 2: Fresh-repo path.** Turn on encryption for a test repo. Saves wait (queued) until the delete and rename; afterwards health shows `✓ encryption:… — encrypted` and save, read and search work in claude.ai and Claude Code.
- [x] **Step 3: In-place path** on a second test repo. Confirm one commit and names-only `MEMORY.md` on github.com, and that the activity log shows the force push (it matches the warning).
- [x] **Step 4: Tamper.** Delete the marker on github.com. Health shows the ✗ line, and a save stays encrypted.
- [x] **Step 5: Key lifecycle.** Remove the key: a save in Claude Code queues with `key_required`. Register it again: the next session flushes. `memcrypt rotate`, then register the new key. `memcrypt decrypt`, then register. Health is clean after each.
- [x] **Step 6:** Record the results under a "Staging results" heading in this plan and commit.

## Staging results

Run 2026-10-21 on `claude-memory-staging` (0.1.5) with `davlion/throwaway_1` (personal; in place) and `davlion-test-client/throwaway_2` (org; fresh repo `claude-memory-enc`), seeded with 4 general + 2 project memories (one non-ASCII, one ~8 KB). Checks via the staging connector from Claude Code and on github.com.

| Step | Result |
|---|---|
| 1 Setup | ✓ after two fixes found here: **S1** `Referrer-Policy: no-referrer` made browsers send `Origin: null`, so every key-page POST was refused (`53ee1ee`, now `same-origin`); **S2** `/pulls` needs a permission the app doesn't have, so in-place switch-on failed with "Resource not accessible by integration" (`0c3f081`, pull refs via `git/matching-refs/pull/`). Also a bad first master key (clipboard), caught by the key page's misconfiguration message |
| 2 Fresh repo | ✓ one-commit sealed copy; a save during the move refused `unavailable` with the finish/cancel link, nothing written to the old repo; after delete + rename health ✓, retried save sealed, read exact, search finds body text |
| 3 In place | ✓ one root commit, all files sealed, names-only `MEMORY.md` (root and project), force push in the activity log, health ✓, read/search/save work |
| 4 Tamper | ✓ marker deleted → ✗ marker line; save still sealed with the same key; marker restored from history → ✓ |
| 5 Key lifecycle | ✓ remove → index locked, read/save `key_required`; register → saves work. `memcrypt rotate --in-place`: a save landing while memcrypt waited at its prompt made the force-with-lease push fail ("stale info"), nothing lost; rerun → one commit under the new key, health ⚠ rotated, old key refused, new key accepted. `memcrypt decrypt` → plaintext, record stays on (✗) until an admin registers; registered → encryption off, plaintext save, index rebuilt |
| Not tested | outbox flush after `key_required`: the outbox replays through the production connector, so staging saves weren't queued |

Follow-ups found in the run:
- **F1** during a move, the old repo's plaintext memories are labelled "unencrypted, added outside the memory tool", with an extra ⚠ health line; suppress both while moving.
- **F2** memcrypt: the hidden "Paste the key back:" prompt is easy to miss under the long warning; mark the steps and end with a clear "Done" line.
- **F3** memcrypt: the new key is shown before the push; when the push fails, say the new key was NOT applied and to discard it.
- **F4** after a rotate, health shows two ⚠ lines for one cause, and `key_required` says "isn't registered" when an old key is; merge into one "the key was changed" message.
- **F5** after `memcrypt decrypt`, the ✗ line says "missing or not signed" for a signed `enabled: false` marker, and the ⚠ line calls the memories "added outside the memory tool"; give this state its own wording. `MEMORY.md` stays names-only until the next save rebuilds it.
- **F6 (bug)** after `memcrypt decrypt` with the key still registered, the key page offers only **Remove key**, so the documented "register the key" step is impossible; offer admins "Confirm decryption (turn encryption off)".
- **W1** the key page shows no progress while switch-on runs; show an "Encrypting…" state with progress.
- **W2** the Worker's `/` is a bare 404, so the Cloudflare dashboard's Visit link dead-ends; serve a landing page linking to `/keys`.

### Staging re-check (after the staging and security fixes)

Run 2026-10-22 on `claude-memory-staging` with the branch at `17ff687`.

| Check | Result |
|---|---|
| Landing page `/` (W2) | ✓ text, key-page link, CSP with `base-uri 'none'`; unknown paths 404 |
| Turn back on, in place, with progress (W1) | ✓ switched on; progress lines arrived but too fast on a 15-file repo to tell streamed from buffered — not distinguishable at this size |
| `memcrypt decrypt` prompts and Done line (F2) | ✓ |
| Health after decrypt (F5) | ✓ `✗ … decrypted outside the memory tool (the signed marker says off)` and `⚠ … N memories unencrypted → … see the line above` |
| Confirm decryption (F6, C-I1) | ✓ admin action, "Encryption is off …", plaintext save after |
| Planted fake encrypted file in a repo never seen (C-I3) | ✓ locks the repo (`key_required`); after removing the file, admin **Forget encryption** unlocks it; plaintext save after |
| `memcrypt rotate --commit` (F2, F4) | ✓ numbered prompts, Done line; health shows the single "key was changed" line; read error names a different key; admin registers the new key |
| Non-admin checks (W-I-1, D-I1) | not run: no second GitHub account. Relies on GitHub's documented `permissions.admin`; missing data fails closed |

Found in the re-check:
- **F7** with the record off, a planted encrypted file and no marker, the ✗ marker line still says "Saves stay encrypted" while saves go plaintext.
- **F8** (likely pre-existing) a repo whose last file was deleted reads as `not_reachable: Not Found` with the app-installation hint (GitHub 404s the empty tree).
- **F9** after registering a key, the memory tool kept the old key for several minutes (KV propagation between the browser's and Anthropic's Cloudflare locations); the page and docs promise immediate / about a minute.
