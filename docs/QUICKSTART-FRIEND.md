# claude-memory-cloud — Quickstart for a friend's server

This guide is for you if a friend (your **host**) already runs a claude-memory-cloud server and has offered to let you use it. You don't deploy anything or pay for Cloudflare. If you want to run your own server instead, follow [QUICKSTART.md](QUICKSTART.md).

claude-memory-cloud gives Claude one set of memories everywhere: Claude Code on any machine, Claude Code cloud sessions, and claude.ai chat on web, Desktop, and mobile. Your memories are Markdown files in a private GitHub repo that **you** own. Your host's server connects that repo to Claude as a custom connector.

You'll set up:

| What | Where | Time |
|---|---|---|
| A private memory repo | your GitHub account | 1 min |
| Your host's GitHub App, installed on that repo only | your GitHub account | 2 min |
| The connector | claude.ai | 2 min |
| The local kit, on each machine where you use Claude Code | your Mac or VM | 5 min per machine |

**Placeholders used below:** `<you>` is your GitHub username. `<server>` is your host's server address (e.g. `https://claude-memory.example.workers.dev`). `<slug>` is your host's GitHub App name (the last part of `https://github.com/apps/<slug>`).

---

## Before you start

- A GitHub account.
- A claude.ai account (Pro, Max, Team, or Enterprise; custom connectors are needed).
- For Claude Code on a Mac or VM: `git`, and Python 3.9 or later (on macOS, install the Command Line Tools: `xcode-select --install`).
- From your host:
  - the server address `<server>`
  - the app name `<slug>`
  - access to the `claude-memory-cloud` code for the local kit (Part 5): read access to their copy of the repo, or a copy of it. If it's private, they add you as a collaborator with **Read** access.

**What your host can see.** Read this before you start. The server runs in your host's Cloudflare account, and memory text passes through it in plaintext. Whoever controls that account (your host, and anyone who compromises it) can read your memories: as they pass through, and from the server's cache, which keeps copies for up to 7 days, even after you delete a memory or leave. The server also holds your GitHub sign-in for the app, so whoever controls it could change your memories too, but only in repos where you installed the app (Part 3 limits that to `<you>/claude-memory`), never your other repos or your GitHub account. Every change is a commit you can see, and uninstalling the app (see "Leaving") cuts the server off immediately. Only use a server run by someone you'd trust with what you save. Never save secrets: the server's secret check is best effort. See "Who can see my memories?" in the [FAQ](FAQ.md).

---

## Part 1 — Create your memory repo

1. On github.com, click **+** → **New repository**.
2. **Owner:** you. **Name:** `claude-memory`.
3. **Private.** ✅
4. Leave it **empty**: no README, no .gitignore, no license. The server initializes it on the first save.
5. Click **Create repository**.

✔ You now have `https://github.com/<you>/claude-memory`.

---

## Part 2 — Ask your host to add you

Send your host your exact GitHub username `<you>` and the repo name `<you>/claude-memory`. They add you to the server's allowlist; nothing else is needed from you, and no secrets change hands.

Wait until they confirm before Part 4. Until then, connecting shows "This GitHub account isn't on this memory server".

> **For the host:** run `npm run friend -- add <you>`. No redeploy is needed. See "Letting a friend use your server" in [QUICKSTART.md](QUICKSTART.md).

---

## Part 3 — Install your host's app on your memory repo

The GitHub App is how the server reaches your memory repo, **and only that repo**. It acts as you, so it can never do more than you can, and commits show up under your name.

1. Go to `https://github.com/apps/<slug>/installations/select_target`.
2. Choose your personal account.
3. Select **Only select repositories** → `claude-memory`. Don't choose **All repositories**.
4. Click **Install**.

✔ The app can reach `<you>/claude-memory` and nothing else.

If the page says the app can't be installed on your account, the host's app is still private: ask them to make it public (it isn't listed anywhere; it only allows other accounts to install it).

---

## Part 4 — Connect it to Claude

1. On claude.ai: **Settings** → **Connectors** → **Add custom connector**.
   - **Name:** `claude-memory`
   - **URL:** `<server>/mcp`
2. Click **Connect**. Your browser shows the server's consent page ("Allow Claude to use your claude-memory?"). Click **Allow**. You're then sent to GitHub to approve the app. Make sure the browser is signed in to **your** GitHub account, the one that owns `<you>/claude-memory`. You'll see this consent page every time you connect a new client; there's no "remember me".
3. Test it: in a new chat, ask *"What's in my memory index?"* You should see a health line and an empty index.
4. If you see **"This GitHub account isn't on this memory server"**, either your host hasn't added you yet (Part 2), or the browser approved with a different GitHub account. Sign in to GitHub with the right account and connect again.

The connector now works in claude.ai chat (web, Desktop, mobile), in Claude Code cloud sessions, and in local Claude Code when you're logged in with your claude.ai account.

5. In chat, the connector can be switched on or off per chat from the **+** menu in the message box. Leave claude.ai's built-in memory on: it is where personal facts belong (see "What about claude.ai's built-in memory?" in the [FAQ](FAQ.md)).

---

## Part 5 — Set up each machine

Do this on every Mac or VM where you use Claude Code.

1. Get the code (with the access your host gave you; `<host>` is their GitHub username):

   ```bash
   git clone https://github.com/<host>/claude-memory-cloud ~/src/claude-memory-cloud
   cd ~/src/claude-memory-cloud
   ```

2. Run the setup script with the server address and your scope. Try it with `--dry-run` first: it shows the exact changes to `~/.claude/settings.json` and `~/.claude/CLAUDE.md` without making them.

   ```bash
   ./setup.sh --worker-url <server> --login <you> --scope general=<you>/claude-memory --dry-run
   ./setup.sh --worker-url <server> --login <you> --scope general=<you>/claude-memory
   ```

3. Restart any running Claude Code sessions.

The script:
- turns off Claude Code's built-in local memory (`"autoMemoryEnabled": false`), remembering your previous setting for uninstall
- adds the memory routing rule to `~/.claude/CLAUDE.md`, between `<!-- claude-memory-cloud:routing-rule:begin -->` and `…:end -->` marker lines
- adds three hooks to `~/.claude/settings.json` next to any hooks you already have: on each prompt, at session start (queued saves, a health check, a stale read-only copy of your memory index), and after each `memory_index` call
- allows Claude to write outbox files in `~/.claude-memory-cloud/` and to call the read-only memory tools without asking (`memory_save` and `memory_delete` still ask). If it prints "no memory MCP server found", rerun with `--mcp-server <name>`, using the connector name `/mcp` shows
- keeps a timestamped backup of each file it changes
- prints a health report: one line per problem, with what to do about it

It's safe to run again; rerunning without `--scope` keeps your current scopes. Rerun it after pulling a new version of the code (the session-start check says "Memory hooks are out of date" when the server needs a newer kit).

**Machine names in commits:** each commit records where Claude ran, e.g. "claude-code on <hostname>". Add `--neutral-source` to `./setup.sh` to record just "claude-code".

**For cloud sessions:** hooks don't run there. In your Claude Code cloud environment's settings, add the environment variable `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. A save that fails in the cloud is reported as "not saved" (there is no outbox).

**What goes where:** GitHub memory holds facts about work. Personal matters (health, finances, family, home and travel, beliefs, legal matters) are refused and belong in claude.ai's built-in memory. See "What should never go in GitHub memory?" in the [FAQ](FAQ.md).

---

## Part 6 — Check it works

1. In a terminal: `python3 ~/.claude-memory-cloud/kit/bin/memkit.py preflight`. It should print `preflight: all local checks passed (memory server reachable, hooks current).`
2. Start `claude` in any git repo. Claude should load your memory index without being asked.
3. Say: *"Save a memory that I prefer small commits."* Claude should answer with **"saved to general"**. Check `https://github.com/<you>/claude-memory` for the new commit.
4. On your phone, in the Claude app, ask: *"What do you remember about how I like commits?"*

To bring over memories that Claude Code's built-in memory kept before setup, see [MIGRATE.md](MIGRATE.md).

---

## If something goes wrong

- **"This GitHub account isn't on this memory server"**: see Part 4, step 4.
- **"This GitHub account is no longer on this memory server's allowlist."**: your host removed you. Ask them.
- **Sign-in refused after you deleted and recreated your GitHub account:** the server remembers each account's numeric GitHub ID. Ask your host to clear it.
- **The server is down:** Claude Code queues saves in `~/.claude-memory-cloud/outbox/` and sends them at the next session start. Your memories are safe in your repo either way.
- More in the Troubleshooting section of the [FAQ](FAQ.md).

---

## Leaving

Your memories are in your own repo and stay there.

1. On each machine: `cd ~/src/claude-memory-cloud && ./setup.sh --uninstall`. To take your memories into Claude Code's built-in memory first, see [UNINSTALL.md](UNINSTALL.md), section 1.
2. claude.ai → **Settings** → **Connectors** → claude-memory → **Remove**. Remove `CLAUDE_CODE_DISABLE_AUTO_MEMORY` from your cloud environment if you set it.
3. GitHub → **Settings** → **Applications** → **Installed GitHub Apps** → `<slug>` → **Uninstall**. Then **Authorized GitHub Apps** → `<slug>` → **Revoke**. The server loses access immediately.
4. Tell your host, so they remove you from the allowlist.

The server's cache may keep copies of memories it read for up to 7 days after you leave.
