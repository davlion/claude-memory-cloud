#!/usr/bin/env node
// Runs before `npm run deploy:*`. The server needs Workers Paid (each call uses 30–110 ms of CPU; Free allows 10 ms),
// and wrangler's login token can't read the account's plan, so ask once and remember the answer in .wrangler/.
// Non-interactive runs (CI) can set CMC_WORKERS_PAID=1 instead.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";

const marker = ".wrangler/workers-paid-confirmed";
const where = "Cloudflare dashboard → Workers & Pages → Plans";

if (process.env.CMC_WORKERS_PAID === "1" || existsSync(marker)) process.exit(0);

if (!process.stdin.isTTY) {
  console.error(`deploy: this server needs Workers Paid ($5/month). Check under ${where}, then rerun interactively or set CMC_WORKERS_PAID=1.`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
// Ctrl+D or Ctrl+C rejects the question; treat it as "no".
const answer = await rl.question(`Is this Cloudflare account on Workers Paid? (${where}) [y/N] `).catch(() => "");
rl.close();

if (!/^y(es)?$/i.test(answer.trim())) {
  console.error(
    `deploy: stopped. On the Free plan most memory calls fail with "exceeded resource limits" (10 ms CPU per request).\n` +
      `Upgrade under ${where}, then deploy again. See "What are the Cloudflare limits?" in docs/FAQ.md.`,
  );
  process.exit(1);
}
mkdirSync(".wrangler", { recursive: true });
writeFileSync(marker, `confirmed ${new Date().toISOString()}\n`);
