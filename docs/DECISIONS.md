# Design decisions

Why claude-memory-cloud is built the way it is. Each entry gives the decision, the reason, and what it costs. The [threat model](THREAT-MODEL.md) and the [FAQ](FAQ.md) have the detail behind most of them.

## Storage and reach

**Memories live in GitHub repos, as plain Markdown.** You own the repo, so you can read, edit, export or delete everything without this project. Every change is a commit, which is a free audit trail. A client's memories live in a repo inside the client's own GitHub org, which the client controls and can cut off. *Cost:* deleting a memory leaves it in git history, and one index load makes about 15 GitHub requests. A repo's owner can encrypt its memories (see "Encryption at rest" below); then the files are no longer readable by hand.

**The server is a remote MCP connector on Cloudflare Workers.** claude.ai web, Desktop, mobile and Claude Code cloud sessions can only reach memory through a remote connector; a local MCP server would serve one machine's Claude Code and nothing else. Workers is cheap and needs no server to run. *Cost:* the server sees memory text in plaintext, and each call needs more CPU than the free plan allows, so it needs Workers Paid ($5/month).

**The server acts as you through a GitHub App's user tokens.** The app asks for one permission (contents), is installed only on memory repos, and can never exceed your own access. No app private key exists, and user tokens expire every 8 hours. A personal access token would usually reach everything you can reach, and a client org can't grant one the way it installs an app.

## What gets saved where

**Three kinds of scope: general, client and project.** General is about you; client is about one client org as a whole; project is about one codebase. A project is identified by its git `origin` remote, not the local folder, so the same project gets the same memories on every machine. Project memories live under `projects/<repo>/` in the memory repo of whoever owns the codebase.

**Memories load by context, not everywhere.** A Claude Code session gets general, the client that owns the repo, and that project. Chat gets general only, unless you name a client. This keeps one client's notes out of unrelated conversations and limits how far a planted instruction can travel. *Cost:* client facts don't appear in chat until you ask for them.

**GitHub holds work facts only.** A memory repo is durable and copyable, and a client scope is readable by that client's people. Personal facts (health, money, family, where you live, travel, your own rates and contracts) go to claude.ai's built-in memory instead, which stays private to you. Candid opinions about people are declined unless you explicitly ask, and then only in `general`.

## Checks on every save

**Three independent checks, from soft to hard.** Claude's judgment applies the rules first, on every surface, but can be persuaded. Claude Code's permission check comes next: the kit allow-lists only the read tools, so every save is either approved by you or, in auto mode, judged by a classifier. The Worker's guard checks every write last and can't be skipped; `force` and `confirmed` don't get past its refusals for secrets and personal facts.

**The Worker's guard is regular expressions, not a model.** It gives the same answer every time, adds no cost or delay, can't be talked out of a refusal, and every rule is covered by tests. *Cost:* it misses paraphrases and clever wording, and it sometimes refuses harmless text. It's a backstop to Claude's judgment, not a replacement.

**The secret scanner is best effort.** It catches common token formats (GitHub, AWS, Stripe, npm, Azure, private keys, credentials in URLs, obvious password assignments). It won't catch every password, so the rule remains: never put secrets in memory.

**Memory content is data, never instructions.** Anyone who can write a memory repo can write text Claude will read. Claude is told not to run commands, follow links or copy between scopes because a memory says to. The server's own messages carry a marker that changes on every response, so memory text can't impersonate them. Blocking "instruction-like" saves was considered and rejected: too many false positives for little gain.

## Reliability

**Concurrent edits make conflict copies, never silent overwrites.** A save based on an old version is stored next to the original, the index lists it, and Claude offers to merge. Nothing is lost.

**The duplicate check compares wording, not meaning.** A save with an existing memory's name gets `exists`; one whose name and description share at least half their words with an existing memory gets `similar_found`. A paraphrase gets through, so Claude's reading of the index is the main defence. Matching on meaning would need a model call on every save, the same trade-off as the guard. *Cost:* reworded duplicates can build up and have to be merged by hand.

**Local Claude Code has an outbox and a read-only snapshot.** If the server is unreachable, a save is queued as a file on that machine and replayed later through the same checks. A snapshot of the last index lets a session still read something offline. Chat and cloud sessions have no local disk, so there a failed save is reported as not saved.

**The cache keeps copies for at most 7 days.** Caching makes index loads fast and cheap. Seven days bounds how long a deleted memory, or one from a client that removed your access, can linger on the server.

## Access

**An explicit allowlist, not open sign-up.** The `SCOPES` secret lists who may sign in and which repos each person's memories live in; nobody sees anyone else's scopes. Each login is pinned to its numeric GitHub ID at first sign-in, so a recreated account with the same name can't take over. Removing someone takes effect at their next request or token refresh.

**Connections expire.** A connection lasts 30 days without use and 180 days at most, then you reconnect. The consent page appears on every new connection, with no "remember me", because connecting is rare and a remembered consent is easier to abuse.

**A trusted group per server.** A server is for you and people who trust you: whoever runs it can read every memory that passes through it. There's no set size. The practical ceiling is the `SCOPES` secret, which Cloudflare caps at 5 KB, enough for roughly 50 people with a client scope each, and each person is added by hand. A client that wants its own control self-hosts a copy; the code is small.

## Encryption at rest

The how-to is [ENCRYPTION.md](ENCRYPTION.md); the risks are in the [threat model](THREAT-MODEL.md), section 11.

**Encryption happens in the Worker.** The memory tool seals each memory just before it commits and opens it just after it reads, so the guard, search, the duplicate check and the index all keep working on plaintext, on every surface. Encrypting on the client side would have meant no search, no guard and no claude.ai chat, which has no place to run code. *Cost:* encryption protects memories from GitHub and from anyone who gets the repo, not from the server's operator, Cloudflare or Anthropic.

**The repo owner holds the key, in a password manager.** It's generated once, shown once, and pasted back before anything is encrypted, as proof it was saved. The owner registers it with a server once; it stays until removed, or until an operator-set lifetime (`REPO_KEY_TTL_SECONDS`) ends, so no session asks for it. The server keeps it in KV, wrapped under its own master key (`MEMORY_MASTER_KEY`). Because the key lives with the owner, it moves with them to another server. *Cost:* a lost key loses the memories; the owner needs a password manager.

**One key per memory repo.** It covers every scope in that repo: `general` or the client scope, and every `projects/<repo>/` folder inside it. Several people share a repo by sharing the key through their password manager. *Cost:* no per-person keys and no server-side rotation; changing the key is a deliberate local step (`memcrypt rotate`).

**Names stay readable.** Filenames, each encrypted file's `name:` line, the repo's names-only `MEMORY.md` and commit messages show memory names, so the index, conflicts and history keep working without the key. Descriptions, bodies and types are encrypted. *Cost:* a name can give away content, so in encrypted scopes Claude is asked to choose names that don't.

**A fresh repo is recommended over squashing history.** Both switch-on paths encrypt every memory. The in-place squash leaves the old plaintext commits readable through GitHub's activity log until GitHub Support purges them, and can't be used on a repo that ever had a pull request. Writing the encrypted memories into a new repo and deleting the old one removes the old history with the user's own action. *Cost:* a delete and a rename by hand, and saves wait until they're done.

**Turning encryption off can't happen silently.** The marker in the repo (`.claude-memory/encryption.json`) is signed with a key derived from the repo key, and each server keeps its own record of every repo it has seen encrypted. A missing, unsigned or changed marker keeps the repo encrypted and fails health; only Stop on the key page (or an admin registering the key after `memcrypt decrypt`) turns it off. Turning encryption on, back on or off needs admin on the repo, so a co-writer can't put a shared repo under a key only they hold. *Cost:* recovering from a damaged marker means restoring it from the repo's history.

**No automatic sealing of outside files.** A plaintext memory that appears after switch-on (a hand edit, another tool, an older server) is marked in the index and in health, not encrypted. An encrypted file is a sign the memory tool wrote it; sealing a planted file would make it look trustworthy. *Cost:* such files stay in plaintext until someone saves them again through Claude.

**The local commands use a pinned `cryptography`.** `memcrypt` (encrypt, decrypt, rotate) is the one part of the kit that needs a package beyond Python's standard library. It's pinned to an exact version with hashes in `kit/requirements-crypt.txt` and installed from wheels only (`pip install --require-hashes --only-binary :all:`), so a hijacked or look-alike release can't slip in; upgrades are deliberate commits. The rest of the kit stays standard-library only. *Cost:* one virtual environment to set up, only for people who run `memcrypt`.

## Running it

**The local kit lives in `~/.claude-memory-cloud`, not `~/.claude`.** Claude Code asks permission for every write under `~/.claude`, and allow rules can't change that, so the outbox would prompt on every queued save. Only `settings.json` (hooks, auto-memory off) and `CLAUDE.md` (the routing rule) are changed in `~/.claude`.

**Claude Code's own auto-memory is turned off.** Otherwise memories would end up in two places that never sync. Existing local memory files are left as a backup.

**Deploy credentials are scoped and stay off disk.** Deploys use a Cloudflare API token limited to editing the two Workers, read from the macOS keychain by `scripts/wrangler.sh`. Your deployment's URL, app slug and storage IDs live in a git-ignored `wrangler.local.jsonc`; the committed `wrangler.jsonc` is a template.

**TypeScript on the server; Python and shell on your machine.** Cloudflare's OAuth and MCP libraries for Workers are TypeScript. Everything local (hooks, setup, tests) uses only Python's standard library and shell, so installing it needs nothing extra. The one exception is the optional `memcrypt` (above).
