import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { generateKeyText, parseKeyText, type RepoKey } from "../src/crypto";
import { isEncryptedFile, MARKER_PATH, markerSignedBy, openMemoryFile, parseMarker, sealMemoryFile, serializeMarker, signMarker } from "../src/encrypted-files";
import { GitHub } from "../src/github";
import { KeyRing } from "../src/keyring";
import { GitHubStore, type TreeFile } from "../src/store";
import { planEncryptedTree, switchOnFresh, switchOnInPlace } from "../src/switch-on";
import { json, mockFetch } from "./setup";

const API = "https://api.github.com/repos/";
const oid = (n: number) => n.toString(16).padStart(40, "0");
type Entry = { path: string; type: string; sha: string; mode: string };

const MEM_A = "---\nname: a\ndescription: Alpha secret description\nmetadata:\n  type: user\n---\n\nalpha secret body\n";
const MEM_P = "---\nname: p\ndescription: Billing secret description\nmetadata:\n  type: project\n---\n\nbilling secret body\n";
const IDX = "# Memory index — general\n\n- [a](memories/a.md) — Alpha secret description\n";
const IDX_P = "# Memory index — project billing\n\n- [p](memories/p.md) — Billing secret description\n";
const SECRETS = ["alpha secret body", "billing secret body", "Alpha secret description", "Billing secret description"];

let seq = 0;
const uniq = (base: string) => `dav/${base}-${Date.now()}-${seq++}`;

interface FakeRepo {
  name: string; head: string | null; tree: Entry[]; texts: Record<string, string | undefined>;
  meta: Record<string, unknown>; branches: string[]; tags: string[]; pulls: number;
  /** Returns the ref for the n-th GET (0-based); defaults to `head`. */
  refAt?: (n: number) => string | null;
  patch?: () => Response;
}

function fakeRepo(name: string, over: Partial<FakeRepo> = {}): FakeRepo {
  const S = (n: number) => oid(n);
  return {
    name, head: "c1",
    tree: [
      { path: "MEMORY.md", type: "blob", sha: S(1), mode: "100644" },
      { path: "memories", type: "tree", sha: S(90), mode: "040000" },
      { path: "memories/a.md", type: "blob", sha: S(2), mode: "100644" },
      { path: "projects/billing/MEMORY.md", type: "blob", sha: S(3), mode: "100644" },
      { path: "projects/billing/memories/p.md", type: "blob", sha: S(4), mode: "100644" },
      { path: "README.md", type: "blob", sha: S(5), mode: "100755" },
    ],
    texts: { [S(1)]: IDX, [S(2)]: MEM_A, [S(3)]: IDX_P, [S(4)]: MEM_P, [S(5)]: "readme\n" },
    meta: { default_branch: "main", visibility: "private", permissions: { push: true } },
    branches: ["main"], tags: [], pulls: 0,
    ...over,
  };
}

function routes(repos: FakeRepo[]) {
  const texts = Object.assign({}, ...repos.map((r) => r.texts)) as Record<string, string | undefined>;
  const out = [];
  for (const r of repos) {
    const B = API + r.name;
    let refGets = 0;
    out.push(
      { method: "GET", url: B, respond: () => json(r.meta) },
      { method: "GET", url: `${B}/git/ref/heads/main`, respond: () => {
        const h = r.refAt ? r.refAt(refGets++) : r.head;
        return h === null ? json({ message: "Git Repository is empty." }, 409) : json({ object: { sha: h } });
      } },
      { method: "GET", url: `${B}/git/commits/`, respond: (req: Request) => {
        const sha = req.url.split("/").pop()!;
        return json({ sha, message: "m", author: { name: "Dav", date: "d" }, html_url: `https://github.com/${r.name}/commit/${sha}`, tree: { sha: `t-${sha}` } });
      } },
      { method: "GET", url: `${B}/git/trees/`, respond: () => json({ truncated: false, tree: r.tree }) },
      { method: "GET", url: `${B}/branches`, respond: () => json(r.branches.map((name) => ({ name }))) },
      { method: "GET", url: `${B}/tags`, respond: () => json(r.tags.map((name) => ({ name }))) },
      { method: "GET", url: `${B}/git/matching-refs/pull/`, respond: () => json(Array.from({ length: r.pulls }, (_, i) => ({ ref: `refs/pull/${i + 1}/head` }))) },
      { method: "GET", url: `${B}/git/blobs/`, respond: (req: Request) => {
        const sha = req.url.split("/").pop()!;
        return json({ sha, content: btoa(texts[sha] ?? "x"), encoding: "base64" });
      } },
      { method: "POST", url: `${B}/git/blobs`, respond: () => json({ sha: "copied" }, 201) },
      { method: "POST", url: `${B}/git/trees`, respond: () => json({ sha: "t-new" }) },
      { method: "POST", url: `${B}/git/commits`, respond: () => json({ sha: "c-new", html_url: `https://github.com/${r.name}/commit/c-new` }) },
      { method: "PATCH", url: `${B}/git/refs/heads/main`, respond: () => {
        if (r.patch) return r.patch();
        r.head = "c-new";
        return json({ object: { sha: "c-new" } });
      } },
      { method: "PUT", url: `${B}/contents/README.md`, respond: () => { r.head = "p1"; return json({ commit: { sha: "p1" } }, 201); } },
    );
  }
  out.push({ method: "POST", url: "https://api.github.com/graphql", respond: async (req: Request) => {
    const { query } = (await req.json()) as { query: string };
    const repository: Record<string, { text: string } | null> = {};
    for (const m of query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)) {
      const t = texts[m[2]!];
      repository[m[1]!] = t === undefined ? null : { text: t };
    }
    return json({ data: { repository } });
  } });
  return out;
}

const ring = () => KeyRing.fromEnv(env as never) as Promise<KeyRing>;
const store = () => new GitHubStore(new GitHub("t"), env.CACHE_KV);
const writes = (calls: Request[], repo: string) =>
  calls.filter((c) => c.method !== "GET" && c.url.startsWith(API + repo + "/"));
const body = async (calls: Request[], method: string, suffix: string) =>
  (await calls.find((c) => c.method === method && c.url.endsWith(suffix))!.clone().json()) as Record<string, unknown>;
type TreeBody = { tree: { path: string; mode: string; type: string; sha?: string; content?: string }[]; base_tree?: string };

async function expectNoPlaintext(calls: Request[]) {
  for (const c of calls.filter((x) => x.method !== "GET" && !x.url.endsWith("/graphql"))) {
    const text = await c.clone().text();
    for (const s of SECRETS) expect(text).not.toContain(s);
  }
}

describe("planEncryptedTree", () => {
  const files: TreeFile[] = [
    { path: "MEMORY.md", mode: "100644", sha: oid(1), text: IDX },
    { path: "memories/a.md", mode: "100644", sha: oid(2), text: MEM_A },
    { path: "projects/billing/memories/p.md", mode: "100644", sha: oid(4), text: MEM_P },
    { path: "README.md", mode: "100755", sha: oid(5), text: null },
  ];

  it("seals memory files, names-only MEMORY.md, keeps others by SHA and mode, adds a signed marker with a new repo ID", async () => {
    const key = await parseKeyText(generateKeyText());
    const { files: out, marker } = await planEncryptedTree(files, key, null);
    expect(marker.enabled).toBe(true);
    expect(marker.keyId).toBe(key.id);
    expect(marker.repoId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await markerSignedBy(key, marker)).toBe(true);
    const by = new Map(out.map((f) => [f.path, f]));
    expect(by.get("README.md")).toEqual({ path: "README.md", mode: "100755", sha: oid(5) });
    expect(by.get("MEMORY.md")!.content).toBe("# Memory index — general\n\n- [a](memories/a.md)\n");
    for (const [p, plain] of [["memories/a.md", MEM_A], ["projects/billing/memories/p.md", MEM_P]] as const) {
      expect(isEncryptedFile(by.get(p)!.content!)).toBe(true);
      expect(await openMemoryFile(key, marker.repoId, p, by.get(p)!.content!)).toBe(plain);
    }
    expect(parseMarker(by.get(MARKER_PATH)!.content!)).toEqual(marker);
  });

  it("an unreadable memory file → write_rejected listing it", async () => {
    const key = await parseKeyText(generateKeyText());
    const err = await planEncryptedTree([...files, { path: "memories/z.md", mode: "100644", sha: oid(9), text: null }], key, null).catch((e) => e);
    expect(err).toMatchObject({ code: "write_rejected" });
    expect(err.message).toContain("memories/z.md");
  });

  it("a sealed file another key made → invalid", async () => {
    const key = await parseKeyText(generateKeyText());
    const other = await parseKeyText(generateKeyText());
    const sealed = await sealMemoryFile(other, "rid", "memories/b.md", MEM_A);
    await expect(planEncryptedTree([...files, { path: "memories/b.md", mode: "100644", sha: oid(8), text: sealed }], key, null))
      .rejects.toMatchObject({ code: "invalid", message: "That key doesn't match this repo." });
  });
});

describe("switchOnInPlace", () => {
  it("squashes history into one root commit with every memory sealed, then registers the key", async () => {
    const r = fakeRepo(uniq("mem"));
    const keyText = generateKeyText();
    const key = await parseKeyText(keyText);
    const { calls } = mockFetch(routes([r]));
    const keys = await ring();
    const res = await switchOnInPlace(store(), keys, env.CACHE_KV, r.name, keyText, "dav");
    expect(res).toEqual({ url: `https://github.com/${r.name}/commit/c-new` });

    const tree = await body(calls, "POST", "/git/trees") as unknown as TreeBody;
    expect(tree.base_tree).toBeUndefined();
    const by = new Map(tree.tree.map((t) => [t.path, t]));
    expect(by.get("README.md")).toEqual({ path: "README.md", mode: "100755", type: "blob", sha: oid(5) });
    expect(by.has("memories")).toBe(false);
    expect(by.get("MEMORY.md")!.content).toBe("# Memory index — general\n\n- [a](memories/a.md)\n");
    expect(by.get("projects/billing/MEMORY.md")!.content).toBe("# Memory index — project billing\n\n- [p](memories/p.md)\n");
    const marker = parseMarker(by.get(MARKER_PATH)!.content!);
    expect(marker).toMatchObject({ enabled: true, keyId: key.id });
    expect(await markerSignedBy(key, marker)).toBe(true);
    expect(await openMemoryFile(key, marker.repoId, "memories/a.md", by.get("memories/a.md")!.content!)).toBe(MEM_A);
    expect(await openMemoryFile(key, marker.repoId, "projects/billing/memories/p.md", by.get("projects/billing/memories/p.md")!.content!)).toBe(MEM_P);

    const commit = await body(calls, "POST", "/git/commits");
    expect(commit.parents).toEqual([]);
    expect(commit.message).toBe("encrypt: switch on, history squashed\n\nMemory-Source: key page (dav)\nMemory-Scope: *\n");
    expect(await body(calls, "PATCH", "/git/refs/heads/main")).toEqual({ sha: "c-new", force: true });
    await expectNoPlaintext(calls);

    expect(await keys.getRecord(r.name)).toEqual({ repoId: marker.repoId, keyId: key.id, enabled: true });
    expect((await (await ring()).get(r.name))!.key.id).toBe(key.id);
    expect(await keys.isSwitching(r.name)).toBe(false);
  });

  it("aborts when the ref moved: no PATCH, switching flag cleared, nothing registered", async () => {
    const r = fakeRepo(uniq("mem"), { refAt: (n) => (n === 0 ? "c1" : "c9") });
    const { calls } = mockFetch(routes([r]));
    const keys = await ring();
    await expect(switchOnInPlace(store(), keys, env.CACHE_KV, r.name, generateKeyText(), "dav")).rejects.toMatchObject({ code: "unavailable" });
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(0);
    expect(await keys.isSwitching(r.name)).toBe(false);
    expect(await keys.getRecord(r.name)).toBeNull();
    expect(await keys.get(r.name)).toBeNull();
  });

  it("sets the switching flag before reading the tree", async () => {
    const r = fakeRepo(uniq("mem"));
    const keys = await ring();
    let seen: boolean | null = null;
    const rs = routes([r]).map((x) => x.method === "GET" && x.url === `${API}${r.name}/git/trees/`
      ? { ...x, respond: async (req: Request) => { seen = await keys.isSwitching(r.name); return x.respond(req); } } : x);
    mockFetch(rs);
    await switchOnInPlace(store(), keys, env.CACHE_KV, r.name, generateKeyText(), "dav");
    expect(seen).toBe(true);
  });

  it.each([
    [{ branches: ["main", "feat"] }, /1 other branch/, /delete/i],
    [{ tags: ["v1", "v2"] }, /2 tags/, /delete/i],
    [{ pulls: 1 }, /1 pull request/, /fresh/i],
  ])("extra refs %o → invalid before any write", async (over, msg, action) => {
    const r = fakeRepo(uniq("mem"), over as Partial<FakeRepo>);
    const { calls } = mockFetch(routes([r]));
    const keys = await ring();
    const err = await switchOnInPlace(store(), keys, env.CACHE_KV, r.name, generateKeyText(), "dav").catch((e) => e);
    expect(err).toMatchObject({ code: "invalid" });
    expect(err.message).toMatch(msg);
    expect(err.action).toMatch(action);
    expect(writes(calls, r.name)).toHaveLength(0);
    expect(await keys.isSwitching(r.name)).toBe(false);
  });

  it("a public repo → repo_public before any write", async () => {
    const r = fakeRepo(uniq("mem"), { meta: { default_branch: "main", visibility: "public", permissions: { push: true } } });
    const { calls } = mockFetch(routes([r]));
    await expect(switchOnInPlace(store(), await ring(), env.CACHE_KV, r.name, generateKeyText(), "dav")).rejects.toMatchObject({ code: "repo_public" });
    expect(writes(calls, r.name)).toHaveLength(0);
  });

  it("a 422 on the force move → write_rejected, nothing registered, flag cleared", async () => {
    const r = fakeRepo(uniq("mem"), { patch: () => json({ message: "Cannot force-push to this branch" }, 422) });
    mockFetch(routes([r]));
    const keys = await ring();
    await expect(switchOnInPlace(store(), keys, env.CACHE_KV, r.name, generateKeyText(), "dav")).rejects.toMatchObject({ code: "write_rejected" });
    expect(await keys.getRecord(r.name)).toBeNull();
    expect(await keys.get(r.name)).toBeNull();
    expect(await keys.isSwitching(r.name)).toBe(false);
  });

  it("an unreadable memory blob aborts before any POST", async () => {
    const r = fakeRepo(uniq("mem"));
    r.texts[oid(4)] = undefined;
    const { calls } = mockFetch(routes([r]));
    const keys = await ring();
    const err = await switchOnInPlace(store(), keys, env.CACHE_KV, r.name, generateKeyText(), "dav").catch((e) => e);
    expect(err).toMatchObject({ code: "write_rejected" });
    expect(err.message).toContain("projects/billing/memories/p.md");
    expect(writes(calls, r.name)).toHaveLength(0);
    expect(await keys.isSwitching(r.name)).toBe(false);
  });

  it("deletes the repo's snapshot cache keys after success, and only those", async () => {
    const r = fakeRepo(uniq("mem"));
    const mine = [`snap:v3:${r.name}:c1:`, `snap:v3:${r.name}:c0:projects/billing/`];
    const other = `snap:v3:${r.name}x:c1:`;
    for (const k of [...mine, other]) await env.CACHE_KV.put(k, "{}");
    mockFetch(routes([r]));
    await switchOnInPlace(store(), await ring(), env.CACHE_KV, r.name, generateKeyText(), "dav");
    for (const k of mine) expect(await env.CACHE_KV.get(k)).toBeNull();
    expect(await env.CACHE_KV.get(other)).toBe("{}");
  });

  it("an empty repo gets its first commit (placeholder, then one root commit), with just the marker", async () => {
    const r = fakeRepo(uniq("mem"), { head: null, tree: [], texts: {} });
    const { calls } = mockFetch(routes([r]));
    const keys = await ring();
    await switchOnInPlace(store(), keys, env.CACHE_KV, r.name, generateKeyText(), "dav");
    expect(calls.some((c) => c.method === "PUT")).toBe(true);
    const tree = await body(calls, "POST", "/git/trees") as unknown as TreeBody;
    expect(tree.tree.map((t) => t.path)).toEqual([MARKER_PATH]);
    expect(await body(calls, "PATCH", "/git/refs/heads/main")).toEqual({ sha: "c-new", force: true });
    expect((await keys.getRecord(r.name))!.enabled).toBe(true);
  });

  it("an unparseable marker counts as absent: plaintext memories get sealed under a new repo ID", async () => {
    const r = fakeRepo(uniq("mem"));
    r.tree.push({ path: MARKER_PATH, type: "blob", sha: oid(21), mode: "100644" });
    r.texts[oid(21)] = "not json";
    const { calls } = mockFetch(routes([r]));
    const keyText = generateKeyText();
    const key = await parseKeyText(keyText);
    await switchOnInPlace(store(), await ring(), env.CACHE_KV, r.name, keyText, "dav");
    const tree = await body(calls, "POST", "/git/trees") as unknown as TreeBody;
    const marker = parseMarker(tree.tree.find((t) => t.path === MARKER_PATH)!.content!);
    expect(await markerSignedBy(key, marker)).toBe(true);
    expect(marker.repoId).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("an unparseable marker with sealed files → invalid, no writes", async () => {
    const keyText = generateKeyText();
    const key = await parseKeyText(keyText);
    const r = fakeRepo(uniq("mem"));
    r.tree.push({ path: "memories/b.md", type: "blob", sha: oid(20), mode: "100644" }, { path: MARKER_PATH, type: "blob", sha: oid(21), mode: "100644" });
    Object.assign(r.texts, { [oid(20)]: await sealMemoryFile(key, "old-id", "memories/b.md", MEM_A.replace("name: a", "name: b")), [oid(21)]: "not json" });
    const { calls } = mockFetch(routes([r]));
    const keys = await ring();
    await expect(switchOnInPlace(store(), keys, env.CACHE_KV, r.name, keyText, "dav")).rejects.toMatchObject({ code: "invalid" });
    expect(writes(calls, r.name)).toHaveLength(0);
    expect(await keys.isSwitching(r.name)).toBe(false);
  });

  it("re-enable: keeps the repo ID and the files already sealed with the key", async () => {
    const keyText = generateKeyText();
    const key = await parseKeyText(keyText);
    const off = await signMarker(key, { enabled: false, repoId: "keep-this-id", keyId: key.id });
    const sealedB = await sealMemoryFile(key, "keep-this-id", "memories/b.md", MEM_A.replace("name: a", "name: b"));
    const r = fakeRepo(uniq("mem"));
    r.tree.push({ path: "memories/b.md", type: "blob", sha: oid(20), mode: "100644" }, { path: MARKER_PATH, type: "blob", sha: oid(21), mode: "100644" });
    Object.assign(r.texts, { [oid(20)]: sealedB, [oid(21)]: serializeMarker(off) });
    const { calls } = mockFetch(routes([r]));
    const keys = await ring();
    await switchOnInPlace(store(), keys, env.CACHE_KV, r.name, keyText, "dav");
    const tree = await body(calls, "POST", "/git/trees") as unknown as TreeBody;
    const by = new Map(tree.tree.map((t) => [t.path, t]));
    expect(by.get("memories/b.md")).toEqual({ path: "memories/b.md", mode: "100644", type: "blob", sha: oid(20) });
    const marker = parseMarker(by.get(MARKER_PATH)!.content!);
    expect(marker).toMatchObject({ enabled: true, repoId: "keep-this-id" });
    expect(await openMemoryFile(key, "keep-this-id", "memories/a.md", by.get("memories/a.md")!.content!)).toBe(MEM_A);
    expect(await keys.getRecord(r.name)).toEqual({ repoId: "keep-this-id", keyId: key.id, enabled: true });
  });
});

describe("turning back on without a usable marker", () => {
  it("keeps the record's repo ID when the key is the record's key, so files already sealed still open", async () => {
    const keyText = generateKeyText();
    const key = await parseKeyText(keyText);
    const sealedB = await sealMemoryFile(key, "keep-this-id", "memories/b.md", MEM_A.replace("name: a", "name: b"));
    const r = fakeRepo(uniq("mem"));
    r.tree.push({ path: "memories/b.md", type: "blob", sha: oid(20), mode: "100644" });
    r.texts[oid(20)] = sealedB; // marker deleted
    const { calls } = mockFetch(routes([r]));
    const keys = await ring();
    await keys.putRecord(r.name, { repoId: "keep-this-id", keyId: key.id, enabled: false });
    await switchOnInPlace(store(), keys, env.CACHE_KV, r.name, keyText, "dav");
    const tree = await body(calls, "POST", "/git/trees") as unknown as TreeBody;
    expect(parseMarker(tree.tree.find((t) => t.path === MARKER_PATH)!.content!)).toMatchObject({ enabled: true, repoId: "keep-this-id" });
  });

  it("planEncryptedTree: the record's repo ID only for the record's key", async () => {
    const key = await parseKeyText(generateKeyText());
    const rec = { repoId: "rec-id", keyId: key.id, enabled: false };
    expect((await planEncryptedTree([], key, null, rec)).marker.repoId).toBe("rec-id");
    expect((await planEncryptedTree([], key, null, { ...rec, keyId: "0".repeat(16) })).marker.repoId).not.toBe("rec-id");
    expect((await planEncryptedTree([], key, null, null)).marker.repoId).not.toBe("rec-id");
  });
});

describe("switchOnFresh", () => {
  it("a non-empty target → invalid, nothing written anywhere", async () => {
    const r = fakeRepo(uniq("mem"));
    const n = fakeRepo(uniq("new"), { head: "x1" });
    const { calls } = mockFetch(routes([r, n]));
    const keys = await ring();
    await expect(switchOnFresh(store(), keys, env.CACHE_KV, r.name, n.name, generateKeyText(), "dav")).rejects.toMatchObject({ code: "invalid" });
    expect([...writes(calls, r.name), ...writes(calls, n.name)]).toHaveLength(0);
    expect(await keys.getMove(r.name)).toBeNull();
    expect(await keys.isSwitching(r.name)).toBe(false);
  });

  it.each([
    ["public", { default_branch: "main", visibility: "public", permissions: { push: true } }, "repo_public"],
    ["read-only", { default_branch: "main", visibility: "private", permissions: { push: false } }, "invalid"],
  ])("a %s target → refused", async (_, meta, code) => {
    const r = fakeRepo(uniq("mem"));
    const n = fakeRepo(uniq("new"), { head: null, meta });
    const { calls } = mockFetch(routes([r, n]));
    await expect(switchOnFresh(store(), await ring(), env.CACHE_KV, r.name, n.name, generateKeyText(), "dav")).rejects.toMatchObject({ code });
    expect([...writes(calls, r.name), ...writes(calls, n.name)]).toHaveLength(0);
  });

  it("the same repo as target → invalid", async () => {
    const r = fakeRepo(uniq("mem"));
    mockFetch(routes([r]));
    await expect(switchOnFresh(store(), await ring(), env.CACHE_KV, r.name, r.name.toUpperCase(), generateKeyText(), "dav")).rejects.toMatchObject({ code: "invalid" });
  });

  it("writes one root commit to the new repo, sets the move, record and key under the old name, leaves the old repo untouched", async () => {
    const r = fakeRepo(uniq("mem"));
    const n = fakeRepo(uniq("new"), { head: null });
    const keyText = generateKeyText();
    const key: RepoKey = await parseKeyText(keyText);
    const { calls } = mockFetch(routes([r, n]));
    const keys = await ring();
    const res = await switchOnFresh(store(), keys, env.CACHE_KV, r.name, n.name, keyText, "dav");
    expect(res).toEqual({ url: `https://github.com/${n.name}/commit/c-new` });

    expect(writes(calls, r.name)).toHaveLength(0);
    const commits = calls.filter((c) => c.method === "POST" && c.url.endsWith(`${n.name}/git/commits`));
    expect(commits).toHaveLength(1);
    const commit = (await commits[0]!.clone().json()) as { parents: string[]; message: string };
    expect(commit.parents).toEqual([]);
    expect(commit.message).toBe(`encrypt: fresh encrypted copy of ${r.name}\n\nMemory-Source: key page (dav)\nMemory-Scope: *\n`);
    expect(await body(calls, "PATCH", `${n.name}/git/refs/heads/main`)).toEqual({ sha: "c-new", force: true });
    const tree = await body(calls, "POST", `${n.name}/git/trees`) as unknown as TreeBody;
    const marker = parseMarker(tree.tree.find((t) => t.path === MARKER_PATH)!.content!);
    expect(await markerSignedBy(key, marker)).toBe(true);
    expect(calls.some((c) => c.method === "GET" && c.url.endsWith(`${r.name}/git/blobs/${oid(5)}`))).toBe(true);
    await expectNoPlaintext(calls);

    expect(await keys.getMove(r.name)).toEqual({ to: n.name, repoId: marker.repoId, head: "c1", prevRecord: null });
    expect(await keys.getRecord(r.name)).toEqual({ repoId: marker.repoId, keyId: key.id, enabled: true });
    expect((await (await ring()).get(r.name))!.key.id).toBe(key.id);
    expect(await keys.get(n.name)).toBeNull();
    expect(await keys.isSwitching(r.name)).toBe(false);
  });

  it("the move keeps the record from before, so cancelling can put it back", async () => {
    const r = fakeRepo(uniq("mem"));
    const n = fakeRepo(uniq("new"), { head: null });
    mockFetch(routes([r, n]));
    const keys = await ring();
    const prev = { repoId: "old-id", keyId: "0123456789abcdef", enabled: false };
    await keys.putRecord(r.name, prev);
    await switchOnFresh(store(), keys, env.CACHE_KV, r.name, n.name, generateKeyText(), "dav");
    expect(await keys.getMove(r.name)).toMatchObject({ head: "c1", prevRecord: prev });
  });

  it("deletes the old repo's snapshot cache keys after success, and only those", async () => {
    const r = fakeRepo(uniq("mem"));
    const n = fakeRepo(uniq("new"), { head: null });
    const mine = [`snap:v3:${r.name}:c1:`, `snap:v3:${r.name}:c0:projects/billing/`];
    const other = `snap:v3:${r.name}x:c1:`;
    for (const k of [...mine, other]) await env.CACHE_KV.put(k, "{}");
    mockFetch(routes([r, n]));
    await switchOnFresh(store(), await ring(), env.CACHE_KV, r.name, n.name, generateKeyText(), "dav");
    for (const k of mine) expect(await env.CACHE_KV.get(k)).toBeNull();
    expect(await env.CACHE_KV.get(other)).toBe("{}");
  });

  it("the old repo moved while the copy was written → unavailable; no move, record or key", async () => {
    const r = fakeRepo(uniq("mem"), { refAt: (i) => (i === 0 ? "c1" : "c9") });
    const n = fakeRepo(uniq("new"), { head: null });
    const { calls } = mockFetch(routes([r, n]));
    const keys = await ring();
    await expect(switchOnFresh(store(), keys, env.CACHE_KV, r.name, n.name, generateKeyText(), "dav")).rejects.toMatchObject({
      code: "unavailable",
      message: "The memory repo changed while its encrypted copy was being written; nothing was switched.",
      action: `Delete and recreate ${n.name} as an empty private repo, then try again.`,
    });
    expect(writes(calls, r.name)).toHaveLength(0);
    expect(await keys.getMove(r.name)).toBeNull();
    expect(await keys.getRecord(r.name)).toBeNull();
    expect(await keys.get(r.name)).toBeNull();
    expect(await keys.isSwitching(r.name)).toBe(false);
  });
});

describe("progress", () => {
  it("in place: reports each stage in order; without progress it behaves as before", async () => {
    const r = fakeRepo(uniq("mem"));
    mockFetch(routes([r]));
    const steps: string[] = [];
    const res = await switchOnInPlace(store(), await ring(), env.CACHE_KV, r.name, generateKeyText(), "dav", (s) => steps.push(s));
    expect(res).toEqual({ url: `https://github.com/${r.name}/commit/c-new` });
    expect(steps).toEqual([`Read ${r.name}: 2 memories`, "Encrypted 2 memories", "Wrote the new history (one commit)", "Stored the key"]);
  });

  it("fresh: reports each stage in order", async () => {
    const r = fakeRepo(uniq("mem"));
    const n = fakeRepo(uniq("new"), { head: null });
    mockFetch(routes([r, n]));
    const steps: string[] = [];
    await switchOnFresh(store(), await ring(), env.CACHE_KV, r.name, n.name, generateKeyText(), "dav", (s) => steps.push(s));
    expect(steps).toEqual([`Read ${r.name}: 2 memories`, "Encrypted 2 memories", `Wrote the encrypted copy to ${n.name}`,
      `Checked ${r.name} didn't change during the copy`, "Stored the key"]);
  });

  it("a failing stage stops the reports there", async () => {
    const r = fakeRepo(uniq("mem"), { refAt: (i) => (i === 0 ? "c1" : "c9") });
    const n = fakeRepo(uniq("new"), { head: null });
    mockFetch(routes([r, n]));
    const steps: string[] = [];
    await expect(switchOnFresh(store(), await ring(), env.CACHE_KV, r.name, n.name, generateKeyText(), "dav", (s) => steps.push(s))).rejects.toMatchObject({ code: "unavailable" });
    expect(steps).toEqual([`Read ${r.name}: 2 memories`, "Encrypted 2 memories", `Wrote the encrypted copy to ${n.name}`]);
  });
});
