import { env, exports } from "cloudflare:workers";
import { EncryptingStore } from "../src/encrypting-store";
import { GitHub } from "../src/github";
import { buildStore, mcpApi } from "../src/mcp-api";
import { describe, expect, it } from "vitest";

describe("worker wiring", () => {
  it("/health is public and versioned", async () => {
    const res = await exports.default.fetch("https://memory.test/health");
    expect(await res.json()).toEqual({ ok: true, version: "0.1.5", min_hook_version: "0.1.5" });
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

describe("per-user scopes at /mcp", () => {
  it("answers 403 for a signed-in user who is no longer in SCOPES", async () => {
    const props = { login: "gone", githubToken: "t", githubRefreshToken: "r", githubTokenExpiresAt: Date.now() + 3600_000 };
    const res = await mcpApi.fetch(new Request("https://memory.test/mcp", { method: "POST", body: "{}" }), env, { props } as never);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "access_denied", message: "This GitHub account is no longer on this memory server's allowlist.", retryable: false });
  });

  const call = (githubId?: number) => {
    const props = { login: "erin", githubToken: "t", githubRefreshToken: "r", githubTokenExpiresAt: Date.now() + 3600_000, ...(githubId === undefined ? {} : { githubId }) };
    return mcpApi.fetch(new Request("https://memory.test/mcp", { method: "POST", body: "{}" }), env, { props } as never);
  };
  it("refuses a grant whose githubId differs from the pinned ID", async () => {
    await env.OAUTH_KV.put("allowlist:github-id:erin", "100");
    const res = await call(999);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "access_denied" });
  });
  it("accepts a grant whose githubId matches the pin", async () => {
    await env.OAUTH_KV.put("allowlist:github-id:erin", "100");
    expect((await call(100)).status).toBe(415); // past the pin; the bare body fails later
  });
  it("accepts when no pin exists", async () => {
    await env.OAUTH_KV.delete("allowlist:github-id:erin");
    expect((await call(100)).status).toBe(415); // past the pin; the bare body fails later
    expect(await env.OAUTH_KV.get("allowlist:github-id:erin")).toBe("100"); // a pin lost at sign-in is recorded now
  });
  it("accepts a legacy grant without githubId (login check still applies)", async () => {
    await env.OAUTH_KV.put("allowlist:github-id:erin", "100");
    expect((await call()).status).toBe(415);
  });
});

describe("pin read failure", () => {
  it("answers a retryable 503 'unavailable' when OAUTH_KV throws", async () => {
    const broken = { ...env, OAUTH_KV: { get: async () => { throw new Error("KV GET failed: 429"); } } } as never;
    const props = { login: "erin", githubToken: "t", githubRefreshToken: "r", githubTokenExpiresAt: Date.now() + 3600_000, githubId: 100 };
    const res = await mcpApi.fetch(new Request("https://memory.test/mcp", { method: "POST", body: "{}" }), broken, { props } as never);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "unavailable", retryable: true });
  });
});

describe("rate limiting of unauthenticated KV-writing endpoints", () => {
  const statuses = async (path: string, init: RequestInit) => {
    const out: number[] = [];
    // 25 > 2 × the limit of 10, so a 429 shows up even if a 60 s window rolls over mid-loop.
    for (let i = 0; i < 25; i++) out.push((await exports.default.fetch(`https://memory.test${path}`, init)).status);
    return out;
  };
  it("POST /register", async () => {
    const s = await statuses("/register", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" },
      body: JSON.stringify({ client_name: "x", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "none" }) });
    expect(s[0]).toBe(201);
    expect(s).toContain(429);
  });
  it("GET /authorize", async () => {
    const s = await statuses("/authorize", { headers: { "cf-connecting-ip": "198.51.100.8" } });
    expect(s[0]).not.toBe(429);
    expect(s).toContain(429);
  });
  it("not /health", async () => {
    expect(await statuses("/health", { headers: { "cf-connecting-ip": "198.51.100.9" } })).not.toContain(429);
  });
  it("429 carries retry-after: 60", async () => {
    const init = { headers: { "cf-connecting-ip": "198.51.100.10" } };
    let last!: Response;
    for (let i = 0; i < 25; i++) { last = await exports.default.fetch("https://memory.test/authorize", init); if (last.status === 429) break; }
    expect(last.status).toBe(429);
    expect(last.headers.get("retry-after")).toBe("60");
  });
});

describe("a broken server configuration is a shaped response, not a 500", () => {
  const props = { login: "dav", githubToken: "t", githubRefreshToken: "r", githubTokenExpiresAt: Date.now() + 3600_000 };
  it("/mcp with a malformed SCOPES → 503 JSON, nothing echoed", async () => {
    const bad = { ...env, SCOPES: '{"dav": {"general": "not a repo ghu_secret"}}' };
    const res = await mcpApi.fetch(new Request("https://memory.test/mcp", { method: "POST", body: "{}" }), bad as never, { props } as never);
    expect(res.status).toBe(503);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: "internal", message: "memory server misconfigured: SCOPES is invalid",
      action: "The server owner must fix the SCOPES secret (see SELF-HOSTING/QUICKSTART)", retryable: false });
    expect(body).not.toContain("ghu_secret");
  });
  it("/mcp 503 for an unavailable KV uses the same shape", async () => {
    const kv = { ...env, OAUTH_KV: { get: () => { throw new Error("KV down"); } } };
    const res = await mcpApi.fetch(new Request("https://memory.test/mcp", { method: "POST", body: "{}" }),
      kv as never, { props: { ...props, githubId: 1 } } as never);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "unavailable", retryable: true });
  });
});

describe("encryption wiring", () => {
  const gh = new GitHub("t");
  it("builds an EncryptingStore with the key page URL; the key ring is null without the master key", async () => {
    const s = (await buildStore(gh, env)) as unknown as { keys: unknown; keysUrl: string };
    expect(await buildStore(gh, env)).toBeInstanceOf(EncryptingStore);
    expect(s.keys).not.toBeNull();
    expect(s.keysUrl).toBe(`${env.PUBLIC_URL}/keys`);
    const bare = (await buildStore(gh, { ...env, MEMORY_MASTER_KEY: undefined })) as unknown as { keys: unknown };
    expect(bare.keys).toBeNull();
  });
  it("a malformed master key answers 503 without echoing it", async () => {
    const props = { login: "erin", githubToken: "t", githubRefreshToken: "r", githubTokenExpiresAt: Date.now() + 3600_000 };
    const bad = { ...env, MEMORY_MASTER_KEY: "not-a-key-SECRET" };
    const res = await mcpApi.fetch(new Request("https://memory.test/mcp", { method: "POST", body: "{}" }), bad, { props } as never);
    expect(res.status).toBe(503);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({ error: "internal", message: "memory server misconfigured: MEMORY_MASTER_KEY is invalid", retryable: false });
    expect(text).not.toContain("SECRET");
  });
});
