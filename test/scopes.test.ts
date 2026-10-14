import { describe, expect, it } from "vitest";
import { OpError } from "../src/errors";
import { parseScopes, resolveTarget } from "../src/scopes";

const cfg = parseScopes(JSON.stringify({ general: "dav/claude-memory", acme: "Acme-Org/claude-memory" }));

describe("parseScopes", () => {
  it("parses", () => expect(cfg).toEqual({ general: "dav/claude-memory", acme: "Acme-Org/claude-memory" }));
  it.each([
    "not json",
    "[]",
    JSON.stringify({ general: "no-slash" }),
    JSON.stringify({ project: "a/b" }),
  ])("rejects %s", (j) => expect(() => parseScopes(j)).toThrow());
  it("does not require a general scope", () => expect(parseScopes(JSON.stringify({ acme: "a/b" }))).toEqual({ acme: "a/b" }));
});

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
