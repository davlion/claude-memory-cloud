# Encrypting your memory repo

This guide is for the owner of a memory repo who wants the text of their memories kept unreadable to GitHub and to anyone who gets the repo: a leaked token, a stray clone, a GitHub breach, an accidental visibility change.

Encryption is optional and set per memory repo. Once it's on, each memory's description, body and type are stored encrypted with a key that you keep in your password manager. The memory tool decrypts them when Claude reads them, so day-to-day use doesn't change: no session ever asks for the key.

**Placeholders used below:** `<server>` is the memory tool's address (e.g. `https://claude-memory.example.workers.dev`). `<owner>/<repo>` is your memory repo, e.g. `<you>/claude-memory`.

---

## Before you start

- **A password manager** (1Password or similar). This is a precondition, not a suggestion. The key is shown once, and **without it your memories can't be read by anyone, including you.** Sharing the key through the password manager's sharing is how several people get access to one repo.
- **A memory tool with encryption turned on.** Open `<server>/keys`. If it says "Encryption isn't turned on for this memory server", ask the memory server's operator to turn it on ([QUICKSTART.md](QUICKSTART.md), "Turning on encryption at rest").
- **Admin access to the memory repo** to turn encryption on, turn it back on, stop it, confirm a decryption, register a changed key (after `memcrypt rotate`), or forget encryption for a repo that holds nothing encrypted. Removing a key needs write access plus the key; so does registering the repo's key once an admin has confirmed it (below). For a client repo, the client's admin turns encryption on. `memory_scopes` shows `admin: true` for each memory repo where you have it.
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

1. Open `<server>/keys` (the server's front page, `/`, links to it) and sign in with GitHub. The page lists the memory repos you can write to.
2. Next to the repo, click **Turn on encryption**. (If you aren't an admin of the repo, the page says "Only an admin of `<owner>/<repo>` can turn encryption on or off.")
3. The page shows the new key once, starting with `cmk1_`. **Save it in your password manager now.**
4. Choose a path (below), **Move to a fresh repo** or **Encrypt in place** (squash), paste the key back (proof that it was saved), type the repo name to confirm, and click the button. The page shows each step as it finishes; keep it open until it says encryption is on (for a fresh repo, until it shows how to finish the move).

Turning on encrypts every existing memory and leaves the old plaintext history behind, by one of two paths.

### Move to a fresh repo (recommended)

The encrypted memories go into a new, empty private repo as its first commit. You then delete the old repo and rename the new one to the old name, so your scopes and the app installation don't change.

1. Before you start: on github.com, create a new **private, empty** repo under the same owner (no README, no .gitignore, no license), e.g. `<owner>/claude-memory-new`. Add it to the memory tool's GitHub App installation (`https://github.com/apps/<slug>/installations/select_target` → the account → **Only select repositories** → add it).
2. On the key page, choose **Move to a fresh repo**, enter the new repo as `<owner>/claude-memory-new`, paste the key, type the repo name, and click **Encrypt into the new repo**.
3. Finish the move, as the page shows:
   1. Delete the old repo: `https://github.com/<owner>/<repo>/settings` → Danger Zone → **Delete this repository**.
   2. Rename the new repo to the old name: its **Settings** → **Repository name**.

**Saves wait until you finish.** From the moment the copy is written until the rename, saves to that repo answer "Encryption is being turned on for this memory repo"; in Claude Code they're queued in the outbox and replayed later. Health shows `encrypted copy written to <new repo>; finish the move` until then. If the key expired before you renamed, register it once on the key page; that also ends the move.

**Wait a few minutes before deleting the old repo.** Cloudflare documents up to 60 seconds or more for a change to reach every location, and in staging it took several minutes, so a save made elsewhere in that time can still land in the old repo after its copy was written. Reload the key page after a few minutes, and delete the old repo only when it says "The encrypted copy is current." If it says instead that `<owner>/<repo>` changed after the copy was written (health: `encrypted copy written to <new repo>, but <owner>/<repo> changed after the copy`), don't delete it: cancel the move, delete and recreate the new repo as an empty private repo, and start again.

**Cancelling.** Until you rename, an admin can click **Cancel the move** on the key page. Saves to the old repo then go through again as before the switch, and you can delete the new repo.

**Other scopes wait too.** The outbox replays oldest first and stops at the first `unavailable` answer, so while a move is open, queued saves for your other scopes wait as well. Finish or cancel the move promptly.

Deleting the old repo is what removes the old plaintext. GitHub keeps a deleted repo restorable by its owner for 90 days, and clones and forks made before now keep the old plaintext.

### Encrypt in place (squash; fallback)

The repo's history is replaced by a single commit that holds every memory encrypted. Past changes and their log are gone.

**The old commits stay readable through the repo's activity log by anyone with read access until GitHub Support purges them.** After the switch, request the purge at <https://support.github.com/request>. Clones and forks made before now keep the old plaintext.

The key page refuses the squash, and changes nothing, when:
- the repo isn't private;
- it has other branches, tags or other refs such as `refs/notes/*` (delete them first, or use the fresh-repo path);
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
- you rotated the key with memcrypt: only the key that signed the repo's current encryption marker is accepted, so after `memcrypt rotate` the old key is refused ("This isn't the key for `<owner>/<repo>`") and an admin of the repo registers the new one;
- you use a different memory server (see "Moving to another server, or leaving a host").

To register: on the key page, paste the key next to the repo and click **Register key**. The first registration of a repo's key must be an admin's: an admin's key page actions (turning on, registering, Stop, Confirm decryption) confirm the key, and a repo the memory tool only learned about from its contents (after `memcrypt encrypt`, or a marker someone else put in the repo) has no confirmed key yet. Anyone else gets "Only an admin of `<owner>/<repo>` can register this key: the memory tool hasn't seen an admin confirm this repo's encryption key.", and the key page tells an admin in that state that registering confirms the key. After that, write access plus the key is enough to register the confirmed key again (when it expires, for example). A key that differs from the confirmed one (after `memcrypt rotate`, or a marker someone else put in the repo) needs an admin again: anyone else gets "Only an admin of `<owner>/<repo>` can register a new key for it (the key was changed, e.g. with memcrypt rotate)." One exception: a write user registering the confirmed key while the repo's signed marker says on also turns encryption back on if it was stopped. Registering never turns encryption off.

To remove: paste the key and click **Remove key**. The memory tool loses access within a few minutes (Cloudflare documents up to 60 seconds or more for a change to reach every location; in staging it took several minutes): then it can't read or save that repo's memories until the key is registered again.

**How long a key stays registered** is set by the memory server's operator: by default until it's removed; with `REPO_KEY_TTL_SECONDS` set, for that long, at least 60 seconds (`86400` means you paste it once a day). The key page shows who registered the key and when it expires.

### When the key isn't registered

- **Saves** fail with `key_required`, which counts as temporary. In Claude Code the save goes to the outbox ("queued in outbox for `<scope>`") and is replayed at a later session start once the key is back; a waiting entry doesn't hold up other scopes. In claude.ai chat it's "not saved", with the key page link.
- **Reads and searches** of encrypted memories fail with the same code and link. The index still lists the names, marked "(encrypted; key not registered)".
- **Health** shows `⚠ encryption:<scope> — encrypted, key not registered` with the link `<server>/keys?repo=<owner>/<repo>`.

### Files added outside the memory tool

A plaintext memory file that appears after switch-on (a hand edit, another tool, an older memory server) is **not** encrypted automatically: an encrypted file is a sign that the memory tool wrote it, and it never encrypts a file it didn't save itself. The index marks each such memory "(unencrypted, added outside the memory tool)", `memory_read` and `memory_search` results carry the same marking, and health warns: `⚠ encryption:<scope> — encrypted, N memories unencrypted, added outside the memory tool`. Review it; if it's right, ask Claude to save it again, which encrypts it. While the encryption marker says off (see the ✗ lines below), the label is just "(unencrypted)" and health says `N memories unencrypted`; during a fresh-repo move, plaintext files in the old repo aren't labelled at all.

Hand edits of encrypted files aren't possible: change a memory through Claude, or decrypt the repo with memcrypt first.

### Health lines

Reported at session start, once per session, like other health problems:

| Line | Meaning |
|---|---|
| `✓ encryption:<scope> — encrypted` | All well |
| `⚠ … — encrypted, key not registered` | Register the key; saves are queued until then |
| `⚠ … — encrypted, the registered key doesn't match (rotated?)` | Register the repo's current key |
| `⚠ … — encrypted, the key was changed (memcrypt rotate?)` | After `memcrypt rotate`: register the repo's new key (one line, whether or not an old key is registered). If nobody rotated the key, treat it as a changed marker (below) |
| `⚠ … — encrypted, N memories unencrypted, added outside the memory tool` | See above |
| `⚠ … — encryption off, N memories still encrypted` | Encryption was stopped; turn it back on, or decrypt with memcrypt |
| `⚠ … — encrypted copy written to <new repo>; finish the move` | Delete the old repo and rename the new one |
| `⚠ … — encrypted copy written to <new repo>, but <owner>/<repo> changed after the copy` | Don't delete the old repo: cancel the move on the key page and start again |
| `✗ … — encrypted, but the repo was decrypted outside the memory tool (the signed marker says off)` | The registered key verifies a marker that says off. After `memcrypt decrypt`, an admin clicks **Confirm decryption (turn encryption off)** on the key page; otherwise review the repo's recent commits. Saves stay encrypted until then |
| `✗ … — encrypted, but the encryption marker says off and can't be checked without the key` | The marker says off but no registered key can verify it. Register the key on the key page to check it; if nobody decrypted the repo, review recent commits. Saves stay encrypted |
| `✗ … — encrypted, but the encryption marker is missing or not signed` | See "If the encryption marker is missing or changed" |
| `✗ … — encrypted repo, but this memory server doesn't support encryption` | The memory server you're using doesn't have encryption turned on |

---

## Stopping, and turning back on

**Stopping** needs admin on the repo and the key. On the key page, paste the key and click **Stop encrypting new memories**. New memories are saved unencrypted from then on. Existing memories stay encrypted and still need the key to read; health shows `encryption off, N memories still encrypted`. To decrypt them, run `memcrypt decrypt`, then an admin clicks **Confirm decryption (turn encryption off)** on the key page (paste the key).

**Turning back on** also needs admin. Click **Turn encryption back on**, paste the repo's existing key, and click **Encrypt in place**: memories saved while encryption was off are in the history in plaintext, so the history is squashed again. Moving to a fresh repo isn't offered when turning back on. If the memory tool has flagged memories as added outside it, the page lists them by name first ("These N files were added outside the memory tool and will be encrypted too. Review them first:"): once encrypted they look like the memory tool's own, so review them before you continue.

The memory tool never turns encryption off because of what's in the repo. Only **Stop** on the key page turns it off, or an admin clicking **Confirm decryption (turn encryption off)** after `memcrypt decrypt`; plain **Register key** never does, even for an admin. Deleting or editing the encryption marker (`.claude-memory/encryption.json`) keeps the repo encrypted.

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

The key is never passed to git: not in arguments, not in git's environment, not in a file in the repo. memcrypt works in a temporary clone that it deletes afterwards, so no plaintext or key lingers on disk; if it can't delete the clone, it says so and names the folder for you to delete. A generated key is printed once, and you paste it back to prove you saved it. With a generated key there are two numbered prompts after the warning: `Step 1 of 2` (paste the new key back, hidden) and `Step 2 of 2` (type `<owner>/<repo>`); a successful run ends with a `Done:` line.

If anything fails after a new key was printed, memcrypt tells you what happened to it. If the push had started, it asks the remote rather than guessing, and it says "NOT applied" only when git reported that the remote refused the push (an interrupted push or a dropped connection can still land a moment later):
- `The new key shown above was NOT applied: <owner>/<repo> still uses its current key.` (for `encrypt`: `… <owner>/<repo> is unchanged.`) Discard that key and run memcrypt again to get another (a `stale info` push failure means a memory was saved while memcrypt waited at its prompt).
- `The new key WAS applied: keep it.` The push went through despite the error or Ctrl-C; memcrypt carries on with the usual next steps (or, for `--to`, its own message if the check after the push failed).
- `The push may have gone through. Keep the new key until you've checked <owner>/<repo> on GitHub: if its encryption marker names key <key id>, the new key is in use.` The push was interrupted or the connection failed, or the remote couldn't be read. Look at `.claude-memory/encryption.json` in the repo: if its `key_id` is the one shown, keep the new key; otherwise discard it.

The `<remote-url>` below is the memory repo's clone URL, e.g. `git@github.com:<owner>/<repo>.git`. memcrypt pushes with your own git credentials, so you need push access (and, for an in-place path, a branch that allows force pushes). Add `--server <server>` to any command to get the key page link in its output.

### encrypt

```bash
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py encrypt <remote-url> --to <new-remote-url>   # fresh repo (recommended)
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py encrypt <remote-url> --in-place              # encrypt in place (squash)
```

The same two paths as the key page, with the same warning and confirmation (typing `<owner>/<repo>`; `--confirm <owner>/<repo>` answers it in advance). Without `--to` or `--in-place` it asks. Then an admin of the repo registers the key on the key page once, so the memory tool can read and save (the memory tool only trusts a key an admin confirmed); after that, anyone with write access can register it again.

**The `--to` repo must be private.** memcrypt talks plain git, which can't tell whether a repo is private, so it prints "Make sure `<new-remote-url>` is a private repository." before you confirm. Check it on github.com.

**With `--to`, saves aren't held.** memcrypt can't hold the memory tool's saves while you finish the move. **Don't save memories to that scope until you've deleted the old repo, renamed the new one, and registered the key:** a save to the old repo would be lost when you delete it. (The key page's fresh-repo path holds saves for you.)

With `--in-place`, memcrypt refuses if the repo has other branches, tags, pull requests or other refs (pull requests can't be deleted: use `--to` instead), and its force push fails if the branch changed in the meantime.

### decrypt

```bash
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py decrypt <remote-url>
```

Writes every memory back in plaintext, in a normal commit, and marks encryption off. That plaintext stays in the repo's history from now on, even if you turn encryption on again later. Each `MEMORY.md` index gets its descriptions back from the decrypted memories.

The memory tool keeps encrypting new saves, and health shows `✗ … decrypted outside the memory tool`, until an admin of the repo clicks **Confirm decryption (turn encryption off)** on the key page and pastes the key (whether or not it's already registered), or uses **Stop** there. The key page answers "Encryption is off for `<owner>/<repo>`: new memories are saved unencrypted." It refuses while any memory in the repo is still encrypted: then the off marker isn't from `memcrypt decrypt` (an old one put back from history?). Registering the key with **Register key** doesn't turn encryption off: someone who isn't an admin is told "Encryption stays on for `<owner>/<repo>`; an admin can turn it off with Stop."

### rotate

```bash
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py rotate <remote-url> --to <new-remote-url>   # fresh repo
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py rotate <remote-url> --in-place              # squash in place
~/.venvs/memcrypt/bin/python kit/bin/memcrypt.py rotate <remote-url> --commit                # a normal commit
```

Decrypts with the old key and encrypts with a new one in memory, with no plaintext step in history. The new key is generated and shown once, unless you give one with `--new-key-env <VAR>`. Choose where the old key's ciphertext goes: `--to` and `--in-place` leave it behind as for switch-on; `--commit` keeps it in the history, so anyone with read access and the old key can still read those versions.

Then an admin of the repo registers the new key on the key page (a changed key needs admin, so a co-writer can't switch the memory tool to a key only they hold). The old key is refused from now on. Until you register it, health shows `⚠ encryption:<scope> — encrypted, the key was changed (memcrypt rotate?)`.

**Rotating to cut someone off?** Remove their write access to the repo first. Anyone who still has write access and the old key can put back a marker signed with the old key and register it, before the admin registers the new one or within the few minutes it takes that change to reach every Cloudflare location.

---

## If the encryption marker is missing or changed

The marker, `.claude-memory/encryption.json` at the repo root, records that the repo is encrypted, signed with a key derived from the repo key. The memory tool also remembers on its own which repos are encrypted.

- **Deleted, or edited without the key:** the repo stays encrypted. Saves stay encrypted, and health shows `✗ encryption:<scope> — encrypted, but the encryption marker is missing or not signed` (or, for a marker that says off and can't be checked without the key, `… the encryption marker says off and can't be checked without the key`), with a link to the repo's recent commits. Someone may have tried to turn encryption off.
- **Replaced with a marker for another key** (by someone with write access): saves stop rather than risk the wrong key, and the key page refuses your key for that repo. Only an admin of the repo can register the key that signed the new marker, so whoever planted it can't make the memory tool use their key. A marker that differs only in its key looks like a rotate to the memory tool, so health shows the ⚠ "the key was changed (memcrypt rotate?)" line rather than ✗: if nobody ran `memcrypt rotate`, treat it as this case.

To recover, review the recent commits and put the last good marker back from the repo's history, for example in a clone:

```bash
git log --oneline -- .claude-memory/encryption.json
git checkout <good-commit> -- .claude-memory/encryption.json
git commit -m "Restore the encryption marker" && git push
```

If a rule (branch protection or a ruleset) blocks direct pushes to the branch, push to a new branch and open a pull request instead.

Then check that health is clean, and look at who could write to the repo.

**Treated as encrypted, but nothing in it is.** Someone with write access can make the memory tool treat a repo that was never encrypted as encrypted, by committing an encryption marker or a file that looks encrypted. The memory tool remembers that even after the files are removed, and saves then wait for a key. That record isn't confirmed by an admin, so only an admin can register a key for it: whoever planted a marker signed with their own key can't get the memory tool to use it. Remove the planted files first; once the repo holds no encryption marker and no encrypted memory file, an admin of the repo clicks **Forget encryption for this repo** on the key page, which answers "`<owner>/<repo>` isn't treated as encrypted any more." The key page refuses while anything encrypted or marked is left, and says what.

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
