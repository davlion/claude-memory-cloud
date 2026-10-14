import { describe, expect, it } from "vitest";
import { GitHub, GitHubError, toOpError } from "../src/github";
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
