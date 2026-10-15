# Uninstalling claude-memory-cloud

Each part is independent: remove the local kit from one machine and keep using the connector elsewhere, or remove everything.

## 1. Optional: export your memories to Claude Code's local memory

Claude Code's built-in memory is per project. To take the general and project memories for a repo with you, do this **before** uninstalling, in each repo you care about:

1. `cd <the repo> && ~/src/claude-memory-cloud/setup.sh --export-local`
2. The script prints a prompt. Start `claude` in that repo and paste it. Claude reads your memories through the connector and writes them to `~/.claude-memory-cloud/export/`, then runs the finishing command, which copies them into `~/.claude/projects/<repo>/memory/` and adds them to that folder's `MEMORY.md`.

Notes:
- A general memory whose name clashes with a project memory is saved as `general-<name>.md`. An existing local file is never overwritten; the cloud copy is saved next to it as `<name>.cloud.md`.
- Client memories aren't exported. Ask Claude for them by name if you want them.
- If the connector no longer works, open `https://github.com/<you>/claude-memory` (and `projects/<repo>/memories/` there) and copy the files you want into `~/.claude/projects/<repo>/memory/` by hand. The file format is identical.

## 2. Remove the local kit (each Mac or VM)

```bash
cd ~/src/claude-memory-cloud
./setup.sh --uninstall --dry-run     # shows the changes
./setup.sh --uninstall
```

This removes the two hooks, the routing rule (between its marker lines), the allow rules the kit added (including the `mcp__<name>__memory_index/read/search` rules for the names setup used, and `Bash(git remote get-url origin)`; a rule you already had before setup is left alone), the scope map, the Worker URL and the installed kit. It puts `autoMemoryEnabled` back to what it was before setup (removing the line if you had none). Nothing else in `settings.json` or `CLAUDE.md` changes. A timestamped backup of each changed file is kept next to it (`settings.json.bak-<time>`, `CLAUDE.md.memkit-backup-<time>`).

- **Queued saves:** if `~/.claude-memory-cloud/outbox/` still holds memories, uninstall stops (exit code 3), says how many, and changes nothing. Start Claude Code in any repo while the connector works; it flushes them at session start. Then rerun. `--force` uninstalls anyway and leaves the queued files where they are.
- **Snapshot cache:** you're asked before `~/.claude-memory-cloud/cache/` is deleted. Use `--delete-cache` or `--keep-cache` to answer in advance; without a terminal to ask, the cache is kept.
- If the kit's `state.json` is already gone, uninstall still removes the kit's hooks and allow rules but leaves `autoMemoryEnabled` as it is, and says so. Set it back by hand if you want Claude Code's built-in memory on.
- Running it again is harmless ("Nothing to uninstall.").
- Restart running Claude Code sessions.

## 3. Account side

- claude.ai → **Settings** → **Connectors** → claude-memory → **Remove**.
- Remove `CLAUDE_CODE_DISABLE_AUTO_MEMORY` from your Claude Code cloud environment's variables.
- GitHub → **Settings** → **Applications** → **Authorized GitHub Apps** → revoke the memory app.
- Uninstall the app from each account and org that installed it (GitHub → Settings → Applications → Installed GitHub Apps; org owners do this for their org).

## 4. If you host the server yourself

- `npx wrangler delete` (staging) and `npx wrangler delete --env production`.
- Delete the KV namespaces in the Cloudflare dashboard (Workers & Pages → KV).
- Delete the GitHub App (GitHub → Settings → Developer settings → GitHub Apps → the app → Advanced → Delete).
- Your memory repos stay yours: keep them, archive them, or delete them.
