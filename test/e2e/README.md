# Level 4 end-to-end tests

Drives real Claude Code sessions against the **staging** server and checks the outcome in the test repos
(`davlion/claude-memory-test`, `davlion-test-client/claude-memory`) with `gh api`. Spec: §9 Level 4.

**After a run,** `memory_index` shows a ⚠ provenance warning for the test repo: cleanup deletes files with
`gh api`, which the server rightly flags as a change made outside it. It clears at the next save through the
server.

**Safety:** it writes only to those two repos. Every test memory carries `e2e-<run>-<n>`, and cleanup deletes
only files holding the run's token. Raw transcripts (`results/raw/`) hold memory content and are gitignored.

Run from the Mac in a normal terminal (not inside a Claude Code session if you can avoid it; the runner
scrubs the parent session's variables either way). Needs `gh` signed in with access to both repos, and the
VMs on for H3/H4.

    python3 test/e2e/run.py hosts                                       # reachability
    python3 test/e2e/run.py run --layers A+C --hosts H1,H3,H4 --scenarios S1,S2,S3,S4,S4n,S5,S8
    python3 test/e2e/run.py run --hosts H1 --scenarios S11,S14,S16
    python3 test/e2e/run.py pair --a H1 --b H3 --scenarios S6,S9,S11c,S13
    python3 test/e2e/run.py report                                      # results/<date>-<run>.md
    python3 test/e2e/run.py cleanup                                     # after a crash or --keep

S20 (cross-client) needs a second client scope in staging `SCOPES`; set `"second_client_scope"` in `e2e.json` to
its name, otherwise S20 is recorded as skipped. The scope's repo need not exist (`davlion-second-client` doesn't).
It passes when the other client's name never reaches this client's repo and nothing is sent to the other scope:
Claude may refuse or save only this client's part. Claude usually declines before calling the server, so the
server's `rejected_cross_client` backstop is covered by unit tests rather than here.

S21 (guard probes) checks the server's guard itself. Claude is told to send five fixed `memory_save` calls with
fake content (a health fact, the same with `force`, a token-shaped string, a candid opinion, a health fact in project
scope), and each must come back with the server's refusal. S18 and S19 pass the same whether Claude or the server
refused; S21 reads the server's status. A probe Claude declines to send is a soft fail, since the server wasn't tested.

    python3 test/e2e/run.py run --hosts H1 --scenarios S21

Manual hosts (Desktop app, cloud, web chat, mobile): `run.py token --scenario S2` prints a prompt with a
fresh token; paste it, then `run.py verify --token <t> --scenario S2 --host H6`.

**Staging only.** Each host's `mcp_prefixes` name the staging connector. The production connector's memory tools
(`deny_mcp_prefixes` in `e2e.json`) are disallowed in every test session, and a session that loaded memory tools but
not staging's stops with `WrongConnector`, so a run can't touch production even when both connectors are connected.

Offline unit tests: `npm run test:e2e`.
