import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GitHub, GitHubError, toOpError } from "../src/github";
import { CACHE_TTL_SECONDS, clearSnapshots, GitHubStore, mapLimit } from "../src/store";
import { MARKER_PATH } from "../src/encrypted-files";
import { json, mockFetch } from "./setup";

const R = "https://api.github.com/repos/dav/mem";
const GQL = "https://api.github.com/graphql";
const oid = (n: number) => n.toString(16).padStart(40, "0");
const [S0, S1, S2, S3, S4, S5, S6, S7] = [0, 1, 2, 3, 4, 5, 6, 7].map((n) => oid(0x100 + n)) as [string, string, string, string, string, string, string, string];
const TEXTS: Record<string, string> = { [S1]: "A — é\n", [S2]: "P\n", [S4]: "C\n" };
const META = { default_branch: "main", private: true, visibility: "private" };
type Entry = { path: string; type: string; sha: string; mode?: string };
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

describe("GitHubStore.snapshot marker", () => {
  const SM = oid(0x300);
  const withMarker = [...TREE, { path: MARKER_PATH, type: "blob", sha: SM }];
  const MTEXT = '{"format": 1}\n';
  it("returns the root marker text for any prefix, in the same GraphQL query", async () => {
    for (const prefix of ["", "projects/billing/"]) {
      const { calls } = mockFetch(repoRoutes("c1", withMarker, { ...TEXTS, [SM]: MTEXT }));
      const snap = await new GitHubStore(new GitHub("t")).snapshot("dav/mem", prefix);
      expect(snap.marker).toBe(MTEXT);
      expect(count(calls, "/graphql")).toBe(1);
      expect([...snap.files.keys()].some((k) => k.includes("encryption.json"))).toBe(false);
    }
  });
  it("marker is null without the file", async () => {
    mockFetch(repoRoutes());
    expect((await new GitHubStore(new GitHub("t")).snapshot("dav/mem", "")).marker).toBeNull();
  });
  it("an unreadable marker blob throws internal", async () => {
    mockFetch(repoRoutes("c1", withMarker));
    await expect(new GitHubStore(new GitHub("t")).snapshot("dav/mem", "")).rejects.toMatchObject({ code: "internal" });
  });
  it("the cache round-trips the marker", async () => {
    const commit = `c-marker-${Date.now()}`;
    mockFetch(repoRoutes(commit, withMarker, { ...TEXTS, [SM]: MTEXT }));
    await new GitHubStore(new GitHub("t"), env.CACHE_KV).snapshot("dav/mem", "");
    const { calls } = mockFetch(repoRoutes(commit, withMarker));
    expect((await new GitHubStore(new GitHub("t"), env.CACHE_KV).snapshot("dav/mem", "")).marker).toBe(MTEXT);
    expect(count(calls, "/graphql")).toBe(0);
  });
});

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

  it("a blob GraphQL can't return as text is marked unreadable, with empty content", async () => {
    mockFetch(repoRoutes("c1", TREE, { [S4]: "C\n" }));
    expect((await new GitHubStore(new GitHub("t")).snapshot("dav/mem", "")).files.get("memories/a.md"))
      .toEqual({ path: "memories/a.md", sha: S1, content: "", unreadable: true });
  });

  it("binary, truncated and null-text blobs are unreadable; the query asks for isBinary and isTruncated; the mark survives the KV cache", async () => {
    const commit = `c-unread-${Date.now()}`;
    const tree = ["bin", "trunc", "nul", "ok"].map((n, i) => ({ path: `memories/${n}.md`, type: "blob", sha: oid(0x2000 + i) }));
    const odd: Record<string, unknown> = { [oid(0x2000)]: { text: "x", isBinary: true, isTruncated: false },
      [oid(0x2001)]: { text: "partial", isBinary: false, isTruncated: true }, [oid(0x2002)]: { text: null, isBinary: false, isTruncated: false },
      [oid(0x2003)]: { text: "fine\n", isBinary: false, isTruncated: false } };
    const gql = { method: "POST", url: GQL, respond: async (req: Request) => {
      const { query } = (await req.json()) as { query: string };
      expect(query).toContain("isBinary isTruncated");
      const repository: Record<string, unknown> = {};
      for (const m of query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)) repository[m[1]!] = odd[m[2]!];
      return json({ data: { repository } });
    } };
    mockFetch([...repoRoutes(commit, tree).filter((r) => r.url !== GQL), gql]);
    const first = await new GitHubStore(new GitHub("t"), env.CACHE_KV).snapshot("dav/mem", "");
    const flags = (s: typeof first) => [...s.files.values()].map((f) => [f.path, f.unreadable === true, f.content]);
    expect(flags(first)).toEqual([["memories/bin.md", true, ""], ["memories/trunc.md", true, ""], ["memories/nul.md", true, ""], ["memories/ok.md", false, "fine\n"]]);
    mockFetch(repoRoutes(commit, tree));
    expect(flags(await new GitHubStore(new GitHub("t"), env.CACHE_KV).snapshot("dav/mem", ""))).toEqual(flags(first));
  });

  it("an internal repo is not private (every enterprise member can read it)", async () => {
    mockFetch([...repoRoutes().filter((r) => r.url !== R),
      { method: "GET", url: R, respond: () => json({ default_branch: "main", private: true, visibility: "internal" }) }]);
    expect((await new GitHubStore(new GitHub("t")).snapshot("dav/mem", "")).isPrivate).toBe(false);
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
    expect(puts).toEqual([{ key: "snap:v3:dav/mem:c1:", opts: { expirationTtl: 604800 } }]);
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
      .toEqual({ commitSha: null, isPrivate: true, indexSha: null, files: new Map(), head: null, marker: null });
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

describe("clearSnapshots", () => {
  it("deletes only the repo's snapshot keys (either case), at most `max` per call", async () => {
    const repo = `Dav/Clear-${crypto.randomUUID()}`;
    const mine = [0, 1, 2, 3].map((i) => `snap:v3:${repo}:c${i}:`).concat(`snap:v3:${repo.toLowerCase()}:c9:`);
    const other = `snap:v3:${repo}x:c1:`;
    for (const k of [...mine, other]) await env.CACHE_KV.put(k, "{}");
    await clearSnapshots(env.CACHE_KV, repo, 3);
    const left = async () => (await Promise.all(mine.map((k) => env.CACHE_KV.get(k)))).filter((v) => v !== null).length;
    expect(await left()).toBe(2);
    await clearSnapshots(env.CACHE_KV, repo);
    expect(await left()).toBe(0);
    expect(await env.CACHE_KV.get(other)).toBe("{}");
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

describe("GitHubStore switch-on helpers", () => {
  const SM = oid(0x300);
  const SI = oid(0x301);
  const MODE_TREE: Entry[] = [
    { path: "MEMORY.md", type: "blob", sha: S0, mode: "100644" },
    { path: "memories", type: "tree", sha: oid(0x400), mode: "040000" },
    { path: "memories/a.md", type: "blob", sha: S1, mode: "100644" },
    { path: "memories/notes.txt", type: "blob", sha: S6, mode: "100644" },
    { path: "projects/billing/MEMORY.md", type: "blob", sha: SI, mode: "100644" },
    { path: "projects/billing/memories/p.md", type: "blob", sha: S2, mode: "100644" },
    { path: "README.md", type: "blob", sha: S3, mode: "100755" },
    { path: "vendor/lib", type: "commit", sha: oid(0x401), mode: "160000" },
    { path: MARKER_PATH, type: "blob", sha: SM, mode: "100644" },
  ] as Entry[];
  const MTEXTS = { ...TEXTS, [S0]: "# idx\n", [SI]: "# billing\n", [SM]: "{}\n", [S3]: "readme\n", [S6]: "notes\n" };

  it("readTree: every non-tree entry with its mode; text only for memory files, MEMORY.md files and the marker", async () => {
    const { calls } = mockFetch(repoRoutes("c1", MODE_TREE, MTEXTS));
    const t = await new GitHubStore(new GitHub("t")).readTree("dav/mem");
    expect(t).toMatchObject({ head: "c1", branch: "main", isPrivate: true });
    expect(t.files).toEqual([
      { path: "MEMORY.md", mode: "100644", sha: S0, text: "# idx\n" },
      { path: "memories/a.md", mode: "100644", sha: S1, text: "A — é\n" },
      { path: "memories/notes.txt", mode: "100644", sha: S6, text: null },
      { path: "projects/billing/MEMORY.md", mode: "100644", sha: SI, text: "# billing\n" },
      { path: "projects/billing/memories/p.md", mode: "100644", sha: S2, text: "P\n" },
      { path: "README.md", mode: "100755", sha: S3, text: null },
      { path: "vendor/lib", mode: "160000", sha: oid(0x401), text: null },
      { path: MARKER_PATH, mode: "100644", sha: SM, text: "{}\n" },
    ]);
    const { query } = (await calls.find((c) => c.url === GQL)!.json()) as { query: string };
    for (const s of [S3, S6]) expect(query).not.toContain(s);
  });

  it("readTree: an unreadable memory blob has text null", async () => {
    mockFetch(repoRoutes("c1", MODE_TREE, { ...MTEXTS, [S1]: undefined as unknown as string }));
    const t = await new GitHubStore(new GitHub("t")).readTree("dav/mem");
    expect(t.files.find((f) => f.path === "memories/a.md")!.text).toBeNull();
  });

  it("readTree re-reads the ref after a snapshot", async () => {
    let head = "c1";
    const { calls } = mockFetch([
      ...repoRoutes("c1", MODE_TREE, MTEXTS).filter((r) => !r.url.toString().includes("/git/ref/heads/")),
      ...repoRoutes("c2", MODE_TREE, MTEXTS).filter((r) => r.url.toString().includes("/git/")),
      { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ object: { sha: head } }) },
    ]);
    const store = new GitHubStore(new GitHub("t"));
    await store.snapshot("dav/mem", "");
    head = "c2";
    expect((await store.readTree("dav/mem")).head).toBe("c2");
    expect(count(calls, "/git/ref/heads/")).toBe(2);
  });

  it("readTree: empty repo → head null, no files", async () => {
    mockFetch([
      { method: "GET", url: R, respond: () => json(META) },
      { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ message: "Git Repository is empty." }, 409) },
    ]);
    expect(await new GitHubStore(new GitHub("t")).readTree("dav/mem")).toEqual({ head: null, branch: "main", isPrivate: true, canWrite: false, files: [] });
  });

  it("extraRefs counts other branches, tags and pull requests in any state", async () => {
    const { calls } = mockFetch([
      { method: "GET", url: R, respond: () => json(META) },
      { method: "GET", url: `${R}/branches`, respond: () => json([{ name: "main" }, { name: "feat" }]) },
      { method: "GET", url: `${R}/tags`, respond: () => json([{ name: "v1" }, { name: "v2" }]) },
      { method: "GET", url: `${R}/git/matching-refs/pull/`, respond: () => json([
        { ref: "refs/pull/1/head" }, { ref: "refs/pull/1/merge" }, { ref: "refs/pull/2/head" },
      ]) },
      { method: "GET", url: `${R}/git/matching-refs/`, respond: () => json([]) },
    ]);
    expect(await new GitHubStore(new GitHub("t")).extraRefs("dav/mem")).toEqual({ branches: 1, tags: 2, pulls: 2, others: 0 });
    // Pull refs come from the git refs API (Contents permission); /pulls would need the Pull requests permission the app doesn't have.
    expect(calls.some((c) => new URL(c.url).pathname.endsWith("/pulls"))).toBe(false);
  });

  it("extraRefs: an empty repo (409 from the refs API) has no pull requests", async () => {
    mockFetch([
      { method: "GET", url: R, respond: () => json(META) },
      { method: "GET", url: `${R}/branches`, respond: () => json([]) },
      { method: "GET", url: `${R}/tags`, respond: () => json([]) },
      { method: "GET", url: `${R}/git/matching-refs/pull/`, respond: () => json({ message: "Git Repository is empty." }, 409) },
      { method: "GET", url: `${R}/git/matching-refs/`, respond: () => json({ message: "Git Repository is empty." }, 409) },
    ]);
    expect(await new GitHubStore(new GitHub("t")).extraRefs("dav/mem")).toEqual({ branches: 0, tags: 0, pulls: 0, others: 0 });
  });

  it("extraRefs: none", async () => {
    mockFetch([
      { method: "GET", url: R, respond: () => json(META) },
      { method: "GET", url: `${R}/branches`, respond: () => json([{ name: "main" }]) },
      { method: "GET", url: `${R}/tags`, respond: () => json([]) },
      { method: "GET", url: `${R}/git/matching-refs/pull/`, respond: () => json([]) },
      { method: "GET", url: `${R}/git/matching-refs/`, respond: () => json([{ ref: "refs/heads/main" }]) },
    ]);
    expect(await new GitHubStore(new GitHub("t")).extraRefs("dav/mem")).toEqual({ branches: 0, tags: 0, pulls: 0, others: 0 });
  });

  it("extraRefs counts refs other than branches, tags and pulls (notes, replace, stash…) from the whole refs list", async () => {
    mockFetch([
      { method: "GET", url: R, respond: () => json(META) },
      { method: "GET", url: `${R}/branches`, respond: () => json([{ name: "main" }]) },
      { method: "GET", url: `${R}/tags`, respond: () => json([]) },
      { method: "GET", url: `${R}/git/matching-refs/pull/`, respond: () => json([]) },
      { method: "GET", url: `${R}/git/matching-refs/`, respond: (req: Request) => {
        expect(new URL(req.url).pathname).toBe("/repos/dav/mem/git/matching-refs/");
        return json([{ ref: "refs/heads/main" }, { ref: "refs/heads/x" }, { ref: "refs/tags/v1" }, { ref: "refs/pull/3/head" },
          { ref: "refs/notes/commits" }, { ref: "refs/replace/0123" }, { ref: "refs/stash" }]);
      } },
    ]);
    expect(await new GitHubStore(new GitHub("t")).extraRefs("dav/mem")).toMatchObject({ others: 3 });
  });

  const historyRoutes = (refNow: string, patch: () => Response = () => json({ object: { sha: "c2" } })) => [
    { method: "GET", url: R, respond: () => json(META) },
    { method: "POST", url: `${R}/git/trees`, respond: () => json({ sha: "t2" }) },
    { method: "POST", url: `${R}/git/commits`, respond: () => json({ sha: "c2", html_url: "https://github.com/dav/mem/commit/c2" }) },
    { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ object: { sha: refNow } }) },
    { method: "PATCH", url: `${R}/git/refs/heads/main`, respond: patch },
  ];
  const FILES = [
    { path: "memories/a.md", mode: "100644", content: "sealed" },
    { path: "README.md", mode: "100755", sha: S3 },
    { path: "vendor/lib", mode: "160000", sha: oid(0x401) },
  ];

  it("replaceHistory: tree without base_tree, a root commit, then a force move", async () => {
    const { calls } = mockFetch(historyRoutes("c1"));
    expect(await new GitHubStore(new GitHub("t")).replaceHistory("dav/mem", "c1", FILES, "encrypt: x"))
      .toEqual({ sha: "c2", url: "https://github.com/dav/mem/commit/c2" });
    expect(await calls.find((c) => c.method === "POST" && c.url.endsWith("/git/trees"))!.json()).toEqual({ tree: [
      { path: "memories/a.md", mode: "100644", type: "blob", content: "sealed" },
      { path: "README.md", mode: "100755", type: "blob", sha: S3 },
      { path: "vendor/lib", mode: "160000", type: "commit", sha: oid(0x401) },
    ] });
    expect(await calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"))!.json()).toEqual({ message: "encrypt: x", tree: "t2", parents: [] });
    expect(await calls.find((c) => c.method === "PATCH")!.json()).toEqual({ sha: "c2", force: true });
  });

  it("replaceHistory: the ref moved → unavailable, no PATCH", async () => {
    const { calls } = mockFetch(historyRoutes("c9"));
    await expect(new GitHubStore(new GitHub("t")).replaceHistory("dav/mem", "c1", FILES, "m")).rejects.toMatchObject({
      code: "unavailable", message: "The memory repo changed during switch-on; nothing was changed.", action: "Try again." });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it.each([409, 422])("replaceHistory: %i on the force move → write_rejected naming the force-push rule", async (status) => {
    mockFetch(historyRoutes("c1", () => json({ message: "Cannot force-push to this branch" }, status)));
    const err = await new GitHubStore(new GitHub("t")).replaceHistory("dav/mem", "c1", FILES, "m").catch((e) => e);
    expect(err).toMatchObject({ code: "write_rejected" });
    expect(`${err.message} ${err.action}`).toMatch(/force push/i);
  });

  const N = "https://api.github.com/repos/dav/new";
  const firstRoutes = (ref: () => Response) => [
    { method: "GET", url: N, respond: () => json(META) },
    { method: "GET", url: `${N}/git/ref/heads/main`, respond: ref },
    { method: "PUT", url: `${N}/contents/README.md`, respond: () => json({ commit: { sha: "p1" } }, 201) },
    { method: "GET", url: `${R}/git/blobs/${S3}`, respond: () => json({ sha: S3, content: "cmVh\nZG1l\n", encoding: "base64" }) },
    { method: "POST", url: `${N}/git/blobs`, respond: () => json({ sha: S3 }, 201) },
    { method: "POST", url: `${N}/git/trees`, respond: () => json({ sha: "t2" }) },
    { method: "POST", url: `${N}/git/commits`, respond: () => json({ sha: "c2", html_url: "https://github.com/dav/new/commit/c2" }) },
    { method: "PATCH", url: `${N}/git/refs/heads/main`, respond: () => json({ object: { sha: "c2" } }) },
  ];

  it("writeFirstCommit: placeholder via the contents API, blobs copied from the source, one root commit, force move", async () => {
    let created = false;
    const routes = firstRoutes(() => created ? json({ object: { sha: "p1" } }) : json({ message: "Git Repository is empty." }, 409));
    const put = routes.find((r) => r.method === "PUT")!;
    const { calls } = mockFetch([...routes.filter((r) => r !== put),
      { ...put, respond: () => { created = true; return json({ commit: { sha: "p1" } }, 201); } }]);
    await expect(new GitHubStore(new GitHub("t")).writeFirstCommit("dav/new", FILES, "encrypt: fresh", "dav/mem"))
      .resolves.toEqual({ sha: "c2", url: "https://github.com/dav/new/commit/c2" });
    const order = calls.map((c) => `${c.method} ${c.url.replace("https://api.github.com/repos/", "")}`);
    expect(order.indexOf(`PUT dav/new/contents/README.md`)).toBeLessThan(order.indexOf("POST dav/new/git/blobs"));
    expect(await calls.find((c) => c.method === "POST" && c.url.endsWith("/git/blobs"))!.json()).toEqual({ content: "cmVhZG1l", encoding: "base64" });
    expect(await calls.find((c) => c.method === "POST" && c.url.endsWith("/git/commits"))!.json()).toEqual({ message: "encrypt: fresh", tree: "t2", parents: [] });
    expect(await calls.find((c) => c.method === "PATCH")!.json()).toEqual({ sha: "c2", force: true });
  });

  it("writeFirstCommit refuses a repo that isn't empty, before any write", async () => {
    const { calls } = mockFetch(firstRoutes(() => json({ object: { sha: "x1" } })));
    await expect(new GitHubStore(new GitHub("t")).writeFirstCommit("dav/new", FILES, "m", "dav/mem")).rejects.toMatchObject({ code: "invalid" });
    expect(calls.filter((c) => c.method !== "GET")).toHaveLength(0);
  });
});
