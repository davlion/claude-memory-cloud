import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GitHub } from "../src/github";
import { GitHubStore } from "../src/store";
import { json, mockFetch } from "./setup";

const R = "https://api.github.com/repos/dav/mem";
const b64 = (s: string) => btoa(unescape(encodeURIComponent(s)));

function repoRoutes(extra: Parameters<typeof mockFetch>[0] = []) {
  return [
    { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ object: { sha: "c1" } }) },
    { method: "GET", url: R, respond: () => json({ default_branch: "main", private: true }) },
    { method: "GET", url: `${R}/git/commits/c1`, respond: () => json({ tree: { sha: "t1" } }) },
    { method: "GET", url: `${R}/git/trees/t1?recursive=1`, respond: () => json({ truncated: false, tree: [
      { path: "MEMORY.md", type: "blob", sha: "s0" },
      { path: "memories/a.md", type: "blob", sha: "s1" },
      { path: "projects/billing/memories/p.md", type: "blob", sha: "s2" },
      { path: "README.md", type: "blob", sha: "s3" },
    ] }) },
    { method: "GET", url: `${R}/git/blobs/s0`, respond: () => json({ content: b64("# idx\n"), encoding: "base64" }) },
    { method: "GET", url: `${R}/git/blobs/s1`, respond: () => json({ content: b64("A — é\n"), encoding: "base64" }) },
    { method: "GET", url: `${R}/git/blobs/s2`, respond: () => json({ content: b64("P\n"), encoding: "base64" }) },
    ...extra,
  ];
}

describe("GitHubStore.snapshot", () => {
  it("root prefix: MEMORY.md + memories/*, excludes projects/ and other files, decodes UTF-8", async () => {
    mockFetch(repoRoutes());
    const snap = await new GitHubStore(new GitHub("t"), env.CACHE_KV).snapshot("dav/mem", "");
    expect(snap.commitSha).toBe("c1");
    expect([...snap.files.keys()].sort()).toEqual(["MEMORY.md", "memories/a.md"]);
    expect(snap.files.get("memories/a.md")).toEqual({ path: "memories/a.md", sha: "s1", content: "A — é\n" });
    expect(snap.isPrivate).toBe(true);
  });

  it("isPrivate is false for a public repo, and when the flag is missing", async () => {
    for (const meta of [{ default_branch: "main", private: false }, { default_branch: "main" }]) {
      mockFetch([...repoRoutes().filter((r) => r.url !== R), { method: "GET", url: R, respond: () => json(meta) }]);
      expect((await new GitHubStore(new GitHub("t"), env.CACHE_KV).snapshot("dav/mem", "")).isPrivate).toBe(false);
    }
  });

  it("project prefix: paths relative to the prefix", async () => {
    mockFetch(repoRoutes());
    const snap = await new GitHubStore(new GitHub("t"), env.CACHE_KV).snapshot("dav/mem", "projects/billing/");
    expect([...snap.files.keys()]).toEqual(["memories/p.md"]);
  });

  it("uses the blob cache on a second snapshot", async () => {
    mockFetch(repoRoutes());
    const store = new GitHubStore(new GitHub("t"), env.CACHE_KV);
    await store.snapshot("dav/mem", "");
    const { calls } = mockFetch(repoRoutes());
    await store.snapshot("dav/mem", "");
    expect(calls.some((c) => c.url.includes("/git/blobs/"))).toBe(false);
  });

  it("empty repo → commitSha null, no files", async () => {
    mockFetch([
      { method: "GET", url: R, respond: () => json({ default_branch: "main", private: true }) },
      { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ message: "Git Repository is empty." }, 409) },
    ]);
    const snap = await new GitHubStore(new GitHub("t")).snapshot("dav/mem", "");
    expect(snap).toEqual({ commitSha: null, isPrivate: true, files: new Map() });
  });
});

describe("GitHubStore.commit", () => {
  it("creates tree (with deletes), commit, and fast-forwards the ref", async () => {
    const { calls } = mockFetch([
      { method: "GET", url: R, respond: () => json({ default_branch: "main", private: true }) },
      { method: "GET", url: `${R}/git/commits/c1`, respond: () => json({ tree: { sha: "t1" } }) },
      { method: "POST", url: `${R}/git/trees`, respond: () => json({ sha: "t2" }) },
      { method: "POST", url: `${R}/git/commits`, respond: () => json({ sha: "c2", html_url: "https://github.com/dav/mem/commit/c2" }) },
      { method: "PATCH", url: `${R}/git/refs/heads/main`, respond: () => json({ object: { sha: "c2" } }) },
    ]);
    const res = await new GitHubStore(new GitHub("t")).commit("dav/mem", "projects/billing/", "c1",
      [{ path: "memories/x.md", content: "X" }, { path: "memories/y.md", content: null }], "save: x");
    expect(res).toEqual({ ok: true, commitSha: "c2", url: "https://github.com/dav/mem/commit/c2" });
    const tree = await calls.find((c) => c.url.endsWith("/git/trees") && c.method === "POST")!.json();
    expect(tree).toEqual({ base_tree: "t1", tree: [
      { path: "projects/billing/memories/x.md", mode: "100644", type: "blob", content: "X" },
      { path: "projects/billing/memories/y.md", mode: "100644", type: "blob", sha: null },
    ] });
    const patch = await calls.find((c) => c.method === "PATCH")!.json();
    expect(patch).toEqual({ sha: "c2", force: false });
  });

  it("non-fast-forward → ref_moved", async () => {
    mockFetch([
      { method: "GET", url: R, respond: () => json({ default_branch: "main", private: true }) },
      { method: "GET", url: `${R}/git/commits/c1`, respond: () => json({ tree: { sha: "t1" } }) },
      { method: "POST", url: `${R}/git/trees`, respond: () => json({ sha: "t2" }) },
      { method: "POST", url: `${R}/git/commits`, respond: () => json({ sha: "c2", html_url: "u" }) },
      { method: "PATCH", url: `${R}/git/refs/heads/main`, respond: () => json({ message: "Update is not a fast forward" }, 422) },
    ]);
    expect(await new GitHubStore(new GitHub("t")).commit("dav/mem", "", "c1", [{ path: "MEMORY.md", content: "i" }], "m"))
      .toEqual({ ok: false, reason: "ref_moved" });
  });

  it("empty repo (base null) → initializes README via contents API, then reports ref_moved so the caller retries", async () => {
    const { calls } = mockFetch([
      { method: "GET", url: R, respond: () => json({ default_branch: "main", private: true }) },
      { method: "PUT", url: `${R}/contents/README.md`, respond: () => json({ commit: { sha: "c1" } }, 201) },
    ]);
    expect(await new GitHubStore(new GitHub("t")).commit("dav/mem", "", null, [{ path: "MEMORY.md", content: "i" }], "m"))
      .toEqual({ ok: false, reason: "ref_moved" });
    const put = await calls.find((c) => c.method === "PUT")!.json() as { message: string; content: string };
    expect(put.message).toBe("init: claude-memory");
    expect(atob(put.content)).toMatch(/^# claude-memory/);
  });
});
