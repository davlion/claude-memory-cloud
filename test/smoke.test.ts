import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { json, mockFetch } from "./setup";

it("serves /health", async () => {
  const res = await exports.default.fetch("https://memory.test/health");
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ ok: true });
});

it("mockFetch intercepts outbound fetch from worker code", async () => {
  mockFetch([{ url: "https://api.github.com/zen", respond: () => json({}, 418) }]);
  const res = await exports.default.fetch("https://memory.test/health?probe=https://api.github.com/zen");
  expect(await res.json()).toEqual({ probed: 418 });
});
