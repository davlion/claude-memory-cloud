import { beforeEach, describe, expect, it } from "vitest";
import { GitHub } from "../src/github";
import { callTool, createServer, type ToolDeps } from "../src/tools";
import { saveMemory } from "../src/operations";
import { resolveTarget } from "../src/scopes";
import { INSTRUCTIONS } from "../src/instructions";
import { FakeStore } from "./fake-store";
import { json, mockFetch } from "./setup";

const cfg = { general: "dav/mem", acme: "acme-org/claude-memory" };
const props = { login: "dav", githubToken: "t", githubRefreshToken: "r", githubTokenExpiresAt: Date.now() + 8 * 3600_000 };
let deps: ToolDeps;
let store: FakeStore;

function healthyGitHub() {
  mockFetch([
    { url: "https://api.github.com/user/installations?", respond: () => json({ installations: [
      { id: 1, account: { login: "dav" } }, { id: 2, account: { login: "acme-org" } }] }) },
    { url: "https://api.github.com/user/installations/1/repositories", respond: () => json({ repositories: [{ full_name: "dav/mem", private: true, permissions: { push: true } }] }) },
    { url: "https://api.github.com/user/installations/2/repositories", respond: () => json({ repositories: [{ full_name: "acme-org/claude-memory", private: true, permissions: { push: true } }] }) },
    { url: "https://api.github.com/user", respond: () => json({ login: "dav" }) },
  ]);
}

beforeEach(() => {
  store = new FakeStore();
  store.put("dav/mem", "README.md", "r");
  store.put("acme-org/claude-memory", "README.md", "r");
  deps = { store, gh: new GitHub("t"), cfg, props, appSlug: "dav-claude-memory", now: () => new Date("2026-10-13T18:04:05Z") };
});

const save = (args: Record<string, unknown>) =>
  callTool(deps, "memory_save", { description: "Measure first", type: "feedback", body: "Measure.\n", source: "test", ...args });

describe("callTool", () => {
  it("memory_save defaults scope to general and returns JSON", async () => {
    const r = await save({ name: "a" });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toMatchObject({ status: "created", scope: "general" });
  });

  it("memory_save project scope", async () => {
    const r = await save({ name: "b", scope: "project", project: "git@github.com:acme-org/billing.git" });
    expect(JSON.parse(r.text)).toMatchObject({ status: "created", scope: "project billing" });
    expect(store.repo("acme-org/claude-memory").has("projects/billing/memories/b.md")).toBe(true);
  });

  it("memory_index includes health first, then each reachable scope, then the project", async () => {
    await save({ name: "a" });
    healthyGitHub();
    const r = await callTool(deps, "memory_index", { project: "acme-org/billing" });
    const t = r.text;
    expect(t.indexOf("## Health")).toBe(0);
    expect(t).toContain("# Memory index — general");
    expect(t).toContain("[a]");
    expect(t).toContain("# Memory index — project billing\n\n(no memories yet)");
  });

  it("memory_index skips unreachable scopes but reports them in health", async () => {
    mockFetch([
      { url: "https://api.github.com/user/installations?", respond: () => json({ installations: [{ id: 1, account: { login: "dav" } }] }) },
      { url: "https://api.github.com/user/installations/1/repositories", respond: () => json({ repositories: [{ full_name: "dav/mem", private: true, permissions: { push: true } }] }) },
      { url: "https://api.github.com/user", respond: () => json({ login: "dav" }) },
    ]);
    const r = await callTool(deps, "memory_index", {});
    expect(r.text).toContain("✗ scope:acme — app_not_installed");
    expect(r.text).not.toContain("# Memory index — acme");
  });

  it("memory_read / memory_search / memory_delete round trip", async () => {
    await save({ name: "a", body: "Deploy on Tuesday.\n" });
    const read = JSON.parse((await callTool(deps, "memory_read", { scope: "general", names: ["a"] })).text);
    expect(read[0].version).toMatch(/^[0-9a-f]{40}$/);
    healthyGitHub(); // memory_search checks scope reachability
    const found = JSON.parse((await callTool(deps, "memory_search", { query: "tuesday" })).text);
    expect(found.map((x: { name: string }) => x.name)).toEqual(["a"]);
    const del = JSON.parse((await callTool(deps, "memory_delete", { scope: "general", name: "a", version: read[0].version, source: "test" })).text);
    expect(del.status).toBe("deleted");
  });

  it("memory_scopes", async () => {
    healthyGitHub();
    const r = JSON.parse((await callTool(deps, "memory_scopes", {})).text);
    expect(r).toEqual([
      { scope: "general", repo: "dav/mem", reachable: true, writable: true, private: true },
      { scope: "acme", repo: "acme-org/claude-memory", reachable: true, writable: true, private: true },
    ]);
  });

  it("OpErrors become isError results with code and action", async () => {
    const r = await save({ name: "a", scope: "project", project: "someone/x" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text)).toMatchObject({ error: "no_memory_repo_for_owner", action: expect.any(String) });
  });

  it("reauth_required surfaces as retryable error", async () => {
    store.snapshot = async () => { const { GitHubError } = await import("../src/github"); throw new GitHubError("Bad credentials", 401, "unauthorized"); };
    const r = await save({ name: "a" });
    expect(JSON.parse(r.text)).toMatchObject({ error: "reauth_required", retryable: true });
  });

  it("repo_public surfaces as a non-retryable error with the action", async () => {
    store.publicRepos.add("dav/mem");
    const r = await save({ name: "a" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text)).toMatchObject({ error: "repo_public", retryable: false, action: expect.stringMatching(/Change visibility/) });
  });

  it("unknown tool", async () => {
    expect((await callTool(deps, "nope", {})).isError).toBe(true);
  });
});

const sinceOf = (indexText: string) =>
  JSON.parse(/## Since\n[^\n]*\n```json\n([\s\S]*?)\n```/.exec(indexText)![1]!) as Record<string, string>;

describe("since map", () => {
  it("memory_index ends with a since map covering every returned index", async () => {
    healthyGitHub();
    const since = sinceOf((await callTool(deps, "memory_index", { project: "acme-org/billing" })).text);
    expect(Object.keys(since).sort()).toEqual(["acme", "general", "project:acme-org/billing"]);
    expect(since["project:acme-org/billing"]).toBe("none");
  });

  it("reports scopes changed elsewhere, with a new map; silent when nothing changed", async () => {
    healthyGitHub();
    const since = sinceOf((await callTool(deps, "memory_index", {})).text);
    const quiet = await callTool(deps, "memory_read", { scope: "general", names: ["x"], since });
    expect(quiet.notes).toBeUndefined();

    // another surface saves to general
    await saveMemory(store, resolveTarget(cfg, "general"), { name: "from-elsewhere", description: "deploys freeze on fridays", type: "project", body: "b\n", source: "other" });

    const r = await callTool(deps, "memory_read", { scope: "general", names: ["x"], since });
    expect(JSON.parse(r.text)).toEqual([{ name: "x", error: "not_found" }]); // text stays plain JSON
    expect(r.notes).toContain("Memory changed since your index");
    expect(r.notes).toContain("[from-elsewhere]");
    expect(r.notes).not.toContain("Memory index — acme");
    const next = sinceOf(r.notes!);
    expect(next.general).not.toBe(since.general);
    expect(next.acme).toBe(since.acme);
    expect((await callTool(deps, "memory_read", { scope: "general", names: ["x"], since: next })).notes).toBeUndefined();
  });

  it("ignores unknown or unresolvable keys", async () => {
    const r = await callTool(deps, "memory_read", { scope: "general", names: ["x"], since: { nope: "abc", "project:someone/x": "none" } });
    expect(r.isError).toBe(false);
    expect(r.notes).toBeUndefined();
  });

  it("a failing check never fails the tool call", async () => {
    const real = store.snapshot.bind(store);
    let calls = 0;
    store.snapshot = async (repo, prefix) => { if (++calls > 1) throw new Error("boom"); return real(repo, prefix); };
    const r = await callTool(deps, "memory_read", { scope: "general", names: ["x"], since: { general: "stale" } });
    expect(r.isError).toBe(false);
    expect(JSON.parse(r.text)).toEqual([{ name: "x", error: "not_found" }]);
    expect(r.notes).toBeUndefined();
  });
});

describe("createServer", () => {
  it("constructs with instructions", () => {
    expect(() => createServer(deps)).not.toThrow();
    expect(INSTRUCTIONS).toContain("memory_index");
    expect(INSTRUCTIONS).toContain("source");
    expect(INSTRUCTIONS).toContain("since");
    expect(INSTRUCTIONS).toContain("summarized");
  });
});

describe("error taxonomy at the tool boundary", () => {
  it("write_rejected is final (not retryable) and names the fix", async () => {
    const { GitHubError } = await import("../src/github");
    store.commit = async () => { throw new GitHubError("Protected branch update failed", 422, "unprocessable"); };
    const r = await save({ name: "a" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.text)).toMatchObject({ error: "write_rejected", retryable: false, action: expect.stringMatching(/ruleset/) });
  });
  it("unexpected errors are internal, final, and don't echo details", async () => {
    store.snapshot = async () => { throw new TypeError("detail ghu_abc"); };
    const r = await save({ name: "a" });
    expect(JSON.parse(r.text)).toMatchObject({ error: "internal", retryable: false });
    expect(r.text).not.toContain("ghu_abc");
  });
  it("server_limit is retryable", async () => {
    const { GitHubError } = await import("../src/github");
    store.snapshot = async () => { throw new GitHubError("server limit", 0, "server_limit"); };
    expect(JSON.parse((await save({ name: "a" })).text)).toMatchObject({ error: "server_limit", retryable: true });
  });
});
