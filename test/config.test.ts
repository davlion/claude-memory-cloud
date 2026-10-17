import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { versionDrift } from "../scripts/config-rules.mjs";

const config = (staging: string, production: string) => `{
  // a comment
  "vars": { "PUBLIC_URL": "https://a.dev", "WORKER_VERSION": "${staging}", "MIN_HOOK_VERSION": "0.1.3" },
  "env": { "production": { "vars": { "PUBLIC_URL": "https://b.dev", "WORKER_VERSION": "${production}", "MIN_HOOK_VERSION": "0.1.3" } } }
}`;

describe("scripts/config-rules.mjs", () => {
  it("finds no drift when the local config has the template's versions", () => {
    expect(versionDrift(config("0.1.2", "0.1.2"), config("0.1.2", "0.1.2"))).toEqual([]);
  });

  it("names each version the local config doesn't match, per environment", () => {
    expect(versionDrift(config("0.1.3", "0.1.3"), config("0.1.3", "0.1.2"))).toEqual([
      "production WORKER_VERSION: wrangler.jsonc has 0.1.3, wrangler.local.jsonc has 0.1.2",
    ]);
  });

  it("reports an environment missing from the local config", () => {
    expect(versionDrift(config("0.1.2", "0.1.2"), '{"vars": {"WORKER_VERSION": "0.1.2", "MIN_HOOK_VERSION": "0.1.3"}}')).toEqual([
      "production WORKER_VERSION: wrangler.jsonc has 0.1.2, wrangler.local.jsonc has nothing",
      "production MIN_HOOK_VERSION: wrangler.jsonc has 0.1.3, wrangler.local.jsonc has nothing",
    ]);
  });
});
