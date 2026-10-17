#!/usr/bin/env node
// Checks that the git-ignored wrangler.local.jsonc carries the template's WORKER_VERSION and MIN_HOOK_VERSION, so a
// version bump in wrangler.jsonc isn't silently left out of a deploy. scripts/wrangler.sh runs it; no local file is OK.
// Usage: node scripts/check-config.mjs
import { existsSync, readFileSync } from "node:fs";
import { versionDrift } from "./config-rules.mjs";

if (!existsSync("wrangler.local.jsonc")) process.exit(0);
const drift = versionDrift(readFileSync("wrangler.jsonc", "utf8"), readFileSync("wrangler.local.jsonc", "utf8"));
if (drift.length) {
  console.error(`wrangler.local.jsonc is out of step with wrangler.jsonc; copy the versions across:\n  ${drift.join("\n  ")}`);
  process.exit(1);
}
