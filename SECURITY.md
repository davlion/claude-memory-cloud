# Security

claude-memory-cloud holds people's memories, so security reports are welcome.

## Reporting a vulnerability

Report it privately through GitHub: on this repo's **Security** tab, choose **Report a vulnerability**. Please don't open a public issue or pull request for it.

Include what you found, how to reproduce it, and what an attacker could do with it. You'll get a reply as soon as possible. The project is maintained by one person, so allow a few days.

## What counts

Report anything that lets someone:

- read, change or delete memories they weren't given access to, or reach a scope that isn't theirs
- sign in without being on the server's allowlist, or take over someone else's connection
- make the server skip its checks on a save (the secret scanner, the personal-fact guard, the cross-client check)
- make the server's own messages appear to come from memory content, or the reverse
- get the local kit to run commands or write files outside `~/.claude-memory-cloud` and the two files it manages in `~/.claude`

Known limits aren't vulnerabilities. The guard uses regular expressions, so it misses reworded personal facts and some secret formats, and the duplicate check compares wording, not meaning. These are described in [docs/DECISIONS.md](docs/DECISIONS.md) and [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md). A way to get the server to skip a check entirely is a vulnerability.

## Supported versions

Only the latest code on `main` is supported. If you run your own server, deploy the latest version before reporting.
