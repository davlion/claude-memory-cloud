import { describe, expect, it } from "vitest";
import { OpError } from "../src/errors";
import { parseScopeMap, resolveTarget, scopesFor } from "../src/scopes";

const cfg = { general: "dav/claude-memory", acme: "Acme-Org/claude-memory" };

describe("resolveTarget", () => {
  it("named scope", () =>
    expect(resolveTarget(cfg, "acme")).toEqual({ scopeLabel: "acme", displayLabel: "acme", repo: "Acme-Org/claude-memory", prefix: "" }));

  it("project via remote, owner matched case-insensitively", () =>
    expect(resolveTarget(cfg, "project", "git@github.com:acme-org/Billing.git")).toEqual({
      scopeLabel: "project:acme-org/billing",
      displayLabel: "project billing",
      repo: "Acme-Org/claude-memory",
      prefix: "projects/billing/",
    }));

  const code = (fn: () => unknown) => {
    try { fn(); } catch (e) { return (e as OpError).code; }
    return "no-throw";
  };
  it("unknown scope", () => expect(code(() => resolveTarget(cfg, "nope"))).toBe("unknown_scope"));
  it("project without remote", () => expect(code(() => resolveTarget(cfg, "project"))).toBe("invalid"));
  it("non-GitHub remote", () => expect(code(() => resolveTarget(cfg, "project", "git@gitlab.com:a/b.git"))).toBe("unsupported_remote"));
  it("owner without memory repo", () => expect(code(() => resolveTarget(cfg, "project", "someone/x"))).toBe("no_memory_repo_for_owner"));
});

describe("parseScopeMap (per-user SCOPES)", () => {
  const map = parseScopeMap(JSON.stringify({ DavLion: { general: "davlion/claude-memory", acme: "acme-org/claude-memory" }, carol: { general: "carol/claude-memory" } }));
  it("lower-cases logins and validates each user's scopes", () =>
    expect(map).toEqual({ davlion: { general: "davlion/claude-memory", acme: "acme-org/claude-memory" }, carol: { general: "carol/claude-memory" } }));
  it("does not require a general scope", () => expect(parseScopeMap(JSON.stringify({ dav: { acme: "a/b" } }))).toEqual({ dav: { acme: "a/b" } }));
  it("scopesFor matches logins case-insensitively; unknown → undefined", () => {
    expect(scopesFor(map, "DAVLION")).toEqual(map.davlion);
    expect(scopesFor(map, "mallory")).toBeUndefined();
    expect(scopesFor(map, "__proto__")).toBeUndefined();
  });
  it.each([
    ["not json", /not valid JSON/],
    ["[]", /JSON object/],
    [JSON.stringify({ general: "a/b" }), /scopes for general/],
    [JSON.stringify({ "bad login!": { general: "a/b" } }), /invalid GitHub login/],
    [JSON.stringify({ dav: { general: "no-slash" } }), /invalid repo/],
    [JSON.stringify({ dav: { project: "a/b" } }), /reserved/],
  ])("rejects %s", (j, msg) => expect(() => parseScopeMap(j)).toThrow(msg));
});
