import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          PUBLIC_URL: "https://memory.test",
          // Explicit bindings here override anything wrangler loads from .dev.vars (miniflare options are merged on top).
          SCOPES: JSON.stringify({
            dav: { general: "davlion/claude-memory-test", acme: "acme-org/claude-memory" },
            carol: { general: "carol/claude-memory" },
            erin: { general: "erin/claude-memory" },
          }),
          MEMORY_MASTER_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
          GITHUB_CLIENT_ID: "Iv1.testclient",
          GITHUB_CLIENT_SECRET: "test-secret",
          GITHUB_TEST_TOKEN: process.env.GITHUB_TEST_TOKEN ?? "",
          GITHUB_TEST_REPO: process.env.GITHUB_TEST_REPO ?? "",
        },
      },
    }),
  ],
  test: {
    setupFiles: ["test/setup.ts"],
    // vitest 5's on-disk module cache can't be read back from inside workerd
    // ("no such file or directory, readAll ...node_modules/.vitest-cache/..."), so turn it off.
    fsModuleCache: false,
  },
});
