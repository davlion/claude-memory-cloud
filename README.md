# claude-memory-cloud

A Cloudflare Worker (TypeScript) that serves Claude memory tools over remote MCP, storing memories in GitHub repos. Auth is GitHub OAuth through a GitHub App.

- [Quickstart](docs/QUICKSTART.md)
- [FAQ](docs/FAQ.md)
- Design spec: `docs/superpowers/specs/` in the `claude-memory-mcp` repo (cloud memory design).

## Develop

```bash
npm install
cp .dev.vars.example .dev.vars   # then fill in real values; never commit this file
npm test                         # vitest in workerd (no network, GitHub is mocked)
npm run typecheck
npm run dev                      # local wrangler dev
```

## Deploy

```bash
npm run deploy:staging
npm run deploy:production
```
