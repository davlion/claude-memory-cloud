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

Manual hosts (Desktop app, cloud, web chat, mobile): `run.py token --scenario S2` prints a prompt with a
fresh token; paste it, then `run.py verify --token <t> --scenario S2 --host H6`.

Offline unit tests: `npm run test:e2e`.
