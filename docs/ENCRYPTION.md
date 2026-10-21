# Encrypting your memory repo

This guide is for the owner of a memory repo who wants the text of their memories kept unreadable to GitHub and to anyone who gets the repo: a leaked token, a stray clone, a GitHub breach, an accidental visibility change.

Encryption is optional and set per memory repo. Once it's on, each memory's description, body and type are stored encrypted with a key that you keep in your password manager. The memory tool decrypts them when Claude reads them, so day-to-day use doesn't change: no session ever asks for the key.

**Placeholders used below:** `<server>` is the memory tool's address (e.g. `https://claude-memory.example.workers.dev`). `<owner>/<repo>` is your memory repo, e.g. `<you>/claude-memory`.

---

## Before you start

- **A password manager** (1Password or similar). This is a precondition, not a suggestion. The key is shown once, and **without it your memories can't be read by anyone, including you.** Sharing the key through the password manager's sharing is how several people get access to one repo.
- **A memory tool with encryption turned on.** Open `<server>/keys`. If it says "Encryption isn't turned on for this memory server", ask the memory server's operator to turn it on ([QUICKSTART.md](QUICKSTART.md), "Turning on encryption at rest").
- **Admin access to the memory repo** to turn encryption on, turn it back on, or stop it. Registering and removing a key need write access plus the key. For a client repo, the client's admin turns encryption on. `memory_scopes` shows `admin: true` for each memory repo where you have it.
- **The local kit at version 0.1.5 or later** on each machine where you use Claude Code (rerun `./setup.sh`; see "When do I need to rerun setup?" in the [FAQ](FAQ.md)). Older kits keep descriptions in the local snapshot, and may report a save that waits for a key as "not saved" instead of queuing it.

---

## What it protects, and what it doesn't

| Who | Sees plaintext? |
|---|---|
| GitHub, and anyone with the repo or a clone of it | **No**, for memories saved after switch-on. Memories that existed before switch-on: no after a move to a fresh repo; after an in-place squash, still readable through the repo's activity log by anyone with read access until GitHub Support purges the old commits. Clones and forks made before switch-on keep the old plaintext either way |
| The server operator and Cloudflare | Yes. The server must decrypt to answer Claude, so while a repo is in use its key is on the server |
| Anthropic | Yes. Claude has to read the memory |
| The user's own machines (transcripts, outbox) | Yes. **The local machine is inside the trusted boundary.** Only the session-start snapshot is reduced (names only) |

A friend using someone else's server is still trusting that host, exactly as [QUICKSTART-FRIEND.md](QUICKSTART-FRIEND.md) says. Encryption doesn't change that; running your own server does.

**What stays readable.** Memory names: the filenames, the `name:` line of each encrypted file, the repo's `MEMORY.md` (which becomes a list of names only), and commit messages. Folder names under `projects/` (your codebases' names) stay readable too. Choose names that don't give away the content: `client-renewal-terms` says more than `renewal-notes`. In an encrypted scope Claude is asked to do the same.

**What it doesn't detect.** Encryption protects each memory file, not the repo as a whole. Someone with write access can still delete memories, or put back an older encrypted version of one, and nothing notices. Each encrypted file is bound to its repo and its path, so files can't be swapped between memories or between repos unnoticed, but rollback and deletion are not detected.

---

## Turning it on

Use the key page. ([memcrypt](#memcrypt-encrypt-decrypt-and-rotate-from-your-machine) is the alternative, from your own machine.)

1. Open `<server>/keys` and sign in with GitHub. The page lists the memory repos you can write to.
2. Next to the repo, click **Turn on encryption**. (If you aren't an admin of the repo, the page says "Only an admin of `<owner>/<repo>` can turn encryption on or off.")
3. The page shows the new key once, starting with `cmk1_`. **Save it in your password manager now.**
4. Choose a path (below), **Move to a fresh repo** or **Encrypt in place** (squash), paste the key back (proof that it was saved), type the repo name to confirm, and click the button.

Turning on encrypts every existing memory and leaves the old plaintext history behind, by one of two paths.

### Move to a fresh repo (recommended)

The encrypted memories go into a new, empty private repo as its first commit. You then delete the old repo and rename the new one to the old name, so your scopes and the app installation don't change.

1. Before you start: on github.com, create a new **private, empty** repo under the same owner (no README, no .gitignore, no license), e.g. `<owner>/claude-memory-new`. Add it to the memory tool's GitHub App installation (`https://github.com/apps/<slug>/installations/select_target` → the account → **Only select repositories** → add it).
2. On the key page, choose **Move to a fresh repo**, enter the new repo as `<owner>/claude-memory-new`, paste the key, type the repo name, and click **Encrypt into the new repo**.
3. Finish the move, as the page shows:
   1. Delete the old repo: `https://github.com/<owner>/<repo>/settings` → Danger Zone → **Delete this repository**.
   2. Rename the new repo to the old name: its **Settings** → **Repository name**.

**Saves wait until you finish.** From the moment the copy is written until the rename, saves to that repo answer "Encryption is being turned on for this memory repo"; in Claude Code they're queued in the outbox and replayed later. Health shows `encrypted copy written to <new repo>; finish the move` until then. If the key expired before you renamed, register it once on the key page; that also ends the move.

**Wait a minute before deleting the old repo.** The switch takes up to a minute to reach every Cloudflare location, so a save made elsewhere in that minute can still land in the old repo after its copy was written. Reload the key page after a minute, and delete the old repo only when it says "The encrypted copy is current." If it says instead that `<owner>/<repo>` changed after the copy was written (health: `encrypted copy written to <new repo>, but <owner>/<repo> changed after the copy`), don't delete it: cancel the move, delete and recreate the new repo as an empty private repo, and start again.

**Cancelling.** Until you rename, an admin can click **Cancel the move** on the key page. Saves to the old repo then go through again as before the switch, and you can delete the new repo.

**Other scopes wait too.** The outbox replays oldest first and stops at the first `unavailable` answer, so while a move is open, queued saves for your other scopes wait as well. Finish or cancel the move promptly.

Deleting the old repo is what removes the old plaintext. GitHub keeps a deleted repo restorable by its owner for 90 days, and clones and forks made before now keep the old plaintext.

### Encrypt in place (squash; fallback)

The repo's history is replaced by a single commit that holds every memory encrypted. Past changes and their log are gone.

**The old commits stay readable through the repo's activity log by anyone with read access until GitHub Support purges them.** After the switch, request the purge at <https://support.github.com/request>. Clones and forks made before now keep the old plaintext.

The key page refuses the squash, and changes nothing, when:
- the repo isn't private;
- it has other branches or tags (delete them first, or use the fresh-repo path);
- it has ever had a pull request. Pull requests can't be deleted and keep the old commits reachable, so use the fresh-repo path;
- a rule blocks force pushes on the branch (branch protection or a ruleset). Lift the rule while encryption is turned on, or use the fresh-repo path.

Saves through the memory tool are held while the squash runs. GitHub's API can't make the force push conditional, so the memory tool re-checks the branch right before force-pushing; a push from outside the memory tool in that same instant could still be overwritten.

### Why the fresh repo is recommended

Both paths encrypt every memory. The difference is the old plaintext: the fresh-repo path removes it when you delete the old repo (after GitHub's 90-day restore window), while **Encrypt in place** (the squash) leaves it readable through the activity log until GitHub Support acts on your purge request.

---

## Day to day

Nothing changes for you or Claude. Save, read and search work as before, and Claude gets the full index with descriptions: the memory tool builds it from the decrypted files.

### Registering and removing the key

Turning on registers the key with the memory tool. You register it yourself in these cases:
- the key expired (see below), or someone removed it;
- you rotated the key with memcrypt: only the key that signed the repo's current encryption marker is accepted, so after `memcrypt rotate` the old key is refused ("This isn't the key for `<owner>/<repo>`") and you register the new one;
- you use a different memory server (see "Moving to another server, or leaving a host").

To register: on the key page, paste the key next to the repo and click **Register key**. Write access plus the key is enough.

To remove: paste the key and click **Remove key**. The memory tool loses access within about a minute (the removal takes that long to reach every Cloudflare location): then it can't read or save that repo's memories until the key is registered again.

**How long a key stays registered** is set by the memory server's operator: by default until it's removed; with `REPO_KEY_TTL_SECONDS` set, for that long, at least 60 seconds (`86400` means you paste it once a day). The key page shows who registered the key and when it expires.

### When the key isn't registered

- **Saves** fail with `key_required`, which counts as temporary. In Claude Code the save goes to the outbox ("queued in outbox for `<scope>`") and is replayed at a later session start once the key is back; a waiting entry doesn't hold up other scopes. In claude.ai chat it's "not saved", with the key page link.
- **Reads and searches** of encrypted memories fail with the same code and link. The index still lists the names, marked "(encrypted; key not registered)".
- **Health** shows `⚠ encryption:<scope> — encrypted, key not registered` with the link `<server>/keys?repo=<owner>/<repo>`.

### Files added outside the memory tool

A plaintext memory file that appears after switch-on (a hand edit, another tool, an older memory server) is **not** encrypted automatically: an encrypted file is a sign that the memory tool wrote it, and it never encrypts a file it didn't save itself. The index marks each such memory "(unencrypted, added outside the memory tool)", and health warns: `⚠ encryption:<scope> — encrypted, N memories unencrypted, added outside the memory tool`. Review it; if it's right, ask Claude to save it again, which encrypts it.

Hand edits of encrypted files aren't possible: change a memory through Claude, or decrypt the repo with memcrypt first.

### Health lines

Reported at session start, once per session, like other health problems:

| Line | Meaning |
|---|---|
| `✓ encryption:<scope> — encrypted` | All well |
| `⚠ … — encrypted, key not registered` | Register the key; saves are queued until then |
| `⚠ … — encrypted, the registered key doesn't match (rotated?)` | Register the repo's current key |
| `⚠ … — encrypted, the marker names a different key (rotated?)` | After `memcrypt rotate`: register the new key. If nobody rotated the key, treat it as a changed marker (below) |
| `⚠ … — encrypted, N memories unencrypted, added outside the memory tool` | See above |
| `⚠ … — encryption off, N memories still encrypted` | Encryption was stopped; turn it back on, or decrypt with memcrypt |
| `⚠ … — encrypted copy written to <new repo>; finish the move` | Delete the old repo and rename the new one |
| `⚠ … — encrypted copy written to <new repo>, but <owner>/<repo> changed after the copy` | Don't delete the old repo: cancel the move on the key page and start again |
| `✗ … — encrypted, but the encryption marker is missing or not signed` | See "If the encryption marker is missing or changed" |
| `✗ … — encrypted repo, but this memory server doesn't support encryption` | The memory server you're using doesn't have encryption turned on |

---

## Stopping, and turning back on

**Stopping** needs admin on the repo and the key. On the key page, paste the key and click **Stop encrypting new memories**. New memories are saved unencrypted from then on. Existing memories stay encrypted and still need the key to read; health shows `encryption off, N memories still encrypted`. To decrypt them, run `memcrypt decrypt`.

**Turning back on** also needs admin. Click **Turn encryption back on**, paste the repo's existing key, and choose a path as when you first turned it on: memories saved while encryption was off are in the history in plaintext.

The memory tool never turns encryption off because of what's in the repo. Only **Stop** on the key page turns it off, or an admin registering the key after `memcrypt decrypt`. Deleting or editing the encryption marker (`.claude-memory/encryption.json`) keeps the repo encrypted.

---

## memcrypt: encrypt, decrypt and rotate from your machine

`memcrypt` does the same work from your own machine: turning encryption on, decrypting everything, and changing the key. It's also useful for backups, hand edits and testing.

**Never run memcrypt through Claude** (not with Claude's Bash tool, not with `!` in Claude Code): the key would end up in the transcript. Run it in your own terminal.

### Install

It needs Python 3.9 or later and the `cryptography` package, which only memcrypt uses (the rest of the kit needs nothing beyond Python). The package is pinned to an exact version with hashes and installed from wheels only, so a hijacked or look-alike release can't slip in. Install it in its own virtual environment, from your `claude-memory-cloud` folder:

```bash
cd ~/src/claude-memory-cloud
python3 -m venv ~/.venvs/memcrypt
~/.venvs/memcrypt/bin/pip install --require-hashes --only-binary :all: -r kit/requirements-crypt.txt
```

Then run it with that environment's Python:

```bash
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py --help
```

### The key

memcrypt reads the key from one of:
- 1Password's CLI: `--key-op op://<vault>/<item>/<field>` (runs `op read`);
- an environment variable you name: `--key-env <VAR>`;
- a hidden prompt, when neither is given. For `encrypt`, pressing Enter at the prompt generates a new key.

A generated key (from `encrypt`, or the new key of `rotate`) must be pasted back to prove you saved it; `--confirm-key-env <VAR>` reads that paste-back from an environment variable instead, for scripts.

The key is never passed to git: not in arguments, not in git's environment, not in a file in the repo. memcrypt works in a temporary clone that it deletes afterwards, so no plaintext or key lingers on disk. A generated key is printed once, and you paste it back to prove you saved it.

The `<remote-url>` below is the memory repo's clone URL, e.g. `git@github.com:<owner>/<repo>.git`. memcrypt pushes with your own git credentials, so you need push access (and, for an in-place path, a branch that allows force pushes). Add `--server <server>` to any command to get the key page link in its output.

### encrypt

```bash
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py encrypt <remote-url> --to <new-remote-url>   # fresh repo (recommended)
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py encrypt <remote-url> --in-place              # encrypt in place (squash)
```

The same two paths as the key page, with the same warning and confirmation (typing `<owner>/<repo>`; `--confirm <owner>/<repo>` answers it in advance). Without `--to` or `--in-place` it asks. Then register the key on the key page so the memory tool can read and save.

**The `--to` repo must be private.** memcrypt talks plain git, which can't tell whether a repo is private, so it prints "Make sure `<new-remote-url>` is a private repository." before you confirm. Check it on github.com.

**With `--to`, saves aren't held.** memcrypt can't hold the memory tool's saves while you finish the move. **Don't save memories to that scope until you've deleted the old repo, renamed the new one, and registered the key:** a save to the old repo would be lost when you delete it. (The key page's fresh-repo path holds saves for you.)

With `--in-place`, memcrypt refuses if the repo has other branches, tags or pull requests (pull requests can't be deleted: use `--to` instead), and its force push fails if the branch changed in the meantime.

### decrypt

```bash
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py decrypt <remote-url>
```

Writes every memory back in plaintext, in a normal commit, and marks encryption off. That plaintext stays in the repo's history from now on, even if you turn encryption on again later.

The memory tool keeps encrypting new saves until an admin of the repo registers the key on the key page (whether or not it's already registered) or uses **Stop** there. If someone who isn't an admin registers it, the page answers "Encryption stays on for `<owner>/<repo>`; an admin can turn it off with Stop."

### rotate

```bash
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py rotate <remote-url> --to <new-remote-url>   # fresh repo
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py rotate <remote-url> --in-place              # squash in place
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py rotate <remote-url> --commit                # a normal commit
```

Decrypts with the old key and encrypts with a new one in memory, with no plaintext step in history. The new key is generated and shown once, unless you give one with `--new-key-env <VAR>`. Choose where the old key's ciphertext goes: `--to` and `--in-place` leave it behind as for switch-on; `--commit` keeps it in the history, so anyone with read access and the old key can still read those versions.

Then register the new key on the key page. The old key is refused from now on. Until you register it, health shows `⚠ encryption:<scope> — encrypted, the marker names a different key (rotated?)`.

---

## If the encryption marker is missing or changed

The marker, `.claude-memory/encryption.json` at the repo root, records that the repo is encrypted, signed with a key derived from the repo key. The memory tool also remembers on its own which repos are encrypted.

- **Deleted, or edited without the key:** the repo stays encrypted. Saves stay encrypted, and health shows `✗ encryption:<scope> — encrypted, but the encryption marker is missing or not signed`, with a link to the repo's recent commits. Someone may have tried to turn encryption off.
- **Replaced with a marker for another key** (by someone with write access): saves stop rather than risk the wrong key, and the key page refuses your key for that repo. A marker that differs only in its key looks like a rotate to the memory tool, so health shows the ⚠ "marker names a different key (rotated?)" line rather than ✗: if nobody ran `memcrypt rotate`, treat it as this case.

To recover, review the recent commits and put the last good marker back from the repo's history, for example in a clone:

```bash
git log --oneline -- .claude-memory/encryption.json
git checkout <good-commit> -- .claude-memory/encryption.json
git commit -m "Restore the encryption marker" && git push
```

If a rule (branch protection or a ruleset) blocks direct pushes to the branch, push to a new branch and open a pull request instead.

Then check that health is clean, and look at who could write to the repo.

---

## Moving to another server, or leaving a host

The key is yours, and the encryption marker is in your repo, so an encrypted repo works with any memory server that has encryption turned on.

- **Leaving a host's server:** on its key page, **Remove key** for your repo before you go, then follow "Leaving" in [QUICKSTART-FRIEND.md](QUICKSTART-FRIEND.md). Uninstalling the app also cuts the server off. The host's server keeps a small record that your repo is encrypted (the repo's ID and the key's fingerprint, never the key or any memory).
- **Using another server** (your own, or a new host's): its operator must have turned encryption on. Register your key on its key page, `<new server>/keys`.

---

## Limits

- **An encrypted repo needs a memory server with encryption turned on.** A server without it (no `MEMORY_MASTER_KEY`) refuses to read or save an encrypted repo, and health says "this memory server doesn't support encryption". But a server running code from before this feature ignores encryption altogether, and a server without encryption can't tell a repo is encrypted if its marker was deleted too: either can then write plaintext memories into a project folder that has no encrypted files yet. Use your repo only with memory servers you know have encryption turned on.
- **Rollback and deletion aren't detected** (see "What it protects, and what it doesn't").
- **The in-place squash and outside pushes:** see "Encrypt in place".
- **The memory server's operator, Cloudflare and Anthropic can read your memories**, and so can anything on your own machines. Encryption keeps them from GitHub and from anyone who gets the repo, not from those.

See the [threat model](THREAT-MODEL.md), section 11, for the design's view of these risks.
