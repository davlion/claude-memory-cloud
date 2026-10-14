import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

it("serves /health", async () => {
  const res = await exports.default.fetch("https://memory.test/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});
