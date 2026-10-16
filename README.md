# claude-memory-cloud

A Cloudflare Worker (TypeScript) that serves Claude memory tools over remote MCP, storing memories in GitHub repos. Auth is GitHub OAuth through a GitHub App.

- [Quickstart](docs/QUICKSTART.md)
- [FAQ](docs/FAQ.md)
- Design spec: `docs/superpowers/specs/` in the `claude-memory-mcp` repo (cloud memory design).

## Develop

```bash
npm ci
cp .dev.vars.example .dev.vars   # then fill in real values (staging app, your SCOPES); never commit this file
npm test                         # vitest in workerd (no network, GitHub is mocked)
npm run typecheck
npm run dev                      # local wrangler dev
```

## Local kit (each Mac or VM)

`./setup.sh` turns off Claude Code's auto-memory and installs the memory routing rule and three hooks; `./setup.sh --uninstall` reverses it. See [Quickstart Part 7](docs/QUICKSTART.md#part-7--set-up-each-machine) and [UNINSTALL.md](docs/UNINSTALL.md).

```bash
npm run test:local               # Level 3 tests (Python 3.9+, stdlib only; temporary HOME, never your ~/.claude)
```

## Deploy

Secrets: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, and `SCOPES` (per-user scope map, from a gitignored `scopes.<env>.json`). See docs/QUICKSTART.md Part 5.

```bash
npm run deploy:staging
npm run deploy:production
```
