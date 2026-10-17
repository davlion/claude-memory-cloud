# Plan 2 (local kit) — build ledger

Decision log kept while building Plan 2 (2026-10-14): task status, every ruling (`Ruling:` — what was decided, why, cost if wrong), deferred minor findings, and live-install results. Review diffs and per-task briefs/reports were scratch and are not kept; git history is the code record.


Spec: /Users/dav/src/claude-memory-mcp/docs/superpowers/specs/2026-10-13-cloud-memory-design.md
Target repo: /Users/dav/src/claude-memory-cloud (main at cba02a4; Task 1 creates the branch)
Stop for user at Task 13 (real Mac install) and Task 14 (VMs).

## Pre-flight scan (preflight-scan.md): 12 findings — rulings carried into task dispatches
- Ruling: F4 (T1) DROP the U2 probe that runs real `claude -p` against the real HOME/~/.claude — safety: nothing touches the real ~/.claude before T13 — cost: one fact verified later (T13 Step 5).
- Ruling: F10 (T7/T10) pass `managed=`/MEMKIT_MANAGED_SETTINGS through install and preflight so tests never read the real managed-settings file — test isolation — none.
- Ruling: F11 (T1 helpers) test git commits use `-c commit.gpgsign=false -c user.name=t -c user.email=t@t` — don't depend on real global git config — none.
- Ruling: F1 (T10) test derives auto-memory dir with the same re.sub as auto_memory_dir — flaky test — none.
- Ruling: F2 (T4/T5) flush rule: delete an outbox entry only on created/updated/deleted; keep it (and report) on conflict-for-delete, exists, similar_found, not_found, and non-retryable errors — never drop a save — none.
- Ruling: F3 (T13) snapshot key expectation uses the repo's real origin (or `_none` when absent); T13 runs the check in a repo that has an origin — accurate expectation — none.
- Ruling: F5 (all) every commit gets a `Co-Authored-By:` trailer naming the implementing model — global constraint — none.
- Ruling: F6 (T1/T10) add `from __future__ import annotations` where mandated — constraint consistency — none.
- Ruling: F7 (T15) spec §7 B hook path (~/.claude/hooks/) updated to the kit's real location; include in T15's deviation list and grep — spec accuracy — none.
- Ruling: F8 (T4) Layer A rule adds the §7 F reporting bullet (connector-unavailable line; don't repeat health unless status changes) — spec coverage — none.
- Ruling: F9 (T12) Part 7 rsync adds `--exclude 'scopes.*.json'`; keep the trailing `---` — never copy client names to VMs unintentionally; doc formatting — none.
- Ruling: F12 (T3) local scope-name validation matches the Worker's rules exactly (read src/scopes.ts / scripts/scopes-rules.mjs; reuse the same rules) — "same rules" claim — none.
Task 1: dispatched (sonnet, BASE cba02a4)
Task 1: implementer DONE (branch plan-2-local-kit, 5abacab); facts U1/U3/U5 confirmed, U2→T13, U4→T6
Task 1: complete (commits cba02a4..5abacab, review clean)
- Ruling: carry into Tasks 2–3 — make_git_dir runs git with env=clean_env(...) plus GIT_CONFIG_GLOBAL=/dev/null and GIT_CONFIG_NOSYSTEM=1 — full isolation from the real git config — tiny diff.
- Ruling: batch Tasks 2–3 (paths/remotes, scope map) into one implementer + one review — small independent pure modules with full code — cost: a defect delays both.
Task 1: minor (deferred): FakeWorker answers any path; 1027 status assumed 503
Tasks 2-3: dispatched (sonnet, BASE 5abacab)
Tasks 2-3: implementer DONE_WITH_CONCERNS (non-empty local scopes kept) commits 5abacab..23069ef
Tasks 2-3: review — 1 Important (origin_from_git_config can raise on non-UTF-8 / unreadable commondir); fix round 1 also: inline comments + case-insensitive section, whole-file scopes validation. Resumed implementer.
Tasks 2-3: fix round 1/5 implementer done (a349710, 18 tests both Pythons); re-review dispatched. Note for Task 8: prompt hook must fall back to git_origin when origin_from_git_config returns None.
Tasks 2-3: fix round 1/5 (3 addressed, 0 open; commits 23069ef..a349710)
Task 2: complete (commits 5abacab..a349710, review clean)
Task 3: complete (commits 5abacab..a349710, review clean)
Tasks 2-3: minor (deferred): subsection name matched case-insensitively (git is case-sensitive for subsections); client_scopes_for_owner sorted vs Worker insertion order; repeated --scope overwrites silently
Task 4: dispatched (sonnet, BASE a349710)
Task 4: implementer DONE_WITH_CONCERNS (3483163) — flagged F2 over-broad
- Ruling (correction to F2): memory_save `conflict` = content stored as conflict copy → counts as done (delete outbox entry, tell user); keep entry only for delete-conflict, exists, similar_found, not_found, non-retryable errors — avoids duplicate conflict copies on re-flush — none.
Task 4: implementer DONE (3483163 + c7e9beb corrected F2) 25 tests
Task 4: review — 3 Important: orphan BEGIN → remove deletes user text; connector-unavailable line truncated; client re-index can overwrite project snapshot/Since. Fix round 1 (+ minor: list not_reachable/unsupported_remote).
- Ruling: carry into Task 9 — settings merge adds a narrow allow rule `Bash(date -u +%Y%m%dT%H%M%SZ)` so outbox writes don't prompt; into Task 10 — persist the CLAUDE.md separator in state.json so uninstall leaves no stray blank line — UX/cleanliness — small.
Task 4: minor (deferred): CRLF files get LF-inserted block (round-trips); <memory-snapshot> has no nonce (hook escapes); render_rule Path vs str typing
Task 4: fix round 1/5 implementer done (af395b2, 27 tests); re-review dispatched
Task 4: fix round 1/5 (4 addressed, 0 open; commits c7e9beb..af395b2)
Task 4: complete (commits a349710..af395b2, review clean)
- Note for Task 10: setup install/uninstall must catch MarkerError and print its message (refuse, leave CLAUDE.md untouched).
Task 5: dispatched (sonnet, BASE af395b2)
Task 5: implementer DONE (0f9eafa, 34 tests)
Task 5: complete (commits af395b2..0f9eafa, review clean)
- Ruling: carry into Task 7 — list_entries per-entry try (one unreadable entry must not hide the whole outbox), read cap ~64 KB per entry (oversized → malformed), tests for non-UTF-8/symlink/oversized/unreadable; wherever `outbox-done` is implemented: lstat, refuse symlinks and any path outside the outbox dir — visibility/safety — small.
Task 5: minor (deferred): format_entry allows newline in host/version/scope; quoted value + trailing comment flagged malformed
Task 6: dispatched (sonnet, BASE 0f9eafa)
Task 6: implementer DONE_WITH_CONCERNS (widened stale escaping) 43 tests; note Task 7: map daily_limit to user message
Task 6: review — 2 Important (snapshot escaping lacks NFKC/Cf handling; escaping grows text after cap) + minors (3.9 RecursionError, redirects, key validation, note text). Fix round 1 → resumed implementer.
Task 6: fix round 1/5 implementer done (79f3f79, 48 tests); re-review dispatched
Task 6: fix round 1/5 (5 addressed, 0 open; commits 7fe1e46..79f3f79)
Task 6: complete (commits 0f9eafa..79f3f79, review clean)
- Ruling: carry into Task 7 — fix test_bad_keys_rejected to create the .md files so it actually tests validation (and drop a__b__c from the bad list, regex accepts it); map health outcome daily_limit to "memory server hit its daily request limit; resets 00:00 UTC; saves are queued" — test accuracy/UX — small.
Task 6: minor (deferred): tiny max_chars can overflow with header/footer only
Task 7: dispatched (sonnet, BASE 79f3f79)
Task 7: implementer DONE_WITH_CONCERNS (e9389f2; 71 tests; healthy 0.07s, blackhole ≤1.11s). outbox-done still pending (lstat/refuse symlinks/outside).
Task 7: complete (commits 79f3f79..e9389f2, review clean)
- Ruling: carry into Task 8 (both hooks) — non-dict stdin / non-str cwd treated as missing (no false "hook failed"); fallback emit+flush wrapped so a closed stdout can't traceback; hook-level tests for missing/invalid/non-dict stdin and managed-settings precedence via MEMKIT_MANAGED_SETTINGS — robustness — small.
Task 7: minor (deferred): problem section length uncapped (theoretical); ensure_private_dirs follows dir symlinks; "1 outbox entries" plural; snapshot read_bytes uncapped
Task 8: dispatched (sonnet, BASE e9389f2)
Task 8: implementer DONE (51a024c; 85 tests; prompt hook median 76 ms on 3.9)
Task 8: review — 2 Important (non-GitHub remote echoed raw into hint → injection; redact_remote leaks credential fragment) + minors (scope-required wording, don't-remember false positive). Fix round 1 → resumed implementer.
Task 8: fix round 1/5 implementer done (c8f94ba, 90 tests, 76 ms); re-review dispatched
Task 8: fix round 1/5 (4 addressed, 0 open; commits 51a024c..c8f94ba)
Task 8: complete (commits e9389f2..c8f94ba, review clean)
Task 8: minor (deferred): negation lookbehind bypassable by double space / inserted word (extra reminder only); non-ASCII host chars dropped
Task 9: dispatched (sonnet, BASE c8f94ba)
Task 9: implementer DONE_WITH_CONCERNS (0278554; 104 tests) — concerns: reinstall auto_memory_previous, pre-existing identical allow rule removed, non-bool autoMemoryEnabled lost, mixed hook group removed whole
Task 9: review — real-shape round trip byte-identical on both Pythons; 3 Important: allow rules removed by substring (deletes user rules); mixed hook groups dropped whole; reinstall auto_memory_previous=False. Fix round 1 (+ minors: raw prior value, pre-existing empty containers, type checks, islink) → resumed implementer.
- Note for Task 13: run setup while Claude Code is idle (lost-update window between load and os.replace) or check mtime before replace.
Task 9: fix round 1/5 implementer done (c4b5657; 113 tests); re-review dispatched.
- Note for Task 10/12 (state.json): store install info {auto_memory_previous (ABSENT|bool|{"value":raw}|None), added_rules, created}; first install stores all; re-install keeps stored auto_memory_previous and unions added_rules/created; uninstall_file(path, auto_memory_previous, added_rules=, created=, fallback_rules=[Bash memkit rule]) with stored values.
Task 9: fix round 1/5 (7 addressed, 0 open; commits 0278554..c4b5657)
Task 9: complete (commits c8f94ba..c4b5657, review clean)
Task 10: dispatched (sonnet, BASE c4b5657) with carried items: state.json contract; MarkerError catch; CLAUDE.md separator in state; outbox-done lstat/refuse symlinks/outside; F1 test re.sub; F10 managed; hooks:null/permissions:null → SettingsError
Task 10: implementer DONE_WITH_CONCERNS (6b3c37e; 139 tests; --dry-run writes nothing)
Task 10: review — Approved w/ 1 Important (mid-install OSError → traceback, exit 1, no recovery message); real-settings round trip byte-identical, idempotent, dry-run clean, recovery via --uninstall verified. Fix round 1 (+ -B, export no-overwrite, unknown-prior warning, messages) → resumed implementer.
Task 10: fix round 1/5 implementer done (e68abc0; 147 tests); re-review dispatched
Task 10: fix round 1/5 (5 addressed, 0 open; commits 6b3c37e..e68abc0)
Task 10: complete (commits c4b5657..e68abc0, review clean)
Task 10: minor (deferred): tests only runnable as `python3 test/local/test_setup.py` (not -m unittest); chmod-based tests ineffective as root; compact settings reformatted to indent 2 (backup keeps original); Homebrew python path version-specific
== COMPACTION BOUNDARY: next is Task 11 (full suite on both Pythons + README). Then 12 (docs), STOP for user at 13 (real Mac: back up ~/.claude/settings.json + CLAUDE.md, run setup.sh --dry-run, show diff, user approves, run while Claude Code idle; verify U2 live in T13 Step 5; snapshot key uses repo with origin), 14 (VMs), 15 (spec). Then final review + finishing.
== RESUMED after terminal closed mid-compaction (new controller session); resuming at Task 11 per ledger.
- Ruling: Task 11 expected count "Ran 79 tests" is stale — accept the current full count (~147) with OK on both interpreters — plan predates later fix rounds — none.
- Ruling: Task 11 makes test_setup.py run under `python3 -m unittest discover -s test/local` (Task 10 deferred minor) since discover is the documented suite command — otherwise README/global "All" command silently skips tests — small.
Task 11: dispatched (sonnet, BASE e68abc0)
Task 11: implementer DONE (2c2839e; 147 tests OK x3; discover already runs test_setup — no fix needed)
Task 11: complete (commits e68abc0..2c2839e, review clean) — ⚠️ items resolved by controller: report shows 147 OK x3; ~/.claude-memory-cloud absent.
Task 11: minor (deferred): README anchor #part-7--set-up-each-machine dangles until Task 12 drops "(not yet available)" (Task 12 Step 2 does this); trailer says "Claude Sonnet" without version
- Ruling: Task 12 docs must match the kit as actually built (setup.sh flags/exit codes/messages, --export-local no-overwrite, state.json, -B) — implementer checks `./setup.sh --help` and kit code, adjusts brief prose only where the build deviates, and lists each deviation in the report — later fix rounds changed behaviour the plan prose predates — small.
Task 12: dispatched (sonnet, BASE 2c2839e)
Task 12: implementer DONE_WITH_CONCERNS (efbe955; docs only; Homebrew rerun advice untested)
Task 12: complete (commits 2c2839e..efbe955, review clean)
Task 12: minor (deferred): rare uninstall-empty-settings backup may be named .memkit-backup-<time> not .bak-<time>; exit code 2 "nothing is changed" untrue for mid-write failure; export target/format vs Claude Code unverified; Homebrew rerun advice untested; ~/.claude write-protection claim external
== STOP for user at Task 13 (real Mac install).
Task 13: Steps 1-4 done with user approval (backup settings.json.pre-plan2; no prior CLAUDE.md; dry-run diff approved; install exit 0, preflight passed, settings diff = approved additions only). Awaiting Step 5 live checks by user.
Task 13 Step 5 (session e477b890): S1 memory_index unprompted ✓ (no project — repo has no origin, snapshot key _none ✓ per F3); "remember this" → saved to general ✓ (test-memory-plan-2, to delete); compact → hook context "Context was compacted. Call memory_index again" ✓ → memory_index re-called on next prompt + snapshot rewritten ✓.
Task 13 finding: U2 NOT verified — session ran in auto mode, and Claude wrote the snapshot via Bash `cat >` heredoc (not Edit/Write), so the Edit(~/.claude-memory-cloud/cache/**) allow rule was never exercised; outside auto mode that Bash write would likely prompt.
- Ruling: carry into final fix wave — routing rule (kit/templates/routing-rule.md) tells Claude to write snapshot and outbox files with the Write tool, not shell redirection, so the allow rules apply in every permission mode; re-verify U2 in default mode after reinstall — otherwise every session start may prompt outside auto mode — small.
Task 13: checks 1 (/hooks) and 2 (/context no auto-memory) ✓ per user; user saw no permission dialog for snapshot write (session was auto mode). Task 13 fix: dispatched (sonnet, BASE efbe955) — routing rule: Write tool for snapshot/outbox
Task 13: test-memory-plan-2 deleted (user confirmed).
Task 13 fix: implementer DONE (6bdc728; 148 tests OK both Pythons)
Task 13 fix: review clean (commits efbe955..6bdc728)
Task 13 fix: minor (deferred): Snapshot bullet has two consecutive "with …" clauses — reword "using the Write tool …, writing the complete result"; test matches exact phrase (brittle by design)
Task 13: awaiting user OK to re-run setup (reinstall picks up 6bdc728 rule) + U2 re-check in non-auto session.
Task 13: reinstall with 6bdc728 done (user OK): exit 0, settings.json byte-identical, CLAUDE.md rule updated (1 block, Write-tool wording x2). Awaiting U2 re-check in non-auto session.
Task 13 U2 re-check (session 9a451df6, default mode): snapshot Write to cache/_none.md completed in 0.6 s with no prompt ✓ (U2 verified). Two other prompts: Bash `git -C <repo> remote get-url origin` and mcp__claude-memory-staging__memory_index.
- User decision: allow only read-only memory tools (memory_index, memory_read, memory_search); memory_save/memory_delete keep prompting.
- Ruling: setup finds MCP server name(s) by matching worker_url against ~/.claude.json mcpServers (user + project scoped, read-only), plus repeatable --mcp-server NAME override; adds Read-only tool allow rules per name, tracked in state added_rules so uninstall removes them — server name varies per machine (local name here is claude-memory-staging) — if detection misses, user passes --mcp-server.
- Ruling: SessionStart hook always states the session's memory project (origin as owner/repo, or "none") and routing rule says use it instead of running git; also allow-list `Bash(git remote get-url origin)` as fallback — removes the git prompt every session — small.
Task 13 fix 2: dispatched (sonnet, BASE 6bdc728)
- Controller error: stray repo-root settings.json was created by controller's own stray `cp -p ~/.claude/settings.json "$EMPTY"` during reinstall (empty target = cwd); identical copy, removed, never committed.
Task 13 fix 2: implementer DONE (9efdec4, fb42cd4; 157 tests OK both Pythons; SessionStart now always emits project line)
Task 13 fix 2: review clean (commits 6bdc728..fb42cd4; opus reviewer, approved, 0 Critical/Important)
Task 13 fix 2: minor (deferred): "none" project line also emitted on git timeout (add "unknown" form → git fallback); UNINSTALL.md:64 "pre-existing rule left alone" true only with state.json; commit 9efdec4 alone fails test_setup.py:762 (bisect — move/squash before merge); stale mcp_servers names persist in config.json until uninstall; routing rule Saving bullet says "origin remote" vs session-start owner/repo
Task 13: awaiting user OK to re-run setup (picks up 9efdec4/fb42cd4) then zero-prompt check in default mode.
Task 13: reinstall with fb42cd4 done (user OK): exit=0 — 4 new allow rules (3 read-only mcp, git origin).
Task 13: zero-prompt check ✓ (session 94c8bb63, default mode): hook "Memory project: none", memory_index result in 1.9 s, Write snapshot 0.6 s — no prompts (user confirmed).
Task 13: complete (install on real Mac verified; repo fixes 6bdc728, 9efdec4, fb42cd4 reviewed clean)
== STOP for user at Task 14 (VMs).
Task 14 Step 1: earsvm = Ubuntu 24.04 (Linux, not macOS as planned): python3 3.12 /usr/bin/python3, git 2.43, claude 2.1.170 at ~/.local/bin, settings.json present, no CLAUDE.md, no MCP servers. lume VM via ssh alias `lumevm` (user lume; plan's 192.168.64.7 as dav refused): macOS 26.4.1, Xcode dev dir, /usr/bin/python3 3.9.6, git 2.50.1, claude at ~/.local/bin, settings.json + CLAUDE.md (1926 B, no kit block), no MCP servers, no ~/src.
- User decision: memory server reaches VMs as a claude.ai connector (tool prefix mcp__claude_ai_<Name>__ — not in ~/.claude.json, so setup needs --mcp-server claude_ai_<Name>).
- Ruling: run the kit test suite on earsvm before installing (first Linux run) — untested platform — small.
Task 14 lume: claude.ai connector tool prefix confirmed mcp__claude_ai_claude-memory-staging__ (from transcript); repo rsynced (no .dev.vars/scopes files); 157 tests OK on /usr/bin/python3 3.9.6; backups *.pre-plan2 made; dry run exit 0 (--mcp-server claude_ai_claude-memory-staging). Awaiting user approval to install.
earsvm: system clock was 2026-06-10 (NTP inactive, RTC correct) + 64 GB /var/log/parallels.log; user rebooting/fixing. Claude Code 2.1.170 needs update.
earsvm recovery (user ran writes; controller's remote writes blocked by auto-mode classifier): truncated 64 GB /var/log/parallels.log (prlshprint printer-sharing loop; user disabled printer sharing); ~/.claude.json corrupted by disk-full → restored from backup.1781114519130 (valid, oauth), broken copy kept as ~/.claude.json.broken; Claude Code 2.1.170 → 2.1.300. NTP still inactive (suggested set-ntp true).
Task 14 earsvm: repo rsynced (no .dev.vars/scopes files); 157 tests OK on Ubuntu python3 3.12 (first Linux run). Awaiting connector tool name.
Task 14 lume: installed (user OK) exit 0, preflight passed; live check by user: memory_index + Write snapshot, no prompts ✓ (lume has no broad allow rules — real U2 test).
Task 14 earsvm: connector prefix mcp__claude_ai_claude-memory-staging__ confirmed; dry run approved; installed exit 0, preflight passed (Ubuntu, python 3.12).
Task 14: minor (deferred): on Linux (umask 002) ~/.claude-memory-cloud/kit is 0775 (Mac 0755); harmless under 0700 kit home but kit copy should set explicit modes.
Task 14: plan defects noted for Task 15/spec: earsvm is Linux not macOS; lume host is ssh alias lumevm (user lume) not dav@192.168.64.7; VMs get the memory server as a claude.ai connector (prefix claude_ai_<name>) — needs --mcp-server.
Task 14 earsvm: live check by user: memory_index + Write snapshot, no prompts ✓.
Task 14: complete (both VMs installed and verified; Step 5 cloud env var CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 handed to user — Level 4/Plan 3 verifies)
Task 15: dispatched (sonnet, BASE 07a46ed) with Task 13/14 deviations 9-14 + F7 hook path
Task 15: implementer DONE (365224c)
Task 15: complete (commits 07a46ed..365224c, review clean)
Task 15: minor (deferred): spec rule quote (line ~345) still says project = `git remote get-url origin` vs §7 A note on hook project line; deviation 5 vs §7 B wording of Python; doubled blank line before Plan 2 notes; hard-coded "157 tests" count
== All tasks complete. Final whole-branch review next.
Final review (opus): Ready after one fix — Important: insteadOf origins → hook says project none (session.py:98, prompt.py:53-66 fall back to git_origin only when config value missing). No deferred minor marked MUST-FIX. Full: final-review.md
- Ruling: final fix wave includes the optional "unknown → run git remote get-url origin" project line on git timeout — closes Task 13 fix 2 deferred minor in the same lines — small.
- Ruling: final fix wave also adds Linux managed-settings path (/etc/claude-code/managed-settings.json) to preflight — earsvm is Linux and now a supported target — small.
- Ruling: no history rewrite to squash 9efdec4; offer squash-merge at finishing instead — only bisectability affected, HEAD green — none.
Final fix: dispatched (sonnet, BASE fb42cd4)
Final fix: implementer DONE (d96df69; 162 tests OK both Pythons; non-GitHub origins pay one capped git call per memory-intent prompt)
Final fix re-review: 3/3 ADDRESSED, no new breakage (commits fb42cd4..d96df69)
Final: minor (deferred): prompt hook ignores git_failed (says "No git origin remote" not unknown); non-GitHub/no-origin repos spawn git in prompt hook (may exceed 100 ms, untested)
== Final review clean. Next: redeploy d96df69 to Mac + VMs (user OK), then finishing.
Finishing: suites green at d96df69 — kit 162 OK, Worker vitest 397 passed/4 skipped, typecheck clean. Normal repo, no remote, base main (cba02a4). Awaiting user's integration choice + redeploy OK.
Merged to main as 419fdd3 (--no-ff; tests green on main); branch deleted. Redeployed 419fdd3 to lumevm + earsvm: exit 0, preflight passed, settings.json unchanged, CLAUDE.md rule updated. Mac not yet redeployed. Remote: awaiting user choice (no davlion/claude-memory-cloud on GitHub yet).
Repo pushed: github.com/davlion/claude-memory-cloud (PRIVATE), origin set; VM copies re-synced with origin.
== RESUME POINT (2026-10-14 20:42:05 PDT) — user may reboot. State:
- Plan 2 DONE: merged to main 419fdd3, pushed to github.com/davlion/claude-memory-cloud (PRIVATE, origin set). Repo clean on main.
- Installed + verified zero-prompt: Mac (kit at fb42cd4 — NOT yet redeployed with final fix d96df69; ask user), lumevm (419fdd3), earsvm (419fdd3). VM copies have origin.
- OPEN 1: ask user whether to re-run setup on the Mac: ./setup.sh --worker-url https://claude-memory-staging.<subdomain>.workers.dev --scopes-file scopes.staging.json --login davlion
- OPEN 2: user runs remote-repo test (fresh claude in ~/src/claude-memory-cloud, default mode, "hi"): expect hook line "Memory project for this session: davlion/claude-memory-cloud", memory_index with project, snapshot cache/davlion__claude-memory-cloud.md, then "remember this for this project: ..." → "saved to project" (or reason). Check that machine's transcript; delete test memory after.
- OPEN 3: user adds CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 to claude.ai/code cloud environment.
- Then: delete this workspace dir (rm -rf this folder) once the user no longer needs it; final-review.md has deferred minors triage. Rulings list already given to user.
Mac redeployed with 419fdd3 (user OK) — OPEN 1 closed.
OPEN 2 done (lume, session 6b7aed89): hook "Memory project: davlion/claude-memory-cloud" ✓; memory_index(project=davlion/claude-memory-cloud) ✓; snapshot cache/davlion__claude-memory-cloud.md ✓; memory_save scope=project → "saved to project" ✓, stored in davlion/claude-memory-test under scope project:davlion/claude-memory-cloud as local-kit-location. Note: new snapshot file mode 0644 (Write tool) inside 0700 cache dir — per spec fixed silently by hook; Claude ran `hostname -s` for source (no prompt observed).
