#!/usr/bin/env node
// Validates a SCOPES JSON file with the same rules the server uses. Run it before `wrangler secret put SCOPES`.
// Usage: node scripts/check-scopes.mjs scopes.production.json
import { readFileSync } from "node:fs";
import { scopesError } from "./scopes-rules.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/check-scopes.mjs <scopes.json>");
  process.exit(2);
}
let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  console.error(`cannot read ${file}`);
  process.exit(2);
}
const err = scopesError(text);
if (err) {
  console.error(err);
  process.exit(1);
}
console.log("OK");
