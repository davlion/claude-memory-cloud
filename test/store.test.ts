import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GitHub, GitHubError, toOpError } from "../src/github";
import { CACHE_TTL_SECONDS, GitHubStore, mapLimit } from "../src/store";
import { json, mockFetch } from "./setup";

const R = "https://api.github.com/repos/dav/mem";
const GQL = "https://api.github.com/graphql";
const oid = (n: number) => n.toString(16).padStart(40, "0");
const [S0, S1, S2, S3, S4, S5, S6, S7] = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => oid(0x100 + n)) as [string, string, string, string, string, string, string, string];
const TEXTS: Record<string, string> = { [S1]: "A — é\n", [S2]: "P\n", [S4]: "C\n" };
const META = { default_branch: "main", private: true, visibility: "private" };
type Entry = { path: string; type: string; sha: string };
const TREE: Entry[] = [
  { path: "MEMORY.md", type: "blob", sha: S0 },
  { path: "memories/a.md", type: "blob", sha: S1 },
  { path: "memories/a.conflict-20261013T180405Z.md", type: "blob", sha: S4 },
  { path: "memories/.gitkeep", type: "blob", sha: S5 },
  { path: "memories/notes.txt", type: "blob", sha: S6 },
  { path: "memories/sub/x.md", type: "blob", sha: S7 },
  { path: "projects/billing/memories/p.md", type: "blob", sha: S2 },
  { path: "README.md", type: "blob", sha: S3 },
];

function graphqlRoute(texts: Record<string, string> = TEXTS) {
  return { method: "POST", url: GQL, respond: async (req: Request) => {
    const { query } = (await req.json()) as { query: string };
    const repository: Record<string, { text: string } | null> = {};
    for (const m of query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)) {
      const t = texts[m[2]!];
      repository[m[1]!] = t === undefined ? null : { text: t };
    }
    return json({ data: { repository } });
  } };
}

function repoRoutes(commit = "c1", tree: Entry[] = TREE, texts: Record<string, string> = TEXTS) {
  return [
    { method: "GET", url: R, respond: () => json(META) },
    { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ object: { sha: commit } }) },
    { method: "GET", url: `${R}/git/commits/${commit}`, respond: () => json({
      sha: commit, message: "save: a\n\nMemory-Source: test\nMemory-Scope: general\n",
      author: { name: "Dav", date: "2026-10-14T10:00:00Z" }, html_url: `https://github.com/dav/mem/commit/${commit}`, tree: { sha: `t-${commit}` } }) },
    { method: "GET", url: `${R}/git/trees/t-${commit}?recursive=1`, respond: () => json({ truncated: false, tree }) },
    graphqlRoute(texts),
  ];
}

const count = (calls: Request[], part: string) => calls.filter((c) => c.url.includes(part)).length;

describe("GitHubStore.snapshot", () => {
  it("root prefix: memory files only (via one GraphQL query), MEMORY.md as indexSha, head commit, UTF-8", async () => {
    const { calls } = mockFetch(repoRoutes());
    const snap = await new GitHubStore(new GitHub("t")).snapshot("dav/mem", "");
    expect(snap.commitSha).toBe("c1");
    expect(snap.indexSha).toBe(S0);
    expect([...snap.files.keys()].sort()).toEqual(["memories/a.conflict-20261013T180405Z.md", "memories/a.md"]);
    expect(snap.files.get("memories/a.md")).toEqual({ path: "memories/a.md", sha: S1, content: "A — é\n" });
    expect(snap.head).toEqual({ sha: "c1", message: expect.stringContaining("Memory-Source: test"), author: "Dav",
      date: "2026-10-14T10:00:00Z", url: "https://github.com/dav/mem/commit/c1" });
    expect(snap.isPrivate).toBe(true);
    const gql = calls.filter((c) => c.url === GQL);
    expect(gql).toHaveLength(1);
    const { query } = (await gql[0]!.json()) as { query: string };
    expect(query).toContain(S1);
    expect(query).toContain(S4);
    for (const s of [S0, S2, S3, S5, S6, S7]) expect(query).not.toContain(s);
    expect(count(calls, "/git/blobs/")).toBe(0);
  });

  it("project prefix: paths relative to the prefix; no MEMORY.md → indexSha null", async () => {
    mockFetch(repoRoutes());
    const snap = await new GitHubStore(new GitHub("t")).snapshot("dav/mem", "projects/billing/");
    expect([...snap.files.keys()]).toEqual(["memories/p.md"]);
    expect(snap.indexSha).toBeNull();
  });

  it("isPrivate is false for a public repo, and when visibility is missing", async () => {
    for (const meta of [{ default_branch: "main", private: false, visibility: "public" }, { default_branch: "main" }]) {
      mockFetch([...repoRoutes().filter((r) => r.url !== R), { method: "GET", url: R, respond: () => json(meta) }]);
      expect((await new GitHubStore(new GitHub("t")).snapshot("dav/mem", "")).isPrivate).toBe(false);
    }
  });

  it("chunks memory texts into GraphQL queries of at most 100 blobs", async () => {
    const tree = Array.from({ length: 150 }, (_, i) => ({ path: `memories/m${i}.md`, type: "blob", sha: oid(0x1000 + i) }));
    const texts = Object.fromEntries(tree.map((t) => [t.sha, "x\n"]));
    const { calls } = mockFetch(repoRoutes("c1", tree, texts));
    const snap = await new GitHubStore(new GitHub("t")).snapshot("dav/mem", "");
    expect(snap.files.size).toBe(150);
    expect(calls.filter((c) => c.url === GQL)).toHaveLength(2);
  });

  it("no memory files → no GraphQL call", async () => {
    const { calls } = mockFetch(repoRoutes("c1", [{ path: "README.md", type: "blob", sha: S3 }]));
    const snap = await new GitHubStore(new GitHub("t")).snapshot("dav/mem", "");
    expect(snap.files.size).toBe(0);
    expect(calls.filter((c) => c.url === GQL)).toHaveLength(0);
  });

  it("a blob GraphQL can't return as text reads as empty", async () => {
    mockFetch(repoRoutes("c1", TREE, { [S4]: "C\n" }));
    expect((await new GitHubStore(new GitHub("t")).snapshot("dav/mem", "")).files.get("memories/a.md")!.content).toBe("");
  });

  it("memoizes the ref and the tree within one store", async () => {
    const { calls } = mockFetch(repoRoutes());
    const store = new GitHubStore(new GitHub("t"));
    await store.snapshot("dav/mem", "");
    await store.snapshot("dav/mem", "projects/billing/");
    expect(count(calls, "/git/ref/heads/")).toBe(1);
    expect(count(calls, "/git/trees/")).toBe(1);
    expect(count(calls, "/git/commits/")).toBe(1);
    expect(calls.filter((c) => c.url === R)).toHaveLength(1);
  });

  it("uses the KV snapshot cache across stores, keyed by commit", async () => {
    const commit = `c-cache-${Date.now()}`;
    mockFetch(repoRoutes(commit));
    const first = await new GitHubStore(new GitHub("t"), env.CACHE_KV).snapshot("dav/mem", "");
    const { calls } = mockFetch(repoRoutes(commit));
    const second = await new GitHubStore(new GitHub("t"), env.CACHE_KV).snapshot("dav/mem", "");
    expect(second).toEqual(first);
    expect(count(calls, "/git/commits/") + count(calls, "/git/trees/") + calls.filter((c) => c.url === GQL).length).toBe(0);
  });

  it("cache failures never break a read, and a failed write is reported", async () => {
    mockFetch(repoRoutes());
    const broken = { get: async () => { throw new Error("KV down"); }, put: async () => { throw new Error("KV PUT failed: 429 Too Many Requests"); } } as unknown as KVNamespace;
    const store = new GitHubStore(new GitHub("t"), broken);
    expect((await store.snapshot("dav/mem", "")).files.size).toBe(2);
    expect(store.cacheWriteFailed).toBe(true);
  });

  it("writes the cache with a 7-day TTL", async () => {
    mockFetch(repoRoutes());
    const puts: { key: string; opts: unknown }[] = [];
    const kv = { get: async () => null, put: async (key: string, _v: string, opts: unknown) => { puts.push({ key, opts }); } } as unknown as KVNamespace;
    await new GitHubStore(new GitHub("t"), kv).snapshot("dav/mem", "");
    expect(CACHE_TTL_SECONDS).toBe(604800);
    expect(puts).toEqual([{ key: "snap:v1:dav/mem:c1:", opts: { expirationTtl: 604800 } }]);
  });

  it("skips the cache for an oversized snapshot without flagging a write failure", async () => {
    mockFetch(repoRoutes());
    let puts = 0;
    const kv = { get: async () => null, put: async () => { puts++; } } as unknown as KVNamespace;
    const store = new GitHubStore(new GitHub("t"), kv);
    store.maxCacheBytes = 10;
    expect((await store.snapshot("dav/mem", "")).files.size).toBe(2);
    expect(puts).toBe(0);
    expect(store.cacheWriteFailed).toBe(false);
  });

  it("truncated tree → error", async () => {
    mockFetch([...repoRoutes().filter((r) => !r.url.includes("/git/trees/")),
      { method: "GET", url: `${R}/git/trees/t-c1?recursive=1`, respond: () => json({ truncated: true, tree: [] }) }]);
    await expect(new GitHubStore(new GitHub("t")).snapshot("dav/mem", "")).rejects.toBeInstanceOf(GitHubError);
  });

  it("empty repo → commitSha null, no files, no head", async () => {
    mockFetch([
      { method: "GET", url: R, respond: () => json(META) },
      { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ message: "Git Repository is empty." }, 409) },
    ]);
    expect(await new GitHubStore(new GitHub("t")).snapshot("dav/mem", ""))
      .toEqual({ commitSha: null, isPrivate: true, indexSha: null, files: new Map(), head: null });
  });
});

describe("mapLimit", () => {
  it("keeps order and caps concurrency", async () => {
    let active = 0;
    let peak = 0;
    const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
      active++; peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 1));
      active--;
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
    expect(peak).toBe(2);
  });
});

describe("GitHubStore.commit", () => {
  const writeRoutes = (patch: () => Response, refAfter = "c9") => [
    { method: "GET", url: R, respond: () => json(META) },
    { method: "GET", url: `${R}/git/commits/c1`, respond: () => json({ tree: { sha: "t1" } }) },
    { method: "POST", url: `${R}/git/trees`, respond: () => json({ sha: "t2" }) },
    { method: "POST", url: `${R}/git/commits`, respond: () => json({ sha: "c2", html_url: "https://github.com/dav/mem/commit/c2" }) },
    { method: "PATCH", url: `${R}/git/refs/heads/main`, respond: patch },
    { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ object: { sha: refAfter } }) },
  ];

  it("creates tree (with deletes), commit, and fast-forwards the ref", async () => {
    const { calls } = mockFetch(writeRoutes(() => json({ object: { sha: "c2" } })));
    const res = await new GitHubStore(new GitHub("t")).commit("dav/mem", "projects/billing/", "c1",
      [{ path: "memories/x.md", content: "X" }, { path: "memories/y.md", content: null }], "save: x");
    expect(res).toEqual({ ok: true, commitSha: "c2", url: "https://github.com/dav/mem/commit/c2" });
    const tree = await calls.find((c) => c.url.endsWith("/git/trees") && c.method === "POST")!.json();
    expect(tree).toEqual({ base_tree: "t1", tree: [
      { path: "projects/billing/memories/x.md", mode: "100644", type: "blob", content: "X" },
      { path: "projects/billing/memories/y.md", mode: "100644", type: "blob", sha: null },
    ] });
    expect(await calls.find((c) => c.method === "PATCH")!.json()).toEqual({ sha: "c2", force: false });
  });

  it("422 from the ref update with the ref moved → ref_moved (a real race)", async () => {
    mockFetch(writeRoutes(() => json({ message: "Update is not a fast forward" }, 422), "c9"));
    expect(await new GitHubStore(new GitHub("t")).commit("dav/mem", "", "c1", [{ path: "MEMORY.md", content: "i" }], "m"))
      .toEqual({ ok: false, reason: "ref_moved" });
  });

  it.each([
    [422, "Protected branch update failed for refs/heads/main."],
    [409, "Repository rule violations found"],
  ])("%i from the ref update with the ref unchanged → write_rejected, not a race", async (status, message) => {
    mockFetch(writeRoutes(() => json({ message }, status), "c1"));
    const err = await new GitHubStore(new GitHub("t")).commit("dav/mem", "", "c1", [{ path: "MEMORY.md", content: "i" }], "m").catch((e) => e);
    expect((err as GitHubError).kind).toBe("unprocessable");
    expect(toOpError(err).code).toBe("write_rejected");
  });

  it("after a commit, the next snapshot re-reads the ref", async () => {
    let head = "c1";
    const { calls } = mockFetch([
      ...repoRoutes("c1").filter((r) => !r.url.includes("/git/ref/heads/")),
      { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ object: { sha: head } }) },
      { method: "POST", url: `${R}/git/trees`, respond: () => json({ sha: "t2" }) },
      { method: "POST", url: `${R}/git/commits`, respond: () => json({ sha: "c2", html_url: "u" }) },
      { method: "PATCH", url: `${R}/git/refs/heads/main`, respond: () => { head = "c2"; return json({ object: { sha: "c2" } }); } },
      { method: "GET", url: `${R}/git/commits/c2`, respond: () => json({ sha: "c2", message: "m", author: { name: "Dav", date: "d" }, html_url: "u", tree: { sha: "t-c1" } }) },
    ]);
    const store = new GitHubStore(new GitHub("t"));
    await store.snapshot("dav/mem", "");
    await store.commit("dav/mem", "", "c1", [{ path: "MEMORY.md", content: "i" }], "m");
    expect((await store.snapshot("dav/mem", "")).commitSha).toBe("c2");
    expect(count(calls, "/git/ref/heads/")).toBe(2);
  });

  it("empty repo (base null) → initializes README via contents API, then reports ref_moved so the caller retries", async () => {
    const { calls } = mockFetch([
      { method: "GET", url: R, respond: () => json(META) },
      { method: "PUT", url: `${R}/contents/README.md`, respond: () => json({ commit: { sha: "c1" } }, 201) },
    ]);
    expect(await new GitHubStore(new GitHub("t")).commit("dav/mem", "", null, [{ path: "MEMORY.md", content: "i" }], "m"))
      .toEqual({ ok: false, reason: "ref_moved" });
    const put = await calls.find((c) => c.method === "PUT")!.json() as { message: string; content: string };
    expect(put.message).toBe("init: claude-memory");
    expect(atob(put.content)).toMatch(/^# claude-memory/);
  });

  it("empty repo: README init 422 (concurrent first save) → ref_moved, not a throw", async () => {
    mockFetch([
      { method: "GET", url: R, respond: () => json(META) },
      { method: "PUT", url: `${R}/contents/README.md`, respond: () => json({ message: "Invalid request.\n\n\"sha\" wasn't supplied." }, 422) },
    ]);
    expect(await new GitHubStore(new GitHub("t")).commit("dav/mem", "", null, [{ path: "MEMORY.md", content: "i" }], "m"))
      .toEqual({ ok: false, reason: "ref_moved" });
  });
});
