// Pure helpers for scripts/check-config.mjs (no Node imports, so test/config.test.ts can run them in the Workers pool).
// wrangler.jsonc is the committed template; a git-ignored wrangler.local.jsonc holds one deployment's real values.
import { stripJsonc } from "./friends-rules.mjs";

const VERSION_VARS = ["WORKER_VERSION", "MIN_HOOK_VERSION"];

/** Each environment's vars, keyed by environment name ("staging" for the top level). */
function varsByEnv(jsonc) {
  const cfg = JSON.parse(stripJsonc(jsonc));
  const envs = Object.entries(cfg.env ?? {}).map(([name, e]) => [name, e?.vars ?? {}]);
  return Object.fromEntries([["staging", cfg.vars ?? {}], ...envs]);
}

/** Version vars where the local config differs from the template, as messages; empty when they agree. */
export function versionDrift(templateJsonc, localJsonc) {
  const template = varsByEnv(templateJsonc), local = varsByEnv(localJsonc);
  const out = [];
  for (const [env, vars] of Object.entries(template)) {
    for (const v of VERSION_VARS) {
      const mine = local[env]?.[v];
      if (vars[v] !== mine) out.push(`${env} ${v}: wrangler.jsonc has ${vars[v]}, wrangler.local.jsonc has ${mine ?? "nothing"}`);
    }
  }
  return out;
}
