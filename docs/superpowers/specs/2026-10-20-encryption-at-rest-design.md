# Encryption at rest for memory repos — design

**Date:** 2026-10-20
**Status:** approved 2026-10-20; revised the same day after a security review (see "Security review changes"), with the user's decisions on switch-on paths, outside-added files and admin control.
**Origin:** a friend asked whether memories could be kept out of plaintext. The friend has sensitive family information from several countries (which this tool already refuses to store: personal facts go to claude.ai memory) and a personal software project that may become commercial (which is exactly what `project` memories hold).

## Intent

Let a memory repo's owner keep the text of their memories unreadable to GitHub and to anyone who gets the repo: a leaked token, a stray clone, a GitHub breach, an accidental visibility change. The owner holds the key in their password manager, so it is never lost and moves with them from one server to another.

It must not make daily use worse. The user starts and stops Claude sessions all day; no session ever asks for a key.

## Trust boundary (state this plainly in the docs)

| Who | Sees plaintext? |
|---|---|
| GitHub, and anyone with the repo or a clone of it | **No**, for memories saved after switch-on. Memories that existed before switch-on: no after a move to a fresh repo; after an in-place squash, still readable through the repo's activity log by anyone with read access until GitHub Support purges the old commits. Clones and forks made before switch-on keep the old plaintext either way |
| The server operator and Cloudflare | Yes. The server must decrypt to answer Claude, so while a repo is in use its key is on the server |
| Anthropic | Yes. Claude has to read the memory |
| The user's own machines (transcripts, outbox) | Yes. **The local machine is inside the trusted boundary.** Only the session-start snapshot is reduced (names only) |

A friend using someone else's server is still trusting that host, exactly as `QUICKSTART-FRIEND.md` says today. Encryption doesn't change that; running your own server does.

Encryption protects each memory file, not the repo as a whole. Someone with write access can still delete memories, or put back an older encrypted version of one, without that being detected. The docs say so.

## Goals

- Optional, and controlled at two levels: the **server operator** enables the feature on a server; the **repo owner** enables it per memory repo.
- One key per memory repo. It covers every set in that repo: `general` or the client set, and every `projects/<repo>/` set inside it.
- The key lives in a password manager. Having one (1Password or similar) is a stated precondition. Sharing a repo's key (through the password manager's sharing) is how several people get access.
- No per-session prompts. The key is given to the server once and stays until removed, or until an operator-set TTL expires.
- Encrypted: each memory's description, body and type. Readable: memory names (filenames, the encrypted file's `name` line, the names-only `MEMORY.md`, commit messages). In encrypted scopes Claude is asked to choose names that don't give away the content.
- Switch-on encrypts every existing memory and leaves the old plaintext history behind, by one of two paths:
  - **Move to a fresh repo (recommended, the default):** the encrypted memories go into a new, empty private repo as its first commit. The user then deletes the old repo and renames the new one to the old name, so `SCOPES` and the app installation don't change.
  - **Squash in place (fallback):** the repo's history is replaced by a single commit. The old commits remain readable through the activity log until GitHub Support purges them, and the user is told so and given the purge request link.
- Turning encryption off can't happen silently. The marker is signed with the repo key, and the server remembers which repos are encrypted.
- Local commands to encrypt, decrypt and rotate a repo, for testing, hand edits, backup and moving between servers.

## Non-goals

- Protecting memories from the server operator, Cloudflare or Anthropic.
- Protecting local copies other than the snapshot: transcripts are Claude Code's, and the outbox holds what the transcript already holds.
- Preserving the commit history of a repo through switch-on.
- Removing copies the user's own action can't reach: existing clones and forks, and (for the in-place squash) old commits until GitHub Support purges them.
- Encrypted names.
- Detecting rollback or deletion of individual memories.
- Team key management: no per-person keys, no server-side rotation. Early users are individuals and friends.

## Anti-goals (failures even if it "works")

- **A key nobody saved.** Losing the key loses the memories. The flow must prove the key reached the password manager before anything is encrypted.
- **Silent plaintext in an encrypted repo.** A save to an encrypted repo must never be written in plaintext: not because the key is missing, and not because someone deleted or edited the marker.
- **Plaintext in the server's cache** (`CACHE_KV`) for an encrypted repo.
- **Prompting every session**, or anything that makes stopping and starting sessions annoying.
- **Mixed keys in one repo** because a wrong key was pasted.
- **A planted file that looks trustworthy.** An encrypted file is a sign that the memory tool wrote it; the tool must never encrypt a file it didn't save itself.

## How it works

### Operator switch

The feature is on when the Worker has a master key secret (call it `MEMORY_MASTER_KEY`; 256-bit random). Whoever holds it administers encryption on that server. A Worker var `REPO_KEY_TTL_SECONDS` sets how long a registered repo key lasts; unset or `0` means no expiry (the default). Setting `86400` gives a once-a-day paste.

Without the master key, a repo marked encrypted fails reads and saves with a clear "this memory server doesn't support encrypted repos" error. It never writes plaintext.

### The repo's marker

A small file at the repo root (`.claude-memory/encryption.json`) records:
- whether new saves are encrypted (`enabled: true/false`)
- the format version, the repo ID and the key's fingerprint (derived from the key, never the key itself)
- a signature over those fields, computed with a key derived from the repo key

Any server reads it, so the same repo behaves the same everywhere.

The server also keeps its own record of every repo it has seen encrypted (repo ID and key fingerprint, no expiry, kept even after a key is removed or expires). A repo counts as **encrypted** when any of these is true:
- the marker says `enabled: true`
- the server's record exists
- any memory file in it is encrypted

For an encrypted repo, a missing marker, a marker that isn't validly signed, or a changed repo ID is treated as still encrypted: no plaintext saves, the index file stays names-only, and health shows a failure. Only a signed marker with `enabled: false` turns encryption off, so stopping needs the key.

### Repo key

- 256-bit random. Shown as text with a recognizable prefix so it's easy to spot in a password manager.
- Separate keys for encrypting files, the fingerprint and the marker signature are derived from it.
- The server stores it in KV, encrypted under the master key, keyed by repo, with the TTL above.
- Registering checks the pasted key against the marker's fingerprint and refuses a mismatch.

### Key page

A browser page on the Worker, separate from the MCP connection flow:
1. The user signs in with GitHub. They must be on the allowlist and able to reach the repo through the app installation.
2. For a repo that isn't encrypted yet, **"Turn on encryption"**:
   - Generate a key, show it once, and ask the user to paste it back (proof it was saved).
   - Choose the path: **move to a fresh repo** (recommended) or **squash in place**.
   - **Warn** with the truth for that path. For the fresh repo: the steps and that the old repo must be deleted. For the squash: history replaced, the old commits stay readable through the activity log until GitHub Support purges them (with the request link), and existing clones and forks keep the old plaintext. A rule that blocks force pushes on the branch has to be lifted for the squash.
   - **Ask:** an explicit confirmation (typing the repo name).
   - **Fresh repo:** the user creates an empty private repo and adds it to the app installation. The page writes one commit there with every memory encrypted, plus the signed marker, and registers the key. It then shows the remaining steps: delete the old repo, rename the new one to the old name.
   - **Squash:** build one new root commit holding every file, with every memory encrypted, plus the signed marker. Force-move the branch to it, register the key. The page refuses if the repo has other branches, tags or pull requests (they would keep the plaintext reachable). If branch protection refuses the force push, it stops with a clear message and changes nothing.
3. For an encrypted repo: paste the key to register it, or paste it to remove it. Removing cuts the server off immediately.
4. **"Stop encrypting new saves"** needs the key, and writes a signed marker with `enabled: false`. Existing memories stay encrypted and still need the key to read. Decrypting everything is a separate, deliberate step: the local command.

The key page is the default way to turn encryption on. The local command is the alternative.

**Who may do what (decided):** turning on, turning back on and stopping need **admin** on the repo. Otherwise a co-writer could rewrite a shared repo's history under a key only they hold and later lock everyone else out. Registering and removing a key need write access and the key. A client's admin turns encryption on for the client's own repo.

### Read and write path

All repo access already goes through the `Store` interface (`src/store.ts`). Encryption fits as a layer between `GitHubStore` and the operations:
- **Read:** the snapshot (from GitHub or `CACHE_KV`) holds ciphertext; files are decrypted in memory after it. The cache therefore only ever holds ciphertext for encrypted repos. Switch-on clears the cached snapshots of that repo.
- **Write:** `memories/*.md` changes, including conflict copies, are encrypted just before commit. For an encrypted repo, `MEMORY.md` in the repo is written names-only; Claude still gets the full index because the server builds it from decrypted files.
- The guard (secrets, personal facts, other clients), search, `findSimilar` and the personal-memory audit all keep running on plaintext, unchanged.
- Each ciphertext is bound (as AES-GCM additional data) to a stable random repo ID stored in the marker, plus the file's path relative to the repo root. Files can't be swapped or moved between repos unnoticed, and renaming or transferring the memory repo still works.
- `version` stays the blob SHA. A fresh IV changes it on every save, which is fine.
- While switch-on runs, saves to that repo answer with a retryable "try again shortly" error, so no save lands mid-switch and is lost.
- Files written in plaintext before switch-on, or after "stop encrypting", are read as plaintext.
- **Plaintext files that appear after switch-on** (hand edits, another tool, a server without this feature) are **not** encrypted automatically. The index marks each one "unencrypted, added outside the memory tool" and health warns. A file becomes encrypted only when it's deliberately saved again through the memory tool.
- A server running code from before this feature ignores the marker and would write plaintext. That's documented, not prevented: an encrypted repo needs a server with this feature.

### When the key isn't on the server

- A new error code (`key_required`) that counts as **retryable**. Its message says the memory can't be saved until the repo's key is registered, with the key page link as the action.
- In Claude Code the save goes to the outbox and replays once the key is back. In claude.ai chat it's "not saved" with the same link.
- Reads and searches of encrypted memories fail with the same code and link. `memory_index` still lists names, marked as needing the key.
- Outbox replay: unlike the other retryable errors, `key_required` doesn't stop the flush. That entry is kept and replay continues with the next one, so one repo without a key doesn't block other scopes.
- The retryable list is spelled out in three places that all need the new code: `src/errors.ts` (`RETRYABLE`), the server instructions (`src/instructions.ts`) and the kit's routing rule (`kit/templates/routing-rule.md`), which is copied into each user's `CLAUDE.md`.

### Health lines

At session start, per scope (user-facing wording avoids "server" where "memory tool" or nothing says it better):
- `✓ scope:general — encrypted`
- `⚠ scope:general — encrypted, key not registered` + key page link
- `⚠ scope:general — encryption off, N memories still encrypted` (the mixed state, where someone may believe they're protected and aren't)
- `⚠ scope:general — encrypted, N memories unencrypted, added outside the memory tool`
- `✗ scope:general — encrypted, but the encryption marker is missing or not signed` (someone may have tried to turn encryption off)
- `✗ … — encrypted repo, but this memory server doesn't support encryption`

Reported once per session like other health problems. No session restart is ever required, and save results don't change.

### Local snapshot

For encrypted scopes the kit's session-start snapshot (`kit/memory_kit/snapshot.py`) stores names only. `memory_index` output must say which scopes are encrypted so the kit can tell. The offline fallback then shows a bare list of names.

### Local commands

`encrypt`, `decrypt` and `rotate` for one memory repo:
- `encrypt`: generate a key or take one, then the same choice, warning and confirmation as the key page. With `--to <new repo>` it pushes into a fresh repo; otherwise it squashes in place.
- `decrypt`: decrypt everything and turn encryption off. The explicit opt-out.
- `rotate`: decrypt with the old key and encrypt with the new one in memory, with no plaintext step in history. The user then registers the new key on the key page. It offers the same choice (fresh repo, squash, or a normal commit that leaves old-key ciphertext in history).
- The key comes from a prompt, an environment variable, or 1Password's CLI (`op read`), never a file in the repo. The key is kept out of the environment of the git commands they run.
- They work in a temporary clone that is deleted afterwards, so no old plaintext lingers in local git objects.
- Don't run them through Claude: the key would end up in the transcript.
- Written in Python using the `cryptography` package, which only these three commands need; the rest of the kit stays standard-library only. The package is **pinned to an exact version with hashes** and installed from wheels only (`pip install --require-hashes --only-binary :all:`), so a hijacked or typo-squatted release can't slip in. Upgrades are deliberate commits.
- They also serve as the test harness for the feature.

## Security review changes (2026-10-20)

A security review of this design and its plan found it mostly sound and led to these changes:
- the marker is signed, and the server remembers encrypted repos, so encryption can't be turned off silently
- switch-on offers a fresh repo (recommended) because an in-place squash leaves old commits reachable through the activity log until GitHub Support purges them
- saves are held during switch-on
- plaintext files that appear later are marked, not auto-encrypted
- separate derived keys for encryption, fingerprint and signature
- key page hardening: the sign-in is tied to the browser, the key page sets security headers and is never cached, and the GitHub token in its session is stored encrypted
- the local commands work in a temporary clone, keep the key out of git's environment, and install wheels only
- cached snapshots are cleared at switch-on
- the docs are honest about rollback and deletion

## Docs to update

README ("plain Markdown in your repos" now has an exception), `THREAT-MODEL.md` (the trust table above, including that the local machine is trusted, and the rollback/deletion limit), `DECISIONS.md`, `FAQ.md` ("Who can see my memories?"), `QUICKSTART.md` (operator: master key, TTL, the key page callback URL), `QUICKSTART-FRIEND.md` (what encryption does and doesn't change for a friend on a host's server), and an "encrypting your memory repo" guide covering the key page, both switch-on paths, the password-manager precondition, stopping and decrypting.

## Testing

Test-first (red, then green), as for the rest of the project. Worker tests run in workerd with GitHub mocked; the kit tests run with Python. The local commands are the way to produce encrypted fixture repos and to check round trips.

## Left to the builder

- Exact names: the master-key secret, the TTL var, the marker path, the error code, the key prefix.
- The ciphertext file layout, as long as the name stays readable and the file is recognizable as encrypted.
- Wording of messages and health lines, within the wording rules above.
