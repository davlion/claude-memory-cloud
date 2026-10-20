# Encryption at rest for memory repos — design

**Date:** 2026-10-20
**Status:** approved 2026-10-20
**Origin:** a friend asked whether memories could be kept out of plaintext. The friend has sensitive family information from several countries (which this tool already refuses to store: personal facts go to claude.ai memory) and a personal software project that may become commercial (which is exactly what `project` memories hold).

## Intent

Let a memory repo's owner keep the text of their memories unreadable to GitHub and to anyone who gets the repo: a leaked token, a stray clone, a GitHub breach, an accidental visibility change. The owner holds the key in their password manager, so it is never lost and moves with them from one server to another.

It must not make daily use worse. The user starts and stops Claude sessions all day; no session ever asks for a key.

## Trust boundary (state this plainly in the docs)

| Who | Sees plaintext? |
|---|---|
| GitHub, and anyone with the repo or a clone of it | **No**, for anything reachable on the branch after switch-on. Clones made before switch-on, and unreachable commits GitHub hasn't purged yet, still hold the old plaintext |
| The server operator and Cloudflare | Yes. The server must decrypt to answer Claude, so while a repo is in use its key is on the server |
| Anthropic | Yes. Claude has to read the memory |
| The user's own machines (transcripts, outbox) | Yes. **The local machine is inside the trusted boundary.** Only the session-start snapshot is reduced (names only) |

A friend using someone else's server is still trusting that host, exactly as `QUICKSTART-FRIEND.md` says today. Encryption doesn't change that; running your own server does.

## Goals

- Optional, and controlled at two levels: the **server operator** enables the feature on a server; the **repo owner** enables it per memory repo.
- One key per memory repo. It covers every set in that repo: `general` or the client set, and every `projects/<repo>/` set inside it.
- The key lives in a password manager. Having one (1Password or similar) is a stated precondition. Sharing a repo's key (through the password manager's sharing) is how several people get access; anyone with the key and access to the repo can register or remove it on a server.
- No per-session prompts. The key is given to the server once and stays until removed, or until an operator-set TTL expires.
- Encrypted: each memory's description, body and type. Readable: memory names (filenames, frontmatter `name`, the names-only `MEMORY.md`, commit messages).
- Switch-on encrypts every existing memory **and replaces the repo's history** with a single squashed commit, so no plaintext memory remains reachable on the branch. Encrypting without removing the history would leave every existing memory readable to anyone with the repo.
- Local commands to encrypt, decrypt and rotate a repo, for testing, hand edits, backup and moving between servers.

## Non-goals

- Protecting memories from the server operator, Cloudflare or Anthropic.
- Protecting local copies other than the snapshot: transcripts are Claude Code's, and the outbox holds what the transcript already holds.
- Preserving the commit history of a repo through switch-on. It's squashed away.
- Removing copies the squash can't reach: existing clones and forks, and unreachable commits GitHub keeps until it garbage-collects them (readable by commit ID; GitHub Support can purge them). The docs say so plainly.
- Encrypted names.
- Team key management: no per-person keys, no server-side rotation. Early users are individuals and friends.

## Anti-goals (failures even if it "works")

- **A key nobody saved.** Losing the key loses the memories. The flow must prove the key reached the password manager before anything is encrypted.
- **Silent plaintext in an encrypted repo.** A save to a repo marked encrypted must never be written in plaintext because the key is missing.
- **Plaintext in the server's cache** (`CACHE_KV`) for an encrypted repo.
- **Prompting every session**, or anything that makes stop/start of sessions annoying.
- **Mixed keys in one repo** because a wrong key was pasted.

## How it works

### Operator switch

The feature is on when the Worker has a master key secret (call it `MEMORY_MASTER_KEY`; 256-bit random). Whoever holds it administers encryption on that server. A Worker var `REPO_KEY_TTL_SECONDS` sets how long a registered repo key lasts; unset or `0` means no expiry (the default). Setting `86400` gives a once-a-day paste.

Without the master key, a repo marked encrypted fails reads and saves with a clear "this server doesn't support encrypted repos" error. It never writes plaintext.

### The repo's marker

A small file at the repo root (e.g. `.claude-memory/encryption.json`) records:
- whether new saves are encrypted (`enabled: true/false`)
- the format version
- the key's fingerprint (derived from the key, never the key itself)

Any server reads it, so the same repo behaves the same everywhere. Anyone with write access can edit it; the health checks below make a flipped switch visible.

### Repo key

- 256-bit random. Shown as text with a recognizable prefix so it's easy to spot in a password manager.
- The server stores it in KV, encrypted under the master key, keyed by repo, with the TTL above.
- Registering checks the pasted key against the marker's fingerprint and refuses a mismatch.

### Key page (on the server)

A browser page on the Worker, separate from the MCP connection flow:
1. The user signs in with GitHub. They must be on the server's allowlist and able to reach the repo through the app installation.
2. For a repo that isn't encrypted yet, **"Turn on encryption"** goes **warn, ask, then squash**:
   - Generate a key, show it once, and ask the user to paste it back (proof it was saved).
   - **Warn:** the repo's whole history will be replaced by one commit; past changes and their log are gone; existing clones and forks keep the old plaintext; GitHub keeps unreachable commits until it purges them.
   - **Ask:** an explicit confirmation (e.g. typing the repo name).
   - **Squash:** build one new root commit holding every file, with every memory encrypted, plus the marker. Force-move the branch to it, register the key. If branch protection refuses the force push, stop with a clear message and change nothing.
3. For an encrypted repo: paste the key to register it, or remove it. Removing cuts the server off immediately.
4. **"Stop encrypting new saves"** sets `enabled: false`. Existing memories stay encrypted and still need the key to read. Decrypting everything is a separate, deliberate step: the local command.

The server page is the default way to turn encryption on. The local command is the alternative.

### Read and write path

All repo access already goes through the `Store` interface (`src/store.ts`). Encryption fits as a layer between `GitHubStore` and the operations:
- **Read:** the snapshot (from GitHub or `CACHE_KV`) holds ciphertext; files are decrypted in memory after it. The cache therefore only ever holds ciphertext for encrypted repos.
- **Write:** `memories/*.md` changes, including conflict copies, are encrypted just before commit. For an encrypted repo, `MEMORY.md` in the repo is written names-only; Claude still gets the full index because the server builds it from decrypted files.
- The guard (secrets, personal facts, other clients), search, `findSimilar` and the personal-memory audit all keep running on plaintext, unchanged.
- Each ciphertext is bound (as AES-GCM additional data) to a stable random repo ID stored in the marker plus the file's path relative to the repo root. Files can't be swapped or moved between repos unnoticed, and renaming or transferring the memory repo still works. *(Builder's call, settled in review.)*
- `version` stays the blob SHA. A fresh IV changes it on every save, which is fine.
- Files written in plaintext before switch-on, or after "stop encrypting", are read as plaintext. A repo can be mixed.
- After switch-on, plaintext memory files can still show up in a repo with `enabled: true`, through hand edits or a server without this feature. The server encrypts them in its next commit to that repo and flags them in health until then. Their plaintext stays in history from that point (no automatic squash); the local `encrypt` command can squash again. *(My call; switch-on itself leaves no plaintext.)*
- A server running code from before this feature ignores the marker and would write plaintext. That's documented, not prevented: an encrypted repo needs a server with this feature. *(Settled in review.)*

### When the key isn't on the server

- A new error code (e.g. `key_required`) that counts as **retryable**. Its message says the memory can't be saved until the repo's key is registered, with the key page link as the action.
- In Claude Code the save goes to the outbox and replays once the key is back. In claude.ai chat it's "not saved" with the same link.
- Reads and searches of encrypted memories fail with the same code and link. `memory_index` still lists names, marked as needing the key.
- Outbox replay: unlike the other retryable errors, `key_required` doesn't stop the flush. That entry is kept and replay continues with the next one, so one repo without a key doesn't block other scopes. *(Settled in review.)*
- The retryable list is spelled out in three places that all need the new code: `src/errors.ts` (`RETRYABLE`), the server instructions (`src/instructions.ts`) and the kit's routing rule (`kit/templates/routing-rule.md`), which is copied into each user's `CLAUDE.md`.

### Health lines

At session start, per scope:
- `✓ scope:general — encrypted`
- `⚠ scope:general — encrypted, key not on server` + key page link
- `⚠ scope:general — encryption off, N memories still encrypted` (the mixed state, where someone may believe they're protected and aren't)
- `⚠ scope:general — encrypted, N memories still in plaintext` (until the server's next commit encrypts them)
- `⚠ … — encrypted repo, but this server doesn't support encryption`

Reported once per session like other health problems. No session restart is ever required, and save results don't change.

### Local snapshot

For encrypted scopes the kit's session-start snapshot (`kit/memory_kit/snapshot.py`) stores names only. `memory_index` output must say which scopes are encrypted so the kit can tell. The offline fallback then shows a bare list of names.

### Local commands

`encrypt`, `decrypt` and `rotate` for one memory repo, working on a local clone:
- `encrypt`: generate a key or take one, then the same warn, ask, squash as the key page (force push of one new root commit with the marker and every memory encrypted).
- `decrypt`: decrypt everything and set `enabled: false`. The explicit opt-out.
- `rotate`: decrypt with the old key and encrypt with the new one in memory, with no plaintext step in history. The user then registers the new key on the key page. It offers the same warn, ask, squash, so old-key ciphertext doesn't stay in history. Declining the squash makes a normal commit, and old commits stay readable with the old key. *(My call: rotation follows the switch-on logic.)*
- The key comes from stdin, an environment variable, or 1Password's CLI (`op read`), never a file in the repo.
- They also serve as the test harness for the feature.
- Written in Python using the `cryptography` package, which only these three commands need; the rest of the kit stays standard-library only. The package is **pinned to an exact version with hashes** (a requirements file installed with `pip install --require-hashes`), so a hijacked or typo-squatted release can't slip in. Upgrades are deliberate commits.

## Docs to update

README ("plain Markdown in your repos" now has an exception), `THREAT-MODEL.md` (the trust table above, including that the local machine is trusted), `DECISIONS.md`, `FAQ.md` ("Who can see my memories?"), `QUICKSTART.md` (operator: master key, TTL), `QUICKSTART-FRIEND.md` (what encryption does and doesn't change for a friend on a host's server), and a short "encrypting your memory repo" section covering the key page, the password-manager precondition, stopping and decrypting.

## Testing

Test-first (red, then green), as for the rest of the project. Worker tests run in workerd with GitHub mocked; the kit tests run with Python. The local commands are the way to produce encrypted fixture repos and to check round trips.

## Left to the builder

- Exact names: the master-key secret, the TTL var, the marker path, the error code, the key prefix.
- The ciphertext file layout, as long as the name stays readable and the file is recognizable as encrypted.
- How the key page keeps its own browser session (sign-in cookie, CSRF protection), within the existing allowlist and rate limits.
- Wording of messages and health lines.
