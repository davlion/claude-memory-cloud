import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("worker wiring", () => {
  it("/health is public and versioned", async () => {
    const res = await exports.default.fetch("https://memory.test/health");
    expect(await res.json()).toEqual({ ok: true, version: "0.1.0", min_hook_version: "0.1.0" });
  });

  it("rejects requests for another host (issuer spoofing)", async () => {
    const res = await exports.default.fetch("https://evil.example/health");
    expect(res.status).toBe(421);
  });

  it("rejects http:// on the public host (full-origin pin)", async () => {
    const res = await exports.default.fetch("http://memory.test/health");
    expect(res.status).toBe(421);
  });

  it("/mcp without a token → 401 with resource metadata pointer", async () => {
    const res = await exports.default.fetch("https://memory.test/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/resource_metadata=/);
  });

  it("publishes OAuth metadata", async () => {
    const res = await exports.default.fetch("https://memory.test/.well-known/oauth-authorization-server");
    const md = (await res.json()) as Record<string, unknown>;
    expect(md.authorization_endpoint).toBe("https://memory.test/authorize");
    expect(md.token_endpoint).toBe("https://memory.test/oauth/token");
    expect(md.registration_endpoint).toBe("https://memory.test/register");
  });
});
