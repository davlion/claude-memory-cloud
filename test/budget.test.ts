import { expect, it } from "vitest";
import { GitHub } from "../src/github";
import { GitHubStore } from "../src/store";
import { callTool, type ToolDeps } from "../src/tools";
import { json, mockFetch } from "./setup";

const API = "https://api.github.com";
const oid = (n: number) => n.toString(16).padStart(40, "0");
const MEMORY = "---\nname: m\ndescription: a memory\nmetadata:\n  type: user\n---\n\nbody\n";
const memories = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}memories/m${i}.md`);

function repoRoutes(repo: string, commit: string, paths: string[]) {
  return [
    { method: "GET", url: `${API}/repos/${repo}`, respond: () => json({ default_branch: "main", private: true, visibility: "private" }) },
    { method: "GET", url: `${API}/repos/${repo}/git/ref/heads/main`, respond: () => json({ object: { sha: commit } }) },
    { method: "GET", url: `${API}/repos/${repo}/git/commits/${commit}`, respond: () => json({
      sha: commit, message: "save: m\n\nMemory-Source: test\nMemory-Scope: general\n", author: { name: "dav", date: "2026-10-14T00:00:00Z" },
      html_url: `https://github.com/${repo}/commit/${commit}`, tree: { sha: `t-${commit}` } }) },
    { method: "GET", url: `${API}/repos/${repo}/git/trees/t-${commit}?recursive=1`, respond: () =>
      json({ truncated: false, tree: paths.map((path, i) => ({ path, type: "blob", sha: oid(i + 1) })) }) },
  ];
}

// Cloudflare Free allows 50 subrequests per request; spec §10b sets this budget for memory_index over 3 scopes.
it("memory_index for general + client + project stays within 20 GitHub calls on a cold cache", async () => {
  const { calls } = mockFetch([
    { url: `${API}/user/installations?`, respond: () => json({ installations: [
      { id: 1, account: { login: "dav" }, repository_selection: "selected" },
      { id: 2, account: { login: "acme-org" }, repository_selection: "selected" }] }) },
    { url: `${API}/user/installations/1/repositories`, respond: () => json({ repositories: [
      { full_name: "dav/mem", private: true, visibility: "private", permissions: { push: true } }] }) },
    { url: `${API}/user/installations/2/repositories`, respond: () => json({ repositories: [
      { full_name: "acme-org/claude-memory", private: true, visibility: "private", permissions: { push: true } }] }) },
    { method: "GET", url: `${API}/user`, respond: () => json({ login: "dav" }) },
    ...repoRoutes("dav/mem", "c1", ["MEMORY.md", ...memories("", 30)]),
    ...repoRoutes("acme-org/claude-memory", "c2", ["MEMORY.md", ...memories("", 30), "projects/billing/MEMORY.md", ...memories("projects/billing/", 30)]),
    { method: "POST", url: `${API}/graphql`, respond: async (req: Request) => {
      const { query } = (await req.json()) as { query: string };
      const repository: Record<string, { text: string }> = {};
      for (const m of query.matchAll(/(b\d+): object/g)) repository[m[1]!] = { text: MEMORY };
      return json({ data: { repository } });
    } },
  ]);
  const gh = new GitHub("t");
  const deps: ToolDeps = { store: new GitHubStore(gh), gh, cfg: { general: "dav/mem", acme: "acme-org/claude-memory" },
    props: { login: "dav", githubToken: "t", githubRefreshToken: "r", githubTokenExpiresAt: Date.now() + 8 * 3600_000 }, appSlug: "s" };
  const r = await callTool(deps, "memory_index", { project: "acme-org/billing" });
  expect(r.text).toContain("# Memory index — general");
  expect(r.text).toContain("# Memory index — acme");
  expect(r.text).toContain("# Memory index — project billing");
  expect(calls.every((c) => c.url.startsWith(`${API}/`))).toBe(true);
  expect(calls.length).toBeLessThanOrEqual(20);
  expect(calls.filter((c) => c.url === `${API}/graphql`)).toHaveLength(3);
});
