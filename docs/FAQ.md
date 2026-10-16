# claude-memory-cloud — FAQ

## What it is

### What problem does this solve?
Claude Code's built-in memory lives in files on one machine. claude.ai chat has its own separate memory. Neither reaches the other, or your other machines. claude-memory-cloud keeps one set of memories in a private GitHub repo and makes it available to every Claude surface through a custom connector.

### Which Claude surfaces does it work with?
- Claude Code on any Mac, Linux machine, or VM
- Claude Code cloud sessions
- claude.ai chat on web, Desktop, and mobile

Local Claude Code needs to be logged in with your claude.ai account for the connector to appear.

### What are scopes?
Each memory belongs to one of three kinds of scope:
- **general:** about you and how you work. Lives in `<you>/claude-memory`.
- **client:** about a client organization as a whole. Lives in the client's own repo, e.g. `acme-org/claude-memory`.
- **project:** about one codebase. Lives under `projects/<repo>/` in the memory repo of whoever owns that codebase.

Claude picks the scope from what you said and where you're working, and asks in one line when it's unclear.

### How does it know which project I'm in?
From the git `origin` remote of the directory Claude Code is running in. So the same project gets the same memories on every machine, whatever the local folder is called. With no git remote, only general and client memories apply.

## Security and privacy

### Who can see my memories?
| Where | What | For how long | Who can read it |
|---|---|---|---|
| Your GitHub repo and its history | every version | until you delete or rewrite it (deleting a memory leaves it in history) | you and the repo's collaborators (for a client repo: the client's org, every project's notes included) |
| The server (Cloudflare Worker) | memory text passes through in plaintext | per request | whoever controls the Cloudflare account |
| The server's cache (Cloudflare KV) | copies of memory text | up to 7 days, even after a memory is deleted or access is removed | whoever controls the Cloudflare account |
| Anthropic | every memory Claude reads in a conversation | under your Claude account's history and data settings | Anthropic, and your claude.ai account |
| Your computers | Claude Code session logs include memories Claude read | Claude Code's cleanup period (about 30 days) | your user account and its backups |

The server logs no memory content and no tokens.

### Is Cloudflare in the middle a security risk?
The server sees memory text in plaintext, because that's how TLS works at Cloudflare's edge. Mitigations:
- The GitHub App can touch only the memory repos it's installed on, nothing else, and only with your own access.
- Memories must never contain secrets. The server's check is best effort: it catches common token formats (GitHub, AWS, Stripe, npm, Azure, private keys, credentials in URLs…), not every password.
- Every change is a commit in your repo, so there's a full audit trail.
- A client that prefers it can host its own copy of the server.

### Why a GitHub App instead of a personal access token?
A GitHub App is installed on specific repos and requests only one permission (contents). Its effective access is the overlap of three things: what the app may do, which repos it's installed on, and what you yourself can access. A personal token usually reaches everything you can reach. Fine-grained personal tokens can be narrowed too, but they're per-user, harder to manage, and can't be granted by a client org owner the way an app installation can.

### What happens if a client removes my access?
It ends immediately. Uninstalling the app, or removing you from the org, cuts off that scope. The health check then reports the scope as unreachable and says what to do.

### Does the server need the GitHub App's private key?
No. It acts only as you, using user tokens that expire after 8 hours and refresh automatically. No private key is generated or stored.

### How long does a connection last?
A connection stays signed in as long as you use it at least once every 30 days, up to 180 days from when you connected. Then Claude asks you to reconnect (claude.ai → Settings → Connectors → claude-memory → Disconnect, then Connect). The GitHub sign-in behind it refreshes itself every 8 hours.

In a rare double failure (a transient GitHub error during a refresh race, or rotated tokens plus a failed grant write) a connection can answer "temporarily unavailable" for up to about 2 hours and then need reconnecting.

### I saved a secret by accident. What now?
1. Rotate the credential first. Treat it as leaked.
2. Delete the memory (ask Claude to).
3. Optionally rewrite the repo history to remove it. Cached copies on the server expire within 7 days.

### Is memory content trusted?
No. Anyone who can write a memory repo can write text that Claude will read. Claude is told that memory content is data, not instructions: it doesn't run commands or follow links because a memory says to, and it doesn't copy facts between scopes unless you ask. The server's own messages (Health, Since, change notices) carry a per-response marker that memory text can't fake. If a memory repo changes outside the server, Health warns (`provenance:<repo>`) with a link to review the change.

### What should I tell a client?
Something like this (adapt as needed):

> **What this is.** I use a tool that gives my AI assistant (Claude, made by Anthropic) a memory that carries over between work sessions. Notes about your organization and codebases are stored as Markdown files in a private repository **in your GitHub org** (`<org>/claude-memory`). You own it, you control who can see it, and you can delete it.
>
> **What gets stored.** Short working notes: conventions, decisions, how your systems fit together, things to avoid. No passwords, keys or credentials. The server rejects things that look like credentials, but that check is best effort, so please tell me if you ever see one.
>
> **Where the notes travel.** GitHub stores them, in your repo. My server runs on Cloudflare under my account; notes pass through it in readable form, and it keeps a cached copy for up to 7 days, including after a note is deleted or after you remove my access. Anthropic sees a note whenever Claude reads it in one of my sessions. My computers keep session logs that include notes Claude read, normally for about 30 days.
>
> **Who can see them.** Anyone in your org with read access to `<org>/claude-memory`, including notes about every project (access isn't split per codebase); me; and the providers above, as processors.
>
> **What my access covers.** The GitHub App you install should be limited to the single `claude-memory` repository ("Only select repositories"). It can't read your other repositories. Changes are commits under my GitHub account, so you have a full history.
>
> **Ending access.** Uninstall the app or remove me from the repo, and access stops immediately. Cached copies on my server expire within 7 days, and I'll delete my local copies when we finish. Git history in your repo stays until you delete or rewrite it.
>
> **What I'd ask of you.** Keep write access to `<org>/claude-memory` limited to the people who need it, because what's written there is read by my assistant. Keep the repo private, and limit visibility changes to org owners. Install the app on that repo only.

### Can friends use my server?
Yes, up to about five people. `SCOPES` lists who may sign in and which repos each person's memories live in; nobody sees anyone else's scopes. See "Letting a friend use your server" in the Quickstart.

### Why does memory in claude.ai chat show only my general memories?
Loading follows context. In a Claude Code session inside a repo you get general + the client that owns the repo + that project. Without a repo (chat) you get general only, so one client's notes don't show up in unrelated conversations. Name the client ("what do we know about acme?") and Claude loads that scope too.

## Day to day

### How do I save a memory?
Say it naturally: "save a memory that we deploy on Tuesdays", "remember that…", "don't do X again". Claude ends every save attempt with exactly one of:
- **"saved to <scope>"**
- **"queued in outbox for <scope>"**
- **"not saved: <reason>"**

### What happens if I save while the server is unreachable?
In local Claude Code, the memory goes into an outbox (`~/.claude-memory-cloud/outbox/`). Claude flushes it at the next session start where the server works, through the normal checks. In cloud sessions and chat there's no local disk, so Claude tells you it wasn't saved.

### Can I still read memories offline?
In local Claude Code, yes, but read-only and possibly out of date. After each successful load, Claude keeps a snapshot of your memory index, and the session-start hook loads it, labeled with its date. Full memory text and search need the server.

### If I save a memory on my laptop, when do my other sessions see it?
- **New sessions:** immediately; they load the latest index at start.
- **Sessions already running:** on their next memory tool call. The server notices the index has changed and sends the new one along with the result.

Nothing is pushed to a session that's sitting idle.

### Should I keep sessions short so memories stay fresh?
No. Memories rarely change mid-session, and a long session's working context is worth more than a perfectly current index. The one real risk in long sessions is context compaction, which can drop the memory index. Claude re-loads it after compaction.

### What if two sessions edit the same memory at once?
Nothing is lost. The second save finds the memory changed since it was read, and is saved as a conflict copy. The index lists conflicts, and Claude offers to merge them.

### What if I save something that's almost the same as an existing memory?
The server checks for similar memories and asks Claude to update the existing one instead, unless you really want a separate memory.

### Can I edit memories by hand?
Yes. They're plain Markdown files in your repo. The index is rebuilt from the files every time it's read, and Health notes that the repo was changed outside the server so you know to review it.

### What about Claude Code's built-in memory?
The setup script turns it off, so memories don't end up in two places. Your existing local memory files are left in place as a backup.

### Why does the kit live in `~/.claude-memory-cloud` and not `~/.claude`?

Claude writes two kinds of local files: a stale snapshot of your memory index (so a session still has something when the server is unreachable) and outbox entries (saves queued while the server is down). Claude Code treats everything under `~/.claude` as protected: every write there asks for permission, and allow rules can't change that. Under `~/.claude-memory-cloud` the setup script's allow rules apply, so these writes happen silently. Only `~/.claude/settings.json` (hooks, auto-memory off) and `~/.claude/CLAUDE.md` (the routing rule) are changed inside `~/.claude`.

## Setup and operations

### What does it cost?
GitHub private repos and the GitHub App are free. The server needs **Cloudflare Workers Paid ($5/month)**: each call uses about 30–110 ms of CPU (measured below), and the free plan allows 10 ms. Everything else about the design stays within the free plan's limits, so if the per-call overhead is reduced later, Free may become an option again.

### What are the Cloudflare limits, and what happens when they're hit?
Limits that matter here (the free plan's numbers; Workers Paid raises all of them far beyond personal use):
- **100,000 requests a day.** Past that, Cloudflare answers for the server ("error 1027") until 00:00 UTC. Claude sees the connector as unavailable: local Claude Code queues saves in the outbox; elsewhere Claude says the memory wasn't saved.
- **50 outgoing requests per call.** One `memory_index` for general + a client + a project makes about 15 GitHub requests. If a call still hits the limit, the scope being read fails with `server_limit`. Once a call has run out of subrequests, every later request in that same call fails too, so later scopes in the same call may also report `server_limit`; trying again later works.
- **1,000 KV writes a day.** The cache is optional: if writes fail, reads still work and Health shows `kv_writes`. Signing in and token refresh need KV, so they can fail until 00:00 UTC; they never disconnect you.
- **10 ms of CPU per request on Free; 30 seconds on Paid.** The server currently needs more than 10 ms per call (see the table below), which is why Workers Paid is required.
- Sign-in endpoints are rate-limited to about 10 requests a minute per address. Cloudflare's rate limiter is approximate (it counts per data center and errs on the permissive side), so expect occasional 429s after a burst of a few dozen requests rather than a hard cutoff at 10. It slows abuse down; it isn't an exact quota.

Workers Paid raises all of these far beyond personal use.

Measured on staging (2026-10-14, CPU time per call, one sample each; Free allows 10 ms):

| Memories in the project | `memory_index` (cold cache) | `memory_index` (warm cache) | `memory_search` |
|---|---|---|---|
| 1 | 108 ms | 29 ms | — |
| 50 | 78 ms | 41 ms | — |
| 200 | 109 ms | 91 ms | 110 ms |

Most of the cost is fixed per-call overhead (token decryption, building the MCP server and tool schemas, health checks), not the number of memories.

### How do I know it's working?
At session start, Claude runs a health check and stays silent if everything's fine. Each problem is reported in one line with what to do, e.g. "reconnect the claude-memory connector in claude.ai → Settings → Connectors". You can also ask "is memory working?" at any time. Errors say whether they're temporary (`unavailable`, `reauth_required`, `server_limit`) or need a fix first (for example `write_rejected`, when a branch rule blocks the server's commits, or `repo_public`).

### Why TypeScript for the server, and Python and shell for the rest?
Cloudflare's OAuth and MCP libraries for Workers are TypeScript, so the server is TypeScript. Everything that runs on your machine (hooks, setup script, test runner) is Python and shell, to keep it simple and dependency-free.

## Troubleshooting

### Memory tools fail with `getaddrinfo ENOTFOUND`, but the internet works
**Symptom:** a memory tool call fails with `getaddrinfo ENOTFOUND claude-memory.<sub>.workers.dev`, often mid-session after session start worked. `curl https://github.com` fails too, yet `dig github.com @1.1.1.1` answers. Your network and DNS servers are fine; the Mac's own resolver (mDNSResponder), which Node, curl and Python all use, has stopped answering. You may also see a burst of "Python quit unexpectedly" reports: on a Mac in this state, a process that does a failed lookup and then starts a subprocess crashes in the child.

**Fix:** flush the resolver. In Claude Code, type:

```
! sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder
```

Then ask Claude to retry. Anything saved meanwhile was queued in the outbox and is flushed on the next successful `memory_index`.

**Seen after:** upgrading iTerm (the first session after the upgrade). Toggling iTerm's **Local Network** permission in System Settings → Privacy & Security wasn't enough on its own; the flush was what fixed it.

If the flush doesn't help, check that the Worker URL in `~/.claude-memory-cloud/config.json` is spelled right: a typo gives the same error.
