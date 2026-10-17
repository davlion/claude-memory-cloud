# claude-memory-cloud — Quickstart

> A bootstrap script is planned that will automate most of Parts 1 and 3–5 (Part 2 stays manual). Until then, every part below is done by hand.

claude-memory-cloud gives Claude one set of memories everywhere: Claude Code on any machine, Claude Code cloud sessions, and claude.ai chat on web, Desktop, and mobile. The memories are Markdown files in a private GitHub repo that you own. A small server, which you deploy to your own Cloudflare account, connects that repo to Claude as a custom connector.

You'll set up four things:

| What | Where | Cost | Time |
|---|---|---|---|
| A private memory repo | your GitHub account | free | 1 min |
| A Cloudflare account | cloudflare.com | Workers Paid, $5/month (needed for CPU time; see the FAQ) | 10 min |
| A GitHub App (lets the server use your memory repo, and nothing else) | your GitHub account | free | 10 min |
| The server, deployed as a Cloudflare Worker | your Cloudflare account | included in Workers Paid | 10 min |

Then you connect it to Claude and run a setup script on each machine.

**Placeholders used below:** `<you>` is your GitHub username. `<sub>` is your Cloudflare `workers.dev` subdomain (chosen in Part 2). `<slug>` is your GitHub App's URL name (Part 3).

---

## Before you start

- A GitHub account.
- A claude.ai account (Pro, Max, Team, or Enterprise; custom connectors are needed).
- Node.js 20 or later on your Mac, for `npx`. Check with `node --version`.
- A password manager or other safe place for one secret (the GitHub App's client secret). You'll paste it into a terminal once; it's never stored in a repo.

---

## Part 1 — Create your memory repo

1. On github.com, click **+** → **New repository**.
2. **Owner:** you. **Name:** `claude-memory`.
3. **Private.** ✅
4. Leave it **empty**: no README, no .gitignore, no license. The server initializes it on the first save.
5. Click **Create repository**.

✔ You now have `https://github.com/<you>/claude-memory`.

> Never put secrets in this repo. The server's secret check is best effort: it catches common token formats, not every password.

---

## Part 2 — Create a Cloudflare account

1. Sign up at <https://dash.cloudflare.com/sign-up> and verify your email. Cloudflare offers sign-in with Apple, with GitHub, or with email and password. **Email and password** (kept in a password manager) is recommended: it keeps this account independent of your GitHub login, so one compromised account can't reach both your memory repos and the server that accesses them. If you use Apple, share your real email rather than a Hide My Email relay address.
2. **Turn on two-factor authentication:** click the profile icon (top right) → **My Profile** → **Authentication** → set up two-factor authentication. Your server will hold access to your memory repo, so protect this account.
3. **Upgrade to Workers Paid ($5/month):** **Workers & Pages** → **Plans** → **Workers Paid**. The server doesn't work on Free: each call needs more CPU time than Free allows (see "Which Cloudflare plan?" at the end of Part 5). The first `npm run deploy:*` asks you to confirm this once.
4. In the left sidebar, open **Workers & Pages** (under Compute). Cloudflare may assign a **workers.dev subdomain** automatically (often derived from your name or email) rather than asking. Find it on the Workers & Pages overview under **Subdomain**. Keep it, or change it now: it becomes part of your server's URL, which appears in your GitHub App and claude.ai settings. Changing it after Part 3 means updating the app's callback URL too.
5. Write down the subdomain: `<sub>`. Your server's address will be `https://claude-memory.<sub>.workers.dev`.
6. Log the command-line tool in. In a terminal:

   ```bash
   npx wrangler@4.150.0 login
   ```

   A browser window opens; click **Allow**. Wrangler asks for broad access to your Cloudflare account by default (Workers plus many other products). That's normal; the credentials stay in wrangler's config on your machine.
7. Check it worked:

   ```bash
   npx wrangler@4.150.0 whoami
   ```

   It prints your account name and ID.

✔ You have a Cloudflare account with 2FA and Workers Paid, a subdomain, and `wrangler` logged in.

---

## Part 3 — Create the GitHub App

The GitHub App is how the server gets access to your memory repo, **and only that repo**. It acts as you, so it can never do more than you can, and commits show up under your name.

1. Go to <https://github.com/settings/apps/new> (or: profile picture → **Settings** → **Developer settings** → **GitHub Apps** → **New GitHub App**). Make sure it's **GitHub Apps**, not **OAuth Apps**: the right form has a **Permissions** section further down.
2. Fill in:

   | Field | Value |
   |---|---|
   | GitHub App name | `<you>-claude-memory` (must be unique on GitHub) |
   | Homepage URL | `https://claude-memory.<sub>.workers.dev` |
   | Redirect URI (called "Callback URL" on older versions of the page) | `https://claude-memory.<sub>.workers.dev/callback` |
   | Expire user authorization tokens | ✅ checked (the default) |
   | Request user authorization (OAuth) during installation | ☐ unchecked |
   | Enable Device Flow | ☐ unchecked |
   | Webhook → Active | ☐ **unchecked** |

3. **Permissions → Repository permissions:**
   - **Contents:** Read and write
   - **Metadata:** Read-only (GitHub sets this automatically)
   - Everything else: No access

   **Account permissions:** leave all at No access.
4. **Where can this GitHub App be installed?** → **Any account**. This lets a client organization install it on their own memory repo later. It does *not* list your app publicly.
5. Click **Create GitHub App**.
6. On the app's page, write down:
   - **Client ID** (starts with `Iv`)
   - the **slug**: the last part of the app's public URL, `https://github.com/apps/<slug>`
7. Click **Generate a new client secret**. Copy it into your password manager **now**; GitHub shows it only once.
8. **Do not** generate a private key. The server doesn't need one.

✔ You have a GitHub App with a Client ID, a slug, and a client secret saved safely.

---

## Part 4 — Install the app on your memory repo

1. Go to `https://github.com/apps/<slug>/installations/select_target`. (This link always shows the account picker. The similar `…/installations/new` link skips it and opens an existing installation's settings once the app is installed anywhere.)
2. Choose your personal account.
3. Select **Only select repositories** → `claude-memory`.
4. Click **Install**.

✔ The app can reach `<you>/claude-memory` and nothing else.

---

## Part 5 — Deploy the server

1. Get the code and install exactly the locked dependencies:

   ```bash
   git clone https://github.com/<owner>/claude-memory-cloud
   cd claude-memory-cloud
   npm ci
   ```

2. Create the two storage namespaces, and paste each printed `id` into the `env.production` section of `wrangler.jsonc`:

   ```bash
   npx wrangler kv namespace create OAUTH_KV
   npx wrangler kv namespace create CACHE_KV
   ```

3. In the `env.production` section of `wrangler.jsonc`, set:
   - `PUBLIC_URL` → `https://claude-memory.<sub>.workers.dev`
   - `GITHUB_APP_SLUG` → `<slug>`

4. Write your scope map to `scopes.production.json`. The file is gitignored; keep a copy in your password manager. It lists who may sign in and which repos each person's memories live in:

   ```json
   {"<you>": {"general": "<you>/claude-memory"}}
   ```

5. Set the secrets. Each `secret put` prompts for a value (paste it there, not on the command line), except `SCOPES`, which is read from the file. Always run `node scripts/check-scopes.mjs <file>` first (it prints `OK` or what is wrong): a malformed `SCOPES` secret makes every sign-in and every memory call fail with "memory server misconfigured: SCOPES is invalid".

   ```bash
   scripts/wrangler.sh secret put GITHUB_CLIENT_ID --env production        # the Client ID from Part 3
   scripts/wrangler.sh secret put GITHUB_CLIENT_SECRET --env production    # the client secret from Part 3
   node scripts/check-scopes.mjs scopes.production.json && scripts/wrangler.sh secret put SCOPES --env production < scopes.production.json
   ```

6. Deploy and check:

   ```bash
   npm test && npm run deploy:production
   curl -sS https://claude-memory.<sub>.workers.dev/health
   ```

   Expected: `{"ok":true,...}`.

7. **Optional: swap the broad login for a scoped token.** The `wrangler login` token can reach almost everything in your Cloudflare account, and anyone who gets it can redeploy your server to read every user's GitHub tokens. Once both Workers exist, you can replace it:
   1. Cloudflare dashboard → **My Profile** → **API Tokens** → **Create Token** → **Custom token**. Add the **Workers** permission with the **Editor** role, scoped to the individual Workers `claude-memory` (and `claude-memory-staging` if you have one). Don't use the legacy "Workers Scripts" permission. Optionally add IP filtering and an expiry date.
   2. Store it in the keychain (it prompts for the token): `security add-generic-password -a "$USER" -s cloudflare-claude-memory -w`
   3. Check it: `npm run deploy:production`, then `scripts/wrangler.sh deployments list --env production`. `npm run deploy:*` and `scripts/wrangler.sh` read the token from the keychain.
   4. Revoke the broad token: `env -u CLOUDFLARE_API_TOKEN npx wrangler logout`. It must print "Successfully logged out."; while `CLOUDFLARE_API_TOKEN` is set, a plain `wrangler logout` does nothing.

   Editor covers deploys, `secret put` and `wrangler tail`. KV commands and creating or deleting a Worker need the broad login: run `npx wrangler login`, then the command with `env -u CLOUDFLARE_API_TOKEN npx wrangler …`, then log out as in step 4.

**Which Cloudflare plan?** Workers Paid ($5/month). Each call uses about 30–110 ms of CPU and the free plan allows 10 ms, so on Free most calls would fail with "exceeded resource limits". Upgrade under Workers & Pages → Plans before deploying. See "What are the Cloudflare limits?" in the FAQ for the measurements.

---

## Part 6 — Connect it to Claude

1. On claude.ai: **Settings** → **Connectors** → **Add custom connector**.
   - **Name:** `claude-memory`
   - **URL:** `https://claude-memory.<sub>.workers.dev/mcp`
2. Click **Connect**. Your browser shows your server's consent page ("Allow Claude to use your claude-memory?"). Click **Allow**. You're then sent to GitHub to approve the app; if your browser is already signed in to GitHub (and Cloudflare), these pages recognize it and go quickly. Make sure the browser is signed in to the GitHub account that owns your memory repo. You'll see this consent page every time you connect a new client; there's no "remember me".
3. Test it: in a new chat, ask *"What's in my memory index?"* You should see a health line and your index. A better test once you have a memory: ask about it in plain words (e.g. *"What kind of soup do I like?"*) and check that Claude finds it without being told to look.
4. If you see **"This GitHub account isn't on this memory server"**, the GitHub account you approved with isn't in `SCOPES`. Sign in to GitHub with the right account, or add yours to `scopes.production.json` and rerun `node scripts/check-scopes.mjs scopes.production.json && scripts/wrangler.sh secret put SCOPES --env production < scopes.production.json`.

The connector now works in claude.ai chat (web, Desktop, mobile), in Claude Code cloud sessions, and in local Claude Code when you're logged in with your claude.ai account.

5. In chat, the connector can be switched on or off per chat from the **+** menu in the message box. Leave claude.ai's built-in memory on: it is where personal facts belong (see "What about claude.ai's built-in memory?" in the [FAQ](FAQ.md)).

---

## Part 7 — Set up each machine

Do this on every Mac or VM where you use Claude Code. It needs Python 3.9 or later; macOS has it once the Command Line Tools are installed (`xcode-select --install`).

1. Get this repo onto the machine (clone it, or copy it from your Mac: `rsync -a --exclude node_modules --exclude '.dev.vars*' --exclude 'scopes.*.json' --exclude .wrangler ~/src/claude-memory-cloud/ <vm>:src/claude-memory-cloud/`).
2. Run the setup script with your server's URL and your scopes.
   - **On the machine that has `scopes.production.json`:**
     ```bash
     cd ~/src/claude-memory-cloud
     ./setup.sh --worker-url https://claude-memory.<sub>.workers.dev --scopes-file scopes.production.json --login <you> --dry-run
     ./setup.sh --worker-url https://claude-memory.<sub>.workers.dev --scopes-file scopes.production.json --login <you>
     ```
   - **Anywhere else** (a VM, or a friend using your server): pass your scopes directly, the same values as your entry in `SCOPES`:
     ```bash
     ./setup.sh --worker-url https://claude-memory.<sub>.workers.dev --login <you> \
       --scope general=<you>/claude-memory --scope <client>=<client-org>/claude-memory
     ```
   `--dry-run` shows the exact changes to `~/.claude/settings.json` and `~/.claude/CLAUDE.md` without making them.
3. Restart any running Claude Code sessions.

The script:
- turns off Claude Code's built-in local memory (`"autoMemoryEnabled": false`), remembering your previous setting for uninstall
- adds the memory routing rule to `~/.claude/CLAUDE.md`, between `<!-- claude-memory-cloud:routing-rule:begin -->` and `…:end -->` marker lines
- adds three hooks to `~/.claude/settings.json` next to any hooks you already have: one on each prompt (a reminder when you ask Claude to remember something), one at session start, including after compaction (queued saves, a health check, and a stale read-only copy of your memory index), and one after each `memory_index` call that silently saves that copy
- allows Claude to write outbox files in `~/.claude-memory-cloud/` without asking (the index snapshot is written by a hook, not by Claude), to run `date -u …` and `git remote get-url origin`, and to call the read-only memory tools `memory_index`, `memory_read` and `memory_search` without asking (`memory_save` and `memory_delete` still ask). The tool names contain your connector's name, `mcp__<name>__memory_index` and so on, so the script finds that name in `~/.claude.json` by matching the server's URL to `--worker-url`. If it prints "no memory MCP server found", the server is probably a claude.ai connector or not added to Claude Code yet; rerun with `--mcp-server <name>` using the name `/mcp` shows; the flag can be repeated and is used in addition to anything it finds
- keeps a timestamped backup of each file it changes (`settings.json.bak-<time>`, `CLAUDE.md.memkit-backup-<time>`)
- prints a health report: one line per problem, with what to do about it

**What goes where:** GitHub memory holds facts about work. Candid opinions and facts about other people are declined unless you explicitly ask for `general`; intimate and personal matters (health, finances, family, home and travel, your rates and contracts, beliefs, legal matters) are refused everywhere and belong in claude.ai's built-in memory; machine names and addresses are saved only after Claude asks. A client's information never goes into another client's scope. The server checks every save as a backstop: it refuses personal and cross-client text it recognizes, but it matches patterns, so unusual wording can pass. See "What should never go in GitHub memory?" in the [FAQ](FAQ.md).

**Machine names in commits:** each commit records where Claude ran, e.g. "claude-code on <hostname>", which a client can see in their repo. Add `--neutral-source` to `./setup.sh` to record just "claude-code" (`--no-neutral-source` undoes it; the choice is kept on reinstall).

It's safe to run again; rerunning without `--scopes-file`/`--scope` keeps your current scopes. Rerun it after pulling a new version of this repo (the session-start check says "Memory hooks are out of date" when the server needs a newer kit).

**Which Python:** the hooks run with one fixed interpreter, recorded at setup. The script uses `/usr/bin/python3` when the Command Line Tools are installed (the path survives upgrades). Otherwise it uses the `python3` on your `PATH`, recorded as its real path; if that is a Homebrew path with a version in it, rerun `./setup.sh` after `brew upgrade` moves it. To choose one yourself, run `MEMKIT_PYTHON=/path/to/python3 ./setup.sh …`.

**Exit codes:** 0 done; 1 installed, but the health report found problems; 2 bad arguments, no usable Python, or a settings file the script refused to edit (nothing is changed).

**What lives where:** `~/.claude-memory-cloud/` holds the installed hooks, your scope map, the outbox (`outbox/`: saves queued while the server was unreachable) and the snapshot cache (`cache/`). It is outside `~/.claude` on purpose: Claude Code asks before every write under `~/.claude`, and allow rules can't change that.

**For cloud sessions:** hooks and `~/.claude` settings don't run there. In your Claude Code cloud environment's settings, add the environment variable `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. The server's own instructions cover the rest. There is no outbox in the cloud: a save that fails is reported as "not saved". Start cloud sessions from the repository picker on claude.ai/code where you can: a session made with `claude --cloud` from a local folder has no git remote, so Claude has to ask which repo it is before saving project memories.

---

## Part 8 — Check it works

1. In a terminal, in any repo, check the local half: `python3 ~/.claude-memory-cloud/kit/bin/memkit.py preflight`. It should print `preflight: all local checks passed (memory server reachable, hooks current).`
2. Start `claude` in any git repo. Claude should load your memory index without being asked. Run `/context`: there should be no auto-memory entry.
3. Say: *"Save a memory that I prefer small commits."* Claude should answer with **"saved to general"**. Check `https://github.com/<you>/claude-memory` for the new commit.
4. Check that `~/.claude-memory-cloud/cache/` now holds a snapshot named after the repo (`<owner>__<repo>.md`).
5. On your phone, in the Claude app, ask: *"What do you remember about how I like commits?"*

To remove everything, see [UNINSTALL.md](UNINSTALL.md).

---

## Adding a client organization

To keep a client's memories in the client's own GitHub org:

1. **The client** (an org owner) creates a private, empty repo `<client-org>/claude-memory`. They add you to it if you don't already have access.
2. Make sure your app is public, so other accounts can install it: open `https://github.com/settings/apps/<slug>/advanced`. If the Danger zone offers **Make public**, click it (this doesn't list the app anywhere; it only allows other accounts to install it). If the client's org doesn't appear in the install page's account picker, this is the usual cause.
3. **The client** installs your app: `https://github.com/apps/<slug>/installations/select_target` → their org → **Only select repositories** → `claude-memory`. No secrets change hands.
4. **You** add the scope under your login in `scopes.production.json`, e.g. `{"<you>": {"general": "<you>/claude-memory", "acme": "acme-org/claude-memory"}}`, then run `node scripts/check-scopes.mjs scopes.production.json && scripts/wrangler.sh secret put SCOPES --env production < scopes.production.json`. No redeploy is needed: the secret takes effect immediately.
5. **You** add the scope to each machine's local scope map: rerun `./setup.sh --scopes-file scopes.production.json --login <you>` where that file is, or `./setup.sh --login <you> --scope general=<you>/claude-memory --scope <client>=<client-org>/claude-memory` elsewhere.

**Before you start writing client memories,** agree these with the client (whatever is written there loads into your Claude sessions, so write access matters):
- Only named people can write `<client-org>/claude-memory`. Org-wide apps and Actions shouldn't be able to write it: exclude the repo from "All repositories" app installs, and set Actions permissions for the repo to read-only.
- A ruleset on the default branch that blocks force pushes and deletion (repo Settings → Rules → Rulesets → New branch ruleset → target the default branch → Restrict deletions, Block force pushes). Don't require pull requests or signed commits: the server pushes directly, and such rules make saves fail with `write_rejected`.
- Visibility changes limited to org owners (org Settings → Member privileges → "Allow members to change repository visibilities": off).
- The app installed on that one repo only. Health fails with `installation:<org>` if it can reach all repositories.

Then give them the disclosure in the FAQ ("What should I tell a client?").

Memory loading follows context: in a Claude Code session inside one of the client's repos you get general + the client + that project. In claude.ai chat you get general only, unless you name the client.

Memories about the client's codebases go to `<client-org>/claude-memory` under `projects/<repo>/`. If the client removes you from the org or uninstalls the app, access ends immediately.

---

## Letting a friend use your server

Up to about five people can share one server, each with their own repos. Nobody sees anyone else's scopes. Your friend follows [QUICKSTART-FRIEND.md](QUICKSTART-FRIEND.md); your side is:

1. Make sure your app is public, because a private app can be installed only by its owner account: see "Adding a client organization", step 2 ("Make public").
2. Send your friend the server address `https://claude-memory.<sub>.workers.dev`, your app's `<slug>`, and access to this repo for the local kit (if it's private, add them as a collaborator with **Read** access).
3. When they send you their GitHub username, add them to `scopes.production.json`: `{"<you>": {…}, "<friend>": {"general": "<friend>/claude-memory"}}`, then rerun `node scripts/check-scopes.mjs scopes.production.json && scripts/wrangler.sh secret put SCOPES --env production < scopes.production.json`. Tell them when it's done.

The server pins each login to its numeric GitHub ID at first sign-in. If someone deletes and recreates their GitHub account under the same name, sign-in is refused until you delete the pin: `npx wrangler kv key delete --binding OAUTH_KV --env production --remote "allowlist:github-id:<login, lower-case>"` (with a scoped token, this KV command needs the temporary login described at the end of Part 5, step 7). Existing grants with the old ID are refused until that user reconnects.

To remove someone, delete their entry from `SCOPES` and rerun `secret put`: their next request gets a 403, "This GitHub account is no longer on this memory server's allowlist.", and a fresh sign-in shows "This GitHub account isn't on this memory server".

---

## Appendix — Development and test setup

Only needed if you're working on claude-memory-cloud itself.

1. **Staging server and app:** create a **separate** GitHub App for staging (same settings as Part 3, named `<you>-claude-memory-staging`, with only the callback `https://claude-memory-staging.<sub>.workers.dev/callback`). Install it only on the test repos below. Staging tokens then can't reach production or client repos. Staging is the top-level config in `wrangler.jsonc`, deployed with `npm run deploy:staging`; its secrets (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SCOPES` from `scopes.staging.json`) are set without `--env`.
2. **Test memory repo:** create a private, empty repo `<you>/claude-memory-test`, and add it to the app installation on your account.
3. **Test client org:** create a free organization (github.com → **+** → **New organization** → **Free**), e.g. `<you>-test-client`. In it, create private repos `claude-memory` (empty) and `sample-app` (with a README). Install the app on that org, selecting only `claude-memory` (never `sample-app`: the app needs only the memory repo, and project memories for `sample-app` live in `claude-memory` under `projects/sample-app/`). If the org isn't offered on the install page, make the app public first (see "Adding a client organization", step 2).
4. **Local secrets:** in the repo, create `.dev.vars` (it's gitignored):

   ```
   GITHUB_CLIENT_ID=<staging app client id>
   GITHUB_CLIENT_SECRET=<staging app client secret>
   SCOPES={"<you>":{"general":"<you>/claude-memory-test"}}
   ```
