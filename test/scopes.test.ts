import { describe, expect, it } from "vitest";
import { OpError } from "../src/errors";
// @ts-expect-error plain .mjs without types
import { scopesError } from "../scripts/scopes-rules.mjs";
import { contextScopes, parseScopeMap, resolveTarget, scopesFor } from "../src/scopes";

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

describe("contextScopes (per-context loading)", () => {
  const c = { general: "dav/claude-memory", acme: "Acme-Org/claude-memory", beta: "beta-inc/claude-memory" };
  it("no project → general only", () => expect(contextScopes(c)).toEqual({ names: ["general"], unknown: [] }));
  it("project → general + the client that owns it", () =>
    expect(contextScopes(c, "git@github.com:acme-org/billing.git")).toEqual({ names: ["general", "acme"], unknown: [] }));
  it("own project → general only", () => expect(contextScopes(c, "dav/app").names).toEqual(["general"]));
  it("extra names widen, unknown names are reported, 'project' is ignored", () =>
    expect(contextScopes(c, undefined, ["beta", "nope", "project", "general"])).toEqual({ names: ["general", "beta"], unknown: ["nope"] }));
  it("non-GitHub project → general only", () => expect(contextScopes(c, "git@gitlab.com:a/b.git").names).toEqual(["general"]));
  it("no general scope configured", () => expect(contextScopes({ acme: "acme-org/claude-memory" }, "acme-org/x").names).toEqual(["acme"]));
});

describe("scope-map hardening", () => {
  it("rejects two logins that differ only in case", () =>
    expect(() => parseScopeMap(JSON.stringify({ Dav: { general: "a/b" }, dav: { general: "a/b" } }))).toThrow(/duplicate login/));
  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])("%s is an unknown scope", (name) =>
    expect(() => resolveTarget(cfg, name)).toThrow(expect.objectContaining({ code: "unknown_scope" })));
});

describe("scripts/scopes-rules.mjs mirrors parseScopeMap", () => {
  const cases = [
    '{"dav":{"general":"dav/claude-memory"}}', '{"dav":{"general":"dav/claude-memory"},"DAV":{}}', "[]", "nope", '{"-bad":{}}',
    '{"dav":[]}', '{"dav":null}', '{"dav":{"project":"a/b"}}', '{"dav":{"general":"a"}}', '{"dav":{"general":5}}', "{}",
  ];
  it.each(cases)("agrees on %s", (json) => {
    let parseError: string | null = null;
    try { parseScopeMap(json); } catch (e) { parseError = (e as Error).message; }
    expect(scopesError(json) === null).toBe(parseError === null);
    if (parseError) expect(scopesError(json)).toBe(parseError);
  });
});
