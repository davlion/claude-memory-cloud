import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { AuthorizationError } from "@cloudflare/workers-oauth-provider";
import { authHandler, exchangeCode, isAllowedRedirect, isAllowedUser, refreshGitHubToken, s256, tokenExchangeCallback } from "../src/github-auth";
import { json, mockFetch } from "./setup";

describe("isAllowedRedirect", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "http://localhost:54321/callback",
    "http://127.0.0.1:8080/oauth/callback",
  ])("allows %s", (u) => expect(isAllowedRedirect(u)).toBe(true));
  it.each([
    "https://evil.example/cb",
    "https://claude.ai.evil.example/api/mcp/auth_callback",
    "https://claude.ai/other",
    "http://claude.ai/api/mcp/auth_callback",
    "https://localhost/cb",
    "not a url",
    "http://localhost@evil.example/cb",
    "http://localhost.evil.example/cb",
    "https://claude.ai/api/mcp/auth_callback?x=1",
    "https://claude.ai/api/mcp/auth_callback/",
    "https://claude.ai/api/mcp/../mcp/auth_callback",
  ])("rejects %s", (u) => expect(isAllowedRedirect(u)).toBe(false));
});

it("s256 matches RFC 7636 appendix B", async () => {
  expect(await s256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

describe("exchangeCode", () => {
  it("posts code + verifier and parses JSON", async () => {
    const { calls } = mockFetch([{ method: "POST", url: "https://github.com/login/oauth/access_token", respond: () =>
      json({ access_token: "ghu_a", refresh_token: "ghr_a", expires_in: 28800, token_type: "bearer" }) }]);
    expect(await exchangeCode(env, "CODE", "VER")).toEqual({ accessToken: "ghu_a", refreshToken: "ghr_a", expiresIn: 28800 });
    const body = new URLSearchParams(Object.fromEntries([...(await calls[0]!.formData()).entries()] as [string, string][]));
    expect(Object.fromEntries(body)).toMatchObject({ client_id: "Iv1.testclient", client_secret: "test-secret", code: "CODE", code_verifier: "VER",
      redirect_uri: "https://memory.test/callback" });
    expect(calls[0]!.headers.get("accept")).toBe("application/json");
  });
  it("throws on a 200 with error field", async () => {
    mockFetch([{ method: "POST", url: "https://github.com/login/oauth/access_token", respond: () => json({ error: "bad_verification_code" }) }]);
    await expect(exchangeCode(env, "C", "V")).rejects.toThrow(/bad_verification_code/);
  });
});

describe("refreshGitHubToken", () => {
  it("ok", async () => {
    mockFetch([{ method: "POST", url: "https://github.com/login/oauth/access_token", respond: () =>
      json({ access_token: "ghu_b", refresh_token: "ghr_b", expires_in: 28800 }) }]);
    expect(await refreshGitHubToken(env, "ghr_a")).toEqual({ ok: true, accessToken: "ghu_b", refreshToken: "ghr_b", expiresIn: 28800 });
  });
  it("revoked", async () => {
    mockFetch([{ method: "POST", url: "https://github.com/login/oauth/access_token", respond: () => json({ error: "bad_refresh_token" }) }]);
    expect(await refreshGitHubToken(env, "x")).toEqual({ ok: false, revoked: true });
  });
  it("outage", async () => {
    mockFetch([{ method: "POST", url: "https://github.com/login/oauth/access_token", respond: () => json({}, 502) }]);
    expect(await refreshGitHubToken(env, "x")).toEqual({ ok: false, revoked: false });
  });
});

describe("refresh hardening", () => {
  const url = "https://github.com/login/oauth/access_token";
  it("other error values are transient, not revoked", async () => {
    mockFetch([{ method: "POST", url, respond: () => json({ error: "incorrect_client_credentials" }) }]);
    expect(await refreshGitHubToken(env, "x")).toEqual({ ok: false, revoked: false });
  });
  it("network error is transient", async () => {
    mockFetch([{ method: "POST", url, respond: () => { throw new TypeError("network"); } }]);
    expect(await refreshGitHubToken(env, "x")).toEqual({ ok: false, revoked: false });
  });
  it("non-JSON 200 is transient", async () => {
    mockFetch([{ method: "POST", url, respond: () => new Response("<html>", { status: 200 }) }]);
    expect(await refreshGitHubToken(env, "x")).toEqual({ ok: false, revoked: false });
  });
  it("keeps the old refresh token when the response omits one", async () => {
    mockFetch([{ method: "POST", url, respond: () => json({ access_token: "ghu_c", expires_in: 100 }) }]);
    expect(await refreshGitHubToken(env, "ghr_old")).toMatchObject({ ok: true, refreshToken: "ghr_old" });
  });
  it("tokenExchangeCallback maps errors", async () => {
    const props = { login: "u", githubToken: "t", githubRefreshToken: "r", githubTokenExpiresAt: Date.now() };
    mockFetch([{ method: "POST", url, respond: () => json({ error: "bad_refresh_token" }) }]);
    await expect(tokenExchangeCallback({ grantType: "refresh_token", props, env })).rejects.toMatchObject({ code: "invalid_grant" });
    mockFetch([{ method: "POST", url, respond: () => json({ error: "incorrect_client_credentials" }) }]);
    await expect(tokenExchangeCallback({ grantType: "refresh_token", props, env })).rejects.toMatchObject({ code: "temporarily_unavailable" });
  });
});

describe("authHandler error path", () => {
  const stub = (redirectUri: string) => ({
    ...env,
    OAUTH_PROVIDER: {
      parseAuthRequest: async () => {
        throw new AuthorizationError("unsupported_response_type", {
          description: "bad", redirectUri, redirectTo: `${redirectUri}?error=unsupported_response_type`,
        } as never);
      },
    },
  }) as unknown as typeof env;
  it("does not redirect to a disallowed (DCR-registered) URI", async () => {
    const res = await authHandler.fetch(new Request("https://memory.test/authorize"), stub("https://evil.example/cb"));
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
  });
  it("still redirects to an allowed URI", async () => {
    const res = await authHandler.fetch(new Request("https://memory.test/authorize"), stub("https://claude.ai/api/mcp/auth_callback"));
    expect(res.status).toBe(302);
  });
});

describe("isAllowedUser (sign-in allowlist)", () => {
  it("refuses a login that isn't in SCOPES", async () => {
    expect(await isAllowedUser(env, { login: "nobody", id: 1 })).toBe(false);
  });
  it("pins the numeric ID at first sign-in and refuses a different ID for the same login", async () => {
    expect(await isAllowedUser(env, { login: "erin", id: 70 })).toBe(true);
    expect(await env.OAUTH_KV.get("allowlist:github-id:erin")).toBe("70");
    expect(await isAllowedUser(env, { login: "Erin", id: 70 })).toBe(true);
    expect(await isAllowedUser(env, { login: "erin", id: 71 })).toBe(false);
  });
});
