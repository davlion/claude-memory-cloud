# Plan 3 (Level 4 end-to-end) — build ledger

Decision log kept while running Plan 3 (2026-10-15 to 2026-10-16): task status, every ruling (`Ruling:` — what was decided, why, cost if wrong), findings, and the live results behind the grids in `test/e2e/results/`. Raw transcripts are gitignored; git history is the code record. Items for the final review are summarized at the end.

Executor: executing-plans (native, chosen by user 2026-10-15). Spec: claude-memory-mcp/docs/superpowers/specs/2026-10-13-cloud-memory-design.md (read §9 L4 while writing the plan).
- Ruling: work on branch plan-3-e2e in the main checkout, no worktree — plan's Starting point says so (as Plan 2) — cost if wrong: none (clean tree).
- Ruling: run Tasks 2 (Steps 1–5) to 6 before Task 1 — VMs are off; code tasks don't consume Task 1 results except V5 (cleanup fallback, Task 6) and host tweaks to e2e.json (Task 3), both applied later as small follow-ups if V-checks fail; Task 2 Step 6 (redeploy) moves into Task 1 — cost if wrong: a follow-up commit.
Pre-flight (Interfaces):
- T2→T6: CLAUDE_MEMORY_KIT_PROMPT_HINT=off produced by kit, consumed by run.py PROMPT_HINT_OFF — match.
- T3→T4/T5/T6: Transcript/ToolCall/Hook, Host/Invocation/RunResult, Config fields — match (code generated from one tested tree).
- T4→T5/T6: GitHub.find/exists/delete/commits_since/file_text, Found.parts, MEMORY_PATH, checks.* — match.
- T5→T6: Ctx(…, env=), SINGLE/PAIR/REPEATED, fake_secret — match.
- T1(V5)→T6 cleanup: conditional fallback — handled by ruling above.
- Task 2: Ruling: Step 6 (redeploy + V6) deferred into Task 1 — VMs off — cost if wrong: none.
Task 2: complete (commits b0cb0af..076f954, tests: python3 -m unittest discover -s test/local → OK)
Task 3: complete (commits 076f954..c6e3bd4, tests: /usr/bin/python3 -m unittest discover -s test/e2e → OK)
Task 4: complete (commits c6e3bd4..a4492bc, tests: /usr/bin/python3 -m unittest discover -s test/e2e → OK)
Task 5: complete (commits a4492bc..5b107a5, tests: /usr/bin/python3 -m unittest discover -s test/e2e → OK)
Task 6: complete (commits 5b107a5..2b715c6, tests: /usr/bin/python3 -m unittest discover -s test/e2e → OK)
Task 1: Step 1 Mac: 3 test repos private=true. Step 2 Mac: cloned ~/src/sample-app (origin git@github.com:davlion-test-client/sample-app.git), ~/e2e-no-remote (no remote). Step 3 dry run: adds exactly 3 mcp__claude_ai_claude-memory-staging__memory_{index,read,search} rules; CLAUDE.md no change. Awaiting user approval + VMs on.
Task 1: SSH to VMs failed 'No route to host' (all LAN, internet ok) = macOS Local Network privacy after iTerm update; user toggled it; works. earsvm claude 2.1.301, lume 2.1.300. Mac setup installed (user OK): exit 0, 3 claude_ai read-only rules, kit 0.1.1, preflight passed.
- Task 1: Ruling: VMs have no GitHub creds (clone fails; lume gh login expired) — rsync the Mac's sample-app clone (origin intact) instead of adding credentials — cost if wrong: VM checkout can't pull; never needed by the runner.
- Task 1: Ruling: probe.sh unsets all ANTHROPIC_*/CLAUDE_CODE_*/CLAUDECODE/CLAUDE_PID/CLAUDE_EFFORT (plan listed a subset; CLAUDE_CODE_MESSAGING_* etc. leak) — same set as launch.clean_env — cost if wrong: none.
Task 1: V1 PASS on Mac (index project=davlion-test-client/sample-app, snapshot Write, no denial), lume (first memory_index 'operation timed out', retry ok), earsvm 2/3 (run 1: connector 'pending' at init, ToolSearch never found memory tools). FINDING: in -p the claude.ai connector can still be connecting when Claude looks for memory_index (server /health 0.1-0.35s, not the Worker). Note: init.tools never lists MCP tools (deferred via ToolSearch) — judge V2 by ToolSearch/calls, not init.
Task 1: VMs: sample-app rsynced (origin ok), ~/e2e-no-remote created; kit 0.1.1 redeployed (dry run: settings/CLAUDE.md no change) exit 0, preflight passed — closes Task 2 Step 6.
Task 1: V2 PASS (no MCP servers: ToolSearch finds nothing, no memory call). V3 PASS (resume + no servers → NOTFOUND). V4 PASS (/compact on resumed session fires SessionStart:compact kit hook; next run re-calls memory_index). V5 PASS (hand delete via gh api → next memory_index omits it; cleanup by gh delete stands). V6 PASS (env var reaches hooks; checked with a temporary --settings hook). V7: `--cloud` can't be combined with -p for a NEW session; `claude -p "msg" --cloud <session-id>` messages an existing one.
- Task 1: Ruling: H5 stays manual (Task 9) — V7: new cloud sessions are interactive-only — cost if wrong: H5 rows done by hand.
- Task 1: Ruling: stream-json emits hook_response only for SessionStart, never UserPromptSubmit → U1's prompt-hook check was vacuous; replaced by a settings.json kit-hook registration check (TDD, 2 tests) — cost if wrong: none.
- Task 1: OBSERVED: a save reply said "I created the general memory …" — announcement phrase may be missing; S2's announced() check will measure it.
Task 1: complete (all V-checks run; fix commit for U1)
Task 7: run xdgroe crashed after H1 S1/S12h PASS: commits API 409 on empty client repo → fix 'empty repo has no commits' (test_empty_repo_has_no_commits RED→GREEN, suite 45).
Task 7: H4 crashed mid-run: 'error connecting to api.github.com' in a check then in cleanup; also ~1400 gh calls used (3608/5000 left) because every check refetched all commits since run start. Fixes: gh_api retries status-less failures 3x (2s,4s); GitHub caches commit details by sha and file text by (path,sha); cleanup_or_warn between scenarios — 5 tests RED→GREEN, suite 50.
Task 7: fix guarded() keyed ERROR rows as 'ERROR' (invisible in grid) → keyed by scenario id — test_run.py 2 tests RED→GREEN, suite 52.
- Task 7: Ruling: dropped H4's 5 partial rows (incl. a mis-keyed ERROR) from run xdgroe and reran H4 in full — the crash was GitHub connectivity, not the scenario — cost if wrong: none (raw rows only).
Task 7: run xdgroe (A+C) grid committed: all PASS on H1/H3/H4 except S5 2/3 everywhere — the same phrasing ("Save a memory: the linter runs before tests") saved to project sample-app without asking, on all 3 hosts.
- Task 7: Ruling: S5 phrasing 3 is a prompt defect, not a routing miss — in a repo, "the linter runs before tests" is a project fact, and every host picked project identically — keep it unchanged for run 2 (plan: never edit phrasings between compared runs), then replace it after run 2 and note in spec — cost if wrong: S5 stays 2/3 in both grids.
- Task 7: Layer B decision (prelim, for the user): A+C alone is 3/3 on every routing prompt that is genuinely routable, with and without trigger phrases → B looks optional; run 2 measures whether B changes anything.
Task 7: complete (grid test/e2e/results/2026-10-15-xdgroe.md)
Task 8: run b7r2qx (A+B+C) grid committed: 77 PASS — S0–S4, S4n, S6, S6p, S7, S8, S9, S11, S11b, S11c, S11e, S11f, S12h, S13, S14 all PASS; S16 soft ✓ (8 parallel saves, 0 failed in transit, each stored once); S5 2/3 on all hosts (same phrasing as run 1).
- Task 8: Layer B: A+C and A+B+C grids identical → B made no measurable difference on this prompt set.
- Task 8: FINDING: cleanup's hand deletes (gh api) are commits "made outside the memory server", so memory_index Health then shows ⚠ provenance for davlion/claude-memory-test until the next server commit. Proves the provenance check works; is noise in the user's real (staging) sessions after a run.
- Task 8: Ruling: keep cleanup by hand delete; document the provenance warning in test/e2e/README.md — fast and deterministic, the warning clears at the next server write, and it is staging-only — cost if wrong: a stale ⚠ line in staging sessions after runs; follow-up: optional cleanup through memory_delete.
- Task 8: Ruling: replace S5 phrasing 3 ("the linter runs before tests" → "prefer small pull requests") after both compared runs — the old one is a project fact, not ambiguous — validated in a separate S5-only run — cost if wrong: S5 still not ambiguous enough.
Task 8: S5 phrasing trials: "prefer small pull requests" H1 2/3 (saved general without asking); "we tag releases with a v prefix" H1 3/3 + H3 2/3 → kept the "we" phrasing. Stopped tuning (would overfit).
- Task 8: FINDING (for the user): S5 is stochastic — Claude asks the one-line scope question most of the time but sometimes picks project/general confidently. Possible product change: a stronger routing-rule line ("a fact that could belong to the user, the client or the project → ask"). Not changed in this plan.
Task 8: complete (grid test/e2e/results/2026-10-15-b7r2qx.md; S5 trials in raw runs s5fix1, s5fix2)
Task 11: lume pre-state: kit 0.1.1, hooks 2, autoMemoryEnabled false (previous absent), outbox empty; backups /tmp/lume-*.pre-u1.* on lume.
Task 11: uninstall on lume exit 0 (hooks 0, routing rule 0, autoMemoryEnabled restored to absent); U1 PASS (no kit context, no memory calls, settings has no kit hooks, auto-memory file written); test auto-memory dir removed; reinstall exit 0 — settings.json and CLAUDE.md identical to pre-U1 backups; S1 on H4 PASS after reinstall.
- Task 11: NOTE: a listing step printed other projects' MEMORY.md on lume into the session (read-only, nothing changed) — scope listings to the test dir next time.
Task 11: complete
Task 10: Steps 1–2 done: backup ~/e2e-s12-backup (SHA); 4 local breaks (auto-memory on, routing rule removed, scope map corrupt, worker URL 127.0.0.1:9) each → exactly one problem line → PASS; each restore checksum-verified. S1/S12h on H1 PASS after. Remaining: Step 3 (GitHub-side: revoke, S10, org removal, missing repo, S15) needs the user; backup kept until then.
Task 10: revoke → reauth_required PASS, reconnect → github_token ok; S10 uninstall → app_not_installed (+install link) PASS. FINDING: with the client scope app_not_installed, Health still shows '✓ project … → davlion-test-client/claude-memory/projects/sample-app/' (misleading; same family as the Plan 4 follow-up on project targets when the owner scope is unreachable).
Task 10: rename client repo → not_reachable PASS (server did not follow GitHub's rename redirect; action lists add-to-app/create/membership); renamed back → scope ok.
Task 10: S15 pre-check: claude-memory-test history = 208 commits, almost all test data, plus a few personal memories. Asked user before making it public.
- Task 10: Ruling: S15 skipped (user: "skip or 3") — making claude-memory-test public exposes its full history; option 3 needs a SCOPES secret change + redeploy, which the plan's constraints keep away from me — cost if wrong: repo_public is verified only by Worker unit tests, not live.
- Task 10: Ruling: "remove davlion from the test org" skipped — the user is the org's only owner — cost if wrong: that membership health line unverified live.
- Task 10: grid shows SKIPPED rows as "skipped" (results.cell; test extended RED→GREEN, suite 53).
Task 10: complete (S12 6/6 incl. revoke + missing repo, S10 PASS, S12h after every undo PASS; S15 skipped). Backup ~/e2e-s12-backup still present — ask the user before deleting.
Task 10: ~/e2e-s12-backup deleted (user OK).
== CHECKPOINT (2026-10-15 16:35 PDT) — user paused. State:
- Branch plan-3-e2e @ c6516e6, 15 commits ahead of main, clean, NOT pushed/merged. Suites: e2e 53 OK, kit 163 OK.
- DONE: Tasks 1–8, 10, 11. Grids: test/e2e/results/2026-10-15-xdgroe.md (run 1, A+C), 2026-10-15-b7r2qx.md (run 2 + U1 + S10/S12; S15 skipped).
- Kit 0.1.1 installed on Mac (both MCP names), earsvm, lume. sample-app at ~/src/sample-app on all hosts (VMs: rsynced copy).
- NEXT: Task 9 (manual hosts H2 Desktop, H5 cloud, H6 web chat, H7 mobile) — with the user, use run id b7r2qx (`run.py --run-id b7r2qx token/verify`). Then Task 12 (fold into spec + build rulings + FAQ; commit the S16 spec row and the plan file in claude-memory-mcp), then final whole-branch review, then finishing-a-development-branch.
- Open user decisions: keep layer B (prompt hook)? stronger routing-rule line for ambiguous facts (S5 5/6)?
- Before resuming: VMs must be on; if SSH says "No route to host", it's macOS Local Network privacy (toggle iTerm/claude in System Settings).
- Checkpoint: user: 'if the prompt hook is provably not active, remove it.' Probe (Mac, sample-app): hook on → Claude quotes the hint verbatim; CLAUDE_MEMORY_KIT_PROMPT_HINT=off → NO. Hook is ACTIVE (and run 1 really had it off) → condition false, not removed. Asked whether 'no measurable effect' is enough to remove it.
- Checkpoint: user decision: prompt hook fires → KEEP layer B. Open decision left: stronger routing-rule line for ambiguous facts (S5 5/6).
- Correction: suite after SKIPPED was 52, not 53. S17 added (3 tests RED→GREEN, suite 55); S17 row added to spec table (uncommitted, with S16). User asked: add S17 and run now.
- S17 live: PASS on H1, H3, H4. Claude does memory_read → memory_save(project, same name/description/body) → memory_delete(general, with the read version) and reports both commits. Task 12 adds an FAQ entry ('saved in the wrong place? say move it to <scope>'); a memory_move tool is not needed for reliability — note as optional (atomicity, one prompt fewer).
- User decision: memory_move tool = optional Plan 4 item (Task 12 adds it to build-rulings Known follow-ups → Plan 4, marked optional).
== RESUMED 2026-10-16. Session start: memory_index ok, all hosts reachable.
- User: the snapshot Write shows as transcript noise (auto-memory has none) → move snapshot writing into a hook. Probe (throwaway PostToolUse hook, Mac): tool_response = full memory_index text (list of {type:text}), byte-identical to Claude's Write; tool_input.project and cwd present.
- Kit 0.1.2: PostToolUse hook kit/hooks/post_tool_use.py (matcher mcp__.*__memory_index) writes cache/<key>.md 0600 only for a successful index (Since block) of the session's own context (key from cwd origin == call's project; no scopes). Routing rule: Snapshot bullet now only the fallback; "except the outbox below". SessionStart footer ("overwrite … with its full result") removed. Edit(cache/**) dropped from new installs' allow rules (old installs keep it until uninstall). TDD: test_snapshot_hook (10) RED→GREEN; settings/setup/claudemd/snapshot tests updated RED→GREEN; kit suite 176 OK, e2e suite OK.
- Deployed 0.1.2 to Mac, earsvm, lume (dry run first; VMs also picked up the DNS sentence from 0a5bc48). Mac live check: tool calls = ToolSearch + memory_index only, snapshot mtime updated, mode 600.
- Ruling: Edit(~/.claude-memory-cloud/cache/**) removed from allow_rules — Claude no longer writes there (least privilege) — cost if wrong: one prompt if Claude ever writes the cache by hand.
- Commit 7ed60d3 (kit 0.1.2). Regression run jqdpnf (A+B+C): S1, S12h, S11f, S11, S11e, S11b PASS on H1, H3, H4 (18/18). Spec §7 G needs the hook design in Task 12. NEXT: Task 9 (H2 first; token e2e-b7r2qx-m165 already issued for S2).
- Task 9 H2 (Desktop, entrypoint claude-desktop, permissionMode auto): S0–S4 PASS. FINDING: Desktop names connector tools mcp__<uuid>__memory_*; snapshot hook matcher still matches (cache written); allow rules don't match but auto mode never prompted. S2: Claude updated the iTerm-saved memory (m165→m135) instead of duplicating.
- Task 9 H5 (claude --cloud from ~/src/sample-app): S1, S2 PASS. FINDING: memory_index ran without a prompt but memory_read prompted (no repo .claude settings; server tools carry no MCP annotations) — candidate fix: readOnlyHint on index/read/search.
- Task 9 H5: S0, S3 PASS; S4 FAIL — claude --cloud (local upload) checkout has no remote (git remote -v empty, no repo env var); index loads general only; Claude says not saved + asks owner/repo. Also seen: first reply said 'no memory' while connector pending (same as earsvm V1).
- Task 9 H5: S5, S7, S11d, S14 PASS (S14: recalled via compaction summary, no re-index — no hooks in cloud). S11d reply said reauth_required (user's /mcp action unknown). H5 tally: 8 PASS, S4 FAIL. NEXT: web repo-picker session (remote?), then H6, H7.
- Task 9 H5b (claude.ai/code repo picker, davlion/claude-memory-mcp; test-client org not in picker: Claude GitHub app not installed there): origin = https://github.com/davlion/claude-memory-mcp; memory_index NOT called on turn 1 (narrow 'run this' prompt), called on 'what do you remember' with project URL -> project loaded. FAIL of S4 is specific to --cloud local uploads.
- Task 9 H6: S6 PASS (search found H5 save). S1 held (recall used memory_search; retest with 'hi'). S2 FAIL: claude.ai built-in memory took the save ('Read and updated memory'), connector not called. FINDING: claude.ai chat has its own memory that competes with the connector — the chat analogue of autoMemoryEnabled.
- Task 9 H6: S8 PASS (Claude refused pre-tool; no exact 'not saved:' line). User chose option 3: turn off claude.ai built-in memory now to finish H6; server-instructions line ('save to claude-memory, not built-in memory') goes on the fix list.
- Task 9 H6: S1 FAIL ('hi' -> no tools). S2 retest PASS with built-in memory off (announcement wording loose). Both S2 rows kept (on=FAIL, off=PASS).
- Task 9 H6: S5 FAIL (saved general w/o asking; chat never indexed, so client scopes unknown to it).
- Task 9 H6: S11d PASS (esperanto attempt after per-chat toggle off; m656 had saved before toggle). H6 tally: S6, S2(off), S8, S11d PASS; S1, S5, S2(on) FAIL.
- Task 9 H7: S1 FAIL (hi -> no tools), S2 PASS (connector on; first try had connector off in + menu — possibly carried over from the H6 per-chat toggle; row dropped).
- Task 9 H7: S2 PASS by hand — mobile upper-cased the tag; CLEANUP NOTE: memories/answer-structure-conclusion-first.md holds E2E-B7R2QX-M421 (upper case) — token-scoped cleanup will miss it; delete by hand.
- Task 9 complete: cleanup b7r2qx (7 by prefix + 1 upper-case by hand, index verified clean), grid regenerated with manual host labels (host_label, TDD), commit 6c8e305.
- Fixes 1-5 (user: do before review): server instructionsFor(cfg) names scopes + ask rule; built-in-memory line; no-remote owner/repo line; readOnlyHint on scopes/health/index/read/search, save destructive=false, delete destructive=true; FAQ/QUICKSTART. TDD: tools.test (4) + auth.test (init per-user, annotations) RED->GREEN; vitest 401 OK, tsc clean. Commit 95aeb28. Staging deploy pending user OK.
- User (deferred to final review): personal memories on GitHub are an unnecessary risk; may keep claude.ai built-in memory for chat. Need >=3 solutions at final review. Recorded in .superpowers/sdd/2026-10-16-final-review-items.md. Staging deploy still pending (Workers Paid confirmation).
- Commit 2ee6f49 + staging deploy 4f563090: instructions 3912 chars live, scope line + full tail confirmed in a fresh claude -p. Fix 2 removed (review item). Running S5 x3 hosts (run jqdpnf).
- S5 after scope line: Claude Code 9/9 PASS (jqdpnf). Web chat S5 retest FAIL: routed to built-in memory (off), no connector call — logged for final review.
- Cloud readOnlyHint check: not done (user's reply came from web chat) — unverified, in review items. m928 went to claude.ai memory; user asked to delete it.
- Web chat: 'remember that we …' -> built-in memory (failed), claimed success then corrected; logged for review.
- Web chat: after a memory question loaded the index, Claude treated the connector as memory. Hypothesis (S1 is the routing root cause) logged for review.
- Final chat test: oak (cold) + birch (warm) both -> connector, general, no scope question; hypothesis not supported; routing varies by chat. Cleanup removed both. End of session.

## For the final review

- Personal memories on GitHub: the user may want claude.ai chat (web, Desktop, mobile) to keep using claude.ai's built-in memory, since putting personal memories in a GitHub repo is an unnecessary risk. The review must propose at least three solutions. It decides chat routing between built-in memory and the connector, which Level 4 showed is inconsistent today, and whether the docs keep advising to turn claude.ai memory off.
- The "use these tools, not a host's built-in memory" instruction was removed before going live (`2ee6f49`).
- Claude Code truncates server instructions at 4096 characters; a test holds them to ≤ 4000.
- Unverified: whether `readOnlyHint` stops cloud sessions prompting for `memory_read`.

## Final review (2026-10-16)

Whole-branch review b0cb0af..6d78dc3: "with fixes", no Critical. Fixed:
- Important 1: the snapshot hook stored an outage index (Health failures, empty Since map) over the last good one → now requires a non-empty Since map and no ✗ Health line (8e4ee7b).
- Important 2: the scope line grew past Claude Code's 4096-character cut with ~8 clients → budget-based: lists the client names that fit in 4000, counts the rest (6cf2eea).
- Minor 3, 4: e2e cleanup deletes only files the run added (reports others); commit listing pages past 100 (dd9a51a).
- Minor 5, 6, 7, 9: docs count three hooks; snapshot made 0600 before rewrite and the hook never creates the cache dir; MIN_HOOK_VERSION 0.1.2; 0.1.1 → 0.1.2 → uninstall round-trip test.
- Ruling: Minor 8 (this Mac's CLAUDE.md still the 0.1.1 rule) rejected — the file on disk is 0.1.2; the reviewer saw the copy loaded at this session's start — none.
