import { describe, expect, it } from "vitest";
import { GitHub, GitHubError, toOpError } from "../src/github";
import { errorPayload, RETRYABLE } from "../src/errors";
import { json, mockFetch } from "./setup";

describe("GitHub.request", () => {
  it("sends auth headers and parses JSON; records rate limit", async () => {
    const { calls } = mockFetch([{ url: "https://api.github.com/user", respond: () =>
      json({ login: "dav" }, 200, { "x-ratelimit-limit": "5000", "x-ratelimit-remaining": "4999", "x-ratelimit-reset": "1700000000" }) }]);
    const gh = new GitHub("ghu_x");
    expect(await gh.request("GET", "/user")).toEqual({ login: "dav" });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer ghu_x");
    expect(calls[0]!.headers.get("accept")).toBe("application/vnd.github+json");
    expect(calls[0]!.headers.get("x-github-api-version")).toBe("2022-11-28");
    expect(calls[0]!.headers.get("user-agent")).toBe("claude-memory-cloud");
    expect(gh.lastRateLimit).toEqual({ limit: 5000, remaining: 4999, reset: 1700000000 });
  });

  it("returns null for 204", async () => {
    mockFetch([{ url: "https://api.github.com/x", respond: () => new Response(null, { status: 204 }) }]);
    expect(await new GitHub("t").request("DELETE", "/x")).toBeNull();
  });

  const cases: [number, Record<string, string>, unknown, string][] = [
    [401, {}, { message: "Bad credentials" }, "unauthorized"],
    [404, {}, { message: "Not Found" }, "not_found"],
    [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000000" }, { message: "API rate limit exceeded" }, "rate_limited"],
    [429, { "retry-after": "30" }, {}, "rate_limited"],
    [403, {}, { message: "Resource not accessible by integration" }, "forbidden"],
    [409, {}, { message: "Git Repository is empty." }, "empty_repo"],
    [409, {}, { message: "conflict" }, "conflict"],
    [422, {}, { message: "Update is not a fast forward" }, "conflict"],
    [422, {}, { message: "Reference cannot be updated" }, "conflict"],
    [422, {}, { message: "Invalid request" }, "unprocessable"],
    [502, {}, {}, "unavailable"],
  ];
  it.each(cases)("maps %i %j %j → %s", async (status, headers, body, kind) => {
    mockFetch([{ url: "https://api.github.com/y", respond: () => json(body, status, headers) }]);
    const err = await new GitHub("t").request("GET", "/y").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).kind).toBe(kind);
  });

  it("maps network failure to unavailable", async () => {
    mockFetch([{ url: "https://api.github.com/z", respond: () => { throw new TypeError("network"); } }]);
    expect(((await new GitHub("t").request("GET", "/z").catch((e) => e)) as GitHubError).kind).toBe("unavailable");
  });
});

describe("toOpError", () => {
  it("unauthorized → reauth_required with action", () => {
    const e = toOpError(new GitHubError("x", 401, "unauthorized"));
    expect(e.code).toBe("reauth_required");
    expect(e.action).toMatch(/Settings → Connectors/);
  });
  it("rate_limited → unavailable with retryAfter", () => {
    const e = toOpError(new GitHubError("x", 429, "rate_limited", 30));
    expect([e.code, e.retryAfter]).toEqual(["unavailable", 30]);
  });
  it("not_found → not_reachable", () => expect(toOpError(new GitHubError("x", 404, "not_found")).code).toBe("not_reachable"));
});

describe("non-JSON and limit responses", () => {
  it.each([
    [502, "unavailable"], [503, "unavailable"], [401, "unauthorized"], [404, "not_found"], [403, "forbidden"],
  ] as const)("a non-JSON %i is classified by status as %s", async (status, kind) => {
    mockFetch([{ url: "https://api.github.com/h", respond: () =>
      new Response("<html>oops</html>", { status, headers: { "content-type": "text/html" } }) }]);
    const err = await new GitHub("t").request("GET", "/h").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).kind).toBe(kind);
  });

  it("a non-JSON 200 is unavailable, not a raw SyntaxError", async () => {
    mockFetch([{ url: "https://api.github.com/h", respond: () => new Response("<html>", { status: 200 }) }]);
    const err = await new GitHub("t").request("GET", "/h").catch((e) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).kind).toBe("unavailable");
  });

  it("Cloudflare's 'Too many subrequests' becomes server_limit", async () => {
    mockFetch([{ url: "https://api.github.com/s", respond: () => { throw new Error("Too many subrequests."); } }]);
    expect(((await new GitHub("t").request("GET", "/s").catch((e) => e)) as GitHubError).kind).toBe("server_limit");
  });

  it("returns JSON arrays as-is", async () => {
    mockFetch([{ url: "https://api.github.com/list", respond: () => json([{ a: 1 }]) }]);
    expect(await new GitHub("t").request("GET", "/list")).toEqual([{ a: 1 }]);
  });
});

describe("toOpError: final vs retryable", () => {
  it("unprocessable → write_rejected with an action", () => {
    const e = toOpError(new GitHubError("Protected branch update failed", 422, "unprocessable"));
    expect(e.code).toBe("write_rejected");
    expect(e.action).toMatch(/branch protection rule or ruleset/);
  });
  it("an unconfirmed conflict → write_rejected", () =>
    expect(toOpError(new GitHubError("x", 409, "conflict")).code).toBe("write_rejected"));
  it("server_limit → server_limit", () => {
    const e = toOpError(new GitHubError("x", 0, "server_limit"));
    expect(e.code).toBe("server_limit");
    expect(e.action).toMatch(/Cloudflare/);
  });
  it("5xx → unavailable", () => expect(toOpError(new GitHubError("x", 502, "unavailable")).code).toBe("unavailable"));
  it("other GitHub responses → internal", () => expect(toOpError(new GitHubError("x", 400, "other")).code).toBe("internal"));
  it("non-GitHub errors → internal, without echoing the error text", () => {
    const e = toOpError(new TypeError("token ghu_secret leaked"));
    expect(e.code).toBe("internal");
    expect(e.message).not.toContain("ghu_secret");
    expect(e.message).toContain("TypeError");
    expect(e.action).toMatch(/bug/);
  });
  it("unavailable messages are status-only, never the raw text", () => {
    const net = toOpError(new GitHubError("network error: ghu_secret", 0, "unavailable"));
    expect(net.message).toBe("GitHub unreachable (network error)");
    const http = toOpError(new GitHubError("whatever ghu_secret", 503, "unavailable"));
    expect(http.message).toBe("GitHub unavailable (HTTP 503)");
  });
  it("RETRYABLE is exactly reauth_required, unavailable, server_limit", () =>
    expect([...RETRYABLE].sort()).toEqual(["reauth_required", "server_limit", "unavailable"]));
});

describe("cachedGet and graphql", () => {
  it("an unknown GraphQL error type is internal and not retryable", async () => {
    mockFetch([{ method: "POST", url: "https://api.github.com/graphql", respond: () => json({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "m ghu_secret" }] }) }]);
    const err = await new GitHub("t").graphql("q", {}).catch((e) => e);
    const op = toOpError(err);
    expect(op.code).toBe("internal");
    expect(errorPayload(op).retryable).toBe(false);
  });
  it("a rate-limit message without a type is still rate limited (retryable)", async () => {
    mockFetch([{ method: "POST", url: "https://api.github.com/graphql", respond: () => json({ errors: [{ message: "API rate limit exceeded" }] }) }]);
    expect(toOpError(await new GitHub("t").graphql("q", {}).catch((e) => e)).code).toBe("unavailable");
  });
  it("cachedGet fetches a path once per client", async () => {
    const { calls } = mockFetch([{ url: "https://api.github.com/user/installations", respond: () => json({ installations: [] }) }]);
    const gh = new GitHub("t");
    await gh.cachedGet("/user/installations?per_page=100&page=1");
    await gh.cachedGet("/user/installations?per_page=100&page=1");
    expect(calls).toHaveLength(1);
  });
  it("cachedGet does not memoize a failure", async () => {
    let n = 0;
    mockFetch([{ url: "https://api.github.com/x", respond: () => (++n === 1 ? json({}, 502) : json({ ok: 1 })) }]);
    const gh = new GitHub("t");
    await expect(gh.cachedGet("/x")).rejects.toBeInstanceOf(GitHubError);
    expect(await gh.cachedGet("/x")).toEqual({ ok: 1 });
  });
  it("graphql posts the query and returns data", async () => {
    const { calls } = mockFetch([{ method: "POST", url: "https://api.github.com/graphql", respond: () => json({ data: { viewer: { login: "dav" } } }) }]);
    expect(await new GitHub("t").graphql("query { viewer { login } }", {})).toEqual({ viewer: { login: "dav" } });
    expect(await calls[0]!.json()).toEqual({ query: "query { viewer { login } }", variables: {} });
  });
  it.each([["RATE_LIMITED", "rate_limited"], ["NOT_FOUND", "not_found"], ["FORBIDDEN", "forbidden"], ["INSUFFICIENT_SCOPES", "other"], ["SOMETHING", "other"]])(
    "graphql error %s → %s", async (type, kind) => {
      mockFetch([{ method: "POST", url: "https://api.github.com/graphql", respond: () => json({ errors: [{ type, message: "m" }] }) }]);
      const err = await new GitHub("t").graphql("q", {}).catch((e) => e);
      expect((err as GitHubError).kind).toBe(kind);
    });
});
