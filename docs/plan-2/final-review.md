# Final whole-branch review: Plan 2 (local kit)

Branch `plan-2-local-kit`, cba02a4..fb42cd4 (22 commits), repo /Users/dav/src/claude-memory-cloud.
Reviewer: Opus 5.5, read-only. I read every non-test source file at HEAD in full (install.py, settings_edit.py,
session.py, preflight.py, health.py, outbox.py, snapshot.py, remote.py, prompt.py, claudemd.py, scopemap.py,
paths.py, both hooks, memkit.py, memkit_setup.py, setup.sh, routing-rule.md), the docs diff (README, FAQ,
QUICKSTART, THREAT-MODEL, UNINSTALL), spec §7 A–H, §10 and the Plan 2 deviation notes, and the ledger. I skimmed
the test list in test_setup.py and did not re-run the suite. I ran one focused probe in a temporary HOME
(insteadOf origin, below).

## Verdict

**Ready after one small fix** (Important #1). Nothing is Critical. Every deferred minor can be left as is.

## Strengths

- **Install and uninstall are data-safe by construction.** `install()` plans everything first with pure
  functions, so a refused CLAUDE.md or settings.json changes nothing. It writes state.json before touching the
  user's files, so an interrupted install can still be uninstalled. Uninstall removes only the exact rule
  strings recorded in `added_rules` and the containers recorded in `created`, and restores
  `autoMemoryEnabled` exactly (bool, absent, or raw non-bool). The CLAUDE.md separator is stored, so the
  round trip is byte-exact. Every changed file gets a backup. Symlinked settings.json and CLAUDE.md are
  followed and kept as symlinks.
- **The outbox never drops anything silently.** `list_entries` counts malformed entries, symlinks and
  oversized entries, so they block uninstall too. `--force` keeps the files, and unknown files keep the
  directory. `outbox-done` accepts only basenames matching the entry regex, checks with lstat, refuses
  symlinks and non-regular files, and checks the realpath. The flush rules in the routing rule follow the
  F2 ruling and its correction.
- **Memory content stays framed as data.** The snapshot is NFKC/Cf-aware and escapes `<memory…` (which also
  catches `</memory-snapshot>`) and `[server:` before truncating. It is framed as stale and read-only. The
  prompt hook prints only a sanitized host for non-GitHub remotes and redacts credentials. Hooks run as
  `-I -S` from a kit dir that Claude cannot edit without a prompt: the allow rules cover only outbox, cache
  and export. Of the memory tools, only the read-only ones are allow-listed.
- **The hooks are robust.** Non-dict stdin and closed stdout are handled. `os._exit` stops a /health thread
  that is stuck in DNS from holding the hook open. The health check doesn't follow redirects and reads at
  most 4 KB.
- **The tests are thorough.** They cover the golden round trip, a blank file, non-bool previous values,
  missing state, write failures midway, symlinks and managed settings. Every test runs in a temporary HOME
  with an isolated git config.

## Issues

### Critical
None.

### Important

1. **The hook's authoritative "Memory project" line is wrong for repos whose origin uses `url.<base>.insteadOf`.**
   This only shows up across tasks: T2 deliberately left insteadOf unhandled, and T13 fix 2 (fb42cd4) made the
   hook's line authoritative.
   - Files: `kit/memory_kit/session.py:98`, `kit/memory_kit/prompt.py:53-66`, and
     `kit/templates/routing-rule.md:5` ("Run `git remote get-url origin` yourself only if the hook gave no
     such line at all").
   - What happens: `origin_from_git_config` returns the raw config value. The caller falls back to
     `git_origin` only when that value is `None`, not when it fails to normalize. I reproduced this in a
     temporary HOME: origin `gh:Acme/Billing` with `url.git@github.com:.insteadOf gh:`.
     `git remote get-url origin` prints `git@github.com:Acme/Billing`, but `session_report(...).project` is
     `None`. The hook therefore says "none (no GitHub origin; omit project)".
   - Why it matters: before fb42cd4, Claude ran git itself and got the expanded URL. Now, in such repos:
     - Claude is told to omit `project`, so project and client memories silently don't load.
     - The snapshot is written to `_none`.
     - Project saves are refused ("with no git remote, project-specific facts can't be saved").
     - The prompt hook says "a non-GitHub remote on host gh (not on GitHub: no project scope here)".

     The remote.py docstring says callers must fall back on insteadOf, and these callers don't.
   - Fix (about 2 lines per caller):
     - In `session_report`, call `git_origin(cwd)` when the config value is `None` **or**
       `normalize_remote(value)` is `None`, and keep the config value if git fails. The 1.5 s budget allows
       it.
     - Do the same in `prompt_context`. It only costs the git spawn for remotes that don't normalize, which
       are rare, so the 100 ms budget for the common path is unaffected.
   - Add one test with an insteadOf origin.
   - Optional, same edit: when `git_origin` times out (so the origin can't be determined), emit
     "Memory project for this session: unknown; run `git remote get-url origin`" instead of "none". This
     also closes the T13-fix-2 deferred minor about timeouts.

### Minor (OK to leave; listed for the record)

1. **Linux managed settings are not checked.** `kit/memory_kit/preflight.py:10`: `MANAGED_SETTINGS` is the
   macOS path. On Linux (earsvm) the managed file is `/etc/claude-code/managed-settings.json`, so the
   auto-memory preflight ignores a managed override there.
   - Fix if wanted: pick the path by `sys.platform`.
   - Low impact: on Linux the preflight result is wrong only if an admin sets `autoMemoryEnabled` in
     managed settings.
2. **Malformed outbox filenames reach Claude's context unsanitized.** `kit/memory_kit/session.py:102`
   includes them in the hook's context without filtering control characters. The filenames are created
   only by the local user or Claude in a 0700 directory, so the risk is negligible.
3. **Uninstall removes export staging without asking.** `kit/memory_kit/install.py:375` deletes
   `export/`, which may hold staged memories when `export-finish` was never run. The dry run lists it, and
   the memories are still in GitHub.

## Cross-task observations (beyond the per-task reviews)

- **Interfaces line up.**
  - `commands()` → hook commands, the memkit allow rule and the routing-rule `{{MEMKIT}}` all use the same
    quoted string.
  - `HOOK_MARKER` detection works on escaped-slash JSON.
  - `cache_key(remote)` in the hook matches the routing rule's key recipe.
  - `list_entries` is shared by scan, uninstall and the count.
  - `load_config`'s `mcp_servers` round-trips through install and `_fallback_rules`.
  - `managed_path()` and `MEMKIT_MANAGED_SETTINGS` are honored by install, preflight and the hook.
- **Reinstall with a different interpreter** leaves the old `Bash(<oldpy> … outbox-done *)` rule in
  settings. It is harmless: it is tracked in `added_rules` and removed on uninstall.
- **State is planned from the pre-write settings read**, while `install_file` re-reads the file. The two
  agree unless settings.json changes between those reads, a window of milliseconds. Acceptable.
- **The spec is consistent with the build** for §7 A (deviations 9–11), §7 B path, E, F, G, H and §10 6a.
  The spec's Layer A quote (around line 345) still says to run git. The note right under it explains the
  hook line, and that is a Task 15 deferred minor.

## Deferred minors: triage

| Origin | Item | Ruling |
|---|---|---|
| T1 | FakeWorker answers any path | OK: only the test fake does this, and /health is the only path the kit calls |
| T1 | 1027 assumed 503 | OK: the code treats 429 **or** "1027" in the body as `daily_limit`, which covers both |
| T2-3 | Subsection matched case-insensitively | OK: it only misreads a repo that has both `origin` and `Origin` remotes |
| T2-3 | `client_scopes_for_owner` sorted, while the Worker uses insertion order | OK: this only affects the order of names in the hint text |
| T2-3 | A repeated `--scope` overwrites silently | OK: the last value wins, and `--dry-run` prints the map |
| T4 | CRLF files get an LF block | OK: it round-trips byte-exact |
| T4 | `<memory-snapshot>` has no nonce | OK: the hook escapes every `<memory`/`</memory` form, so the tag can't be closed early |
| T4 | `render_rule` typed Path vs str | OK: cosmetic |
| T5 | `format_entry` allows a newline in host/version/scope | OK: `format_entry` is used only by tests. Claude writes entries itself, and the parser rejects malformed ones |
| T5 | Quoted value plus trailing comment flagged malformed | OK: fails safe (the entry is kept and reported) |
| T6 | A tiny `max_chars` can overflow | OK: unreachable in practice (the budget is at least 8 KB unless the problems text is huge) |
| T7 | Problem section length uncapped | OK: theoretical. The malformed list is already capped at 5 names |
| T7 | `ensure_private_dirs` follows directory symlinks | OK: the path is under the user's own 0700 kit home |
| T7 | "1 outbox entries" plural | OK: cosmetic |
| T7 | Snapshot `read_bytes` uncapped | OK: only the user and Claude write the cache. A cap at `SNAPSHOT_CAP_BYTES*4` would be a one-liner if wanted |
| T8 | Negation lookbehind bypassable | OK: the only effect is an extra reminder |
| T8 | Non-ASCII host characters dropped | OK: the host is shown only as an informational hint |
| T10 | Tests runnable only as a script | Resolved in T11 (discover runs test_setup.py) |
| T10 | chmod tests ineffective as root | OK: nobody runs the tests as root |
| T10 | Compact settings reformatted to indent 2 | OK: Claude Code writes settings.json indented itself, and a backup is kept |
| T10 | Homebrew python path is version-specific | OK: /usr/bin/python3 is preferred on Mac, and the docs say to rerun after `brew upgrade` |
| T11 | README anchor dangles | Resolved: the heading is now "Part 7 — Set up each machine", and its slug matches |
| T11 | Trailer says "Claude Sonnet" without a version | OK: commit history only |
| T12 | Backup on uninstall when settings.json ends up empty may be named `.memkit-backup-` | OK: a rare naming nuance in the docs |
| T12 | Exit code 2 "nothing is changed" is untrue for a failure partway through writing | OK: the runtime message there says "stopped partway… backed up". An optional doc tweak in QUICKSTART exit codes |
| T12 | Export target/format vs Claude Code unverified | OK: optional feature, belongs to the Level 4 / U1 check |
| T12 | Homebrew rerun advice untested | OK |
| T12 | `~/.claude` write-protection claim is external | OK: consistent with what T13 saw live |
| T13 fix | Snapshot bullet has two "with" clauses | OK: wording only |
| T13 fix 2 | "none" project line also emitted on git timeout | OK on its own. Cheap to fold into Important #1 (same lines) |
| T13 fix 2 | UNINSTALL.md "pre-existing rule left alone" true only with state.json | OK: the no-state path is documented a few lines below it |
| T13 fix 2 | Commit 9efdec4 alone fails test_setup.py:762 | OK: one intermediate red commit on a local branch, and HEAD is green. Squash it into fb42cd4 only if bisectability matters to you (controller's call) |
| T13 fix 2 | Stale `mcp_servers` names persist in config.json | OK: they only add extra read-only allow rules, and uninstall removes them |
| T13 fix 2 | Saving bullet says "origin remote" while the hook says owner/repo | OK: the server normalizes either form |
| T14 | Kit dir 0775 on Linux | OK: the 0700 kit home blocks other users. Setting explicit modes in `_copy_kit` is optional hardening |
| T15 | Spec quote at line ~345 still says git; deviation 5 wording; doubled blank line; hard-coded "157 tests" | OK: all wording in the spec repo |

**MUST-FIX deferred minors: none.**

## Declined to judge

- `--export-local` writes cloud memory text (untrusted data) into Claude Code auto-memory files, which Claude
  Code later loads as context. §10 6a mandates this, the user runs it explicitly, and client scopes are
  excluded.
- Windows: not a target platform (spec: Mac and VMs).
- Claude Code writing settings.json at the same moment setup runs: the race window is milliseconds and a
  backup exists.
- Whether Claude Code's Bash rule matching splits compound commands, which is what keeps
  `Bash(… outbox-done *)` safe. This is Claude Code's behavior, not the kit's, and it is relied on
  everywhere.

## Recommendations

- Fix Important #1, including the optional "unknown" line, add the insteadOf test, and rerun the suite on
  both interpreters.
- Before merging, decide whether to squash 9efdec4 into fb42cd4 (bisect).
