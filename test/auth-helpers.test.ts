import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { exchangeCode, isAllowedRedirect, refreshGitHubToken, s256 } from "../src/github-auth";
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
    const body = new URLSearchParams(await calls[0]!.text());
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
