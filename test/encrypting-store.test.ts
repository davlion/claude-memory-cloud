import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyText, newRepoId, parseKeyText, type RepoKey } from "../src/crypto";
import { EncryptingStore } from "../src/encrypting-store";
import { isEncryptedFile, MARKER_PATH, sealMemoryFile, serializeMarker, signMarker } from "../src/encrypted-files";
import { GitHub } from "../src/github";
import { KeyRing, KV } from "../src/keyring";
import { serializeMemory } from "../src/memory";
import { deleteMemory, getIndex, readMemories, saveMemory, type GuardContext } from "../src/operations";
import type { Target } from "../src/scopes";
import { GitHubStore, type Store } from "../src/store";
import { FakeStore } from "./fake-store";
import { json, mockFetch } from "./setup";

const REPO = "dav/mem";
const KEYS_URL = "https://memory.test/keys";
const T: Target = { scopeLabel: "general", displayLabel: "general", repo: REPO, prefix: "" };
const P: Target = { scopeLabel: "project:dav/app", displayLabel: "project app", repo: REPO, prefix: "projects/app/" };
const G: GuardContext = { kind: "general", others: [] };
const NOW = new Date("2026-10-20T10:00:00Z");
const KEY_TEXT = generateKeyText();
const OTHER_TEXT = generateKeyText();
const REPO_ID = newRepoId();
const mem = (name: string, description: string, body: string) => serializeMemory({ name, description, type: "project", body });
const save = (s: Store, name: string, description = `about ${name}`, body = `${name} body\n`, t = T) =>
  saveMemory(s, t, { name, description, type: "project", body, source: "test", force: true }, NOW, G);

let key: RepoKey;
let ring: KeyRing;
let inner: FakeStore;
let store: EncryptingStore;
const marker = async (enabled: boolean, repoId = REPO_ID, k = key) => serializeMarker(await signMarker(k, { enabled, repoId, keyId: k.id }));
const files = () => inner.repo(REPO);

beforeEach(async () => {
  for (const p of Object.values(KV)) await env.OAUTH_KV.delete(p + REPO);
  key = await parseKeyText(KEY_TEXT);
  ring = (await KeyRing.fromEnv(env))!;
  inner = new FakeStore();
  inner.put(REPO, "README.md", "r");
  store = new EncryptingStore(inner, ring, KEYS_URL);
});

/** Registered key, record and signed enabled marker: a normally encrypted repo. */
async function encrypted() {
  await ring.put(REPO, KEY_TEXT, "dav", Date.now());
  await ring.putRecord(REPO, { repoId: REPO_ID, keyId: key.id, enabled: true });
  inner.put(REPO, MARKER_PATH, await marker(true));
}

describe("EncryptingStore", () => {
  it("round trip: a save is stored sealed and reads back as plaintext", async () => {
    await encrypted();
    expect(await save(store, "a", "first thing", "hello\n")).toMatchObject({ status: "created" });
    expect(isEncryptedFile(files().get("memories/a.md")!)).toBe(true);
    expect((await readMemories(store, T, ["a"]))[0]).toMatchObject({ content: mem("a", "first thing", "hello\n") });
    const snap = await store.snapshot(REPO, "");
    expect(snap.encryption).toEqual({ encrypted: true, enabled: true, key: "ok", markerProblem: false, sealed: 1, outside: 0 });
    // Project sets seal at the full path from the repo root.
    await save(store, "p", "project thing", "x\n", P);
    expect((await readMemories(store, P, ["p"]))[0]).toMatchObject({ content: mem("p", "project thing", "x\n") });
  });

  it("no plaintext reaches GitHub or the cache", async () => {
    await encrypted();
    await save(store, "harbor", "quiet harbor", "tide tables\n");
    await save(store, "harbor", "quiet harbor", "tide tables\n"); // exists → no commit
    await saveMemory(store, T, { name: "harbor", description: "quiet harbor", type: "project", body: "tide tables v2\n", version: (await store.snapshot(REPO, "")).files.get("memories/harbor.md")!.sha, source: "t" }, NOW, G);
    for (const text of [...files().values(), ...inner.commits.map((c) => c.message), ...inner.commits.flatMap((c) => c.changes.map((x) => x.content ?? ""))]) {
      expect(text).not.toContain("quiet harbor");
      expect(text).not.toContain("tide tables");
    }
    expect(files().get("MEMORY.md")).toContain("- [harbor](memories/harbor.md)\n");
    expect(await getIndex(store, T)).toContain("quiet harbor");
  });

  it("no plaintext reaches GitHub or the cache (GitHubStore + CACHE_KV)", async () => {
    await ring.put(REPO, KEY_TEXT, "dav", Date.now());
    await ring.putRecord(REPO, { repoId: REPO_ID, keyId: key.id, enabled: true });
    const R = "https://api.github.com/repos/dav/mem";
    const commit = `c-enc-${Date.now()}`;
    const oid = (n: number) => n.toString(16).padStart(40, "0");
    const texts: Record<string, string> = {
      [oid(1)]: await marker(true),
      [oid(2)]: await sealMemoryFile(key, REPO_ID, "memories/old.md", mem("old", "quiet harbor", "tide tables\n")),
    };
    const tree = [{ path: MARKER_PATH, type: "blob", sha: oid(1) }, { path: "memories/old.md", type: "blob", sha: oid(2) }, { path: "README.md", type: "blob", sha: oid(3) }];
    const posted: string[] = [];
    mockFetch([
      { method: "GET", url: R, respond: () => json({ default_branch: "main", visibility: "private" }) },
      { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ object: { sha: commit } }) },
      { method: "GET", url: `${R}/git/commits/${commit}`, respond: () => json({ sha: commit, message: "m", author: { name: "Dav", date: "" }, html_url: "u", tree: { sha: `t-${commit}` } }) },
      { method: "GET", url: `${R}/git/trees/t-${commit}?recursive=1`, respond: () => json({ truncated: false, tree }) },
      { method: "POST", url: "https://api.github.com/graphql", respond: async (req: Request) => {
        const { query } = (await req.json()) as { query: string };
        const repository: Record<string, { text: string } | null> = {};
        for (const m of query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)) repository[m[1]!] = texts[m[2]!] ? { text: texts[m[2]!]! } : null;
        return json({ data: { repository } });
      } },
      { method: "POST", url: `${R}/git/trees`, respond: async (req: Request) => { posted.push(await req.text()); return json({ sha: "t2" }); } },
      { method: "POST", url: `${R}/git/commits`, respond: async (req: Request) => { posted.push(await req.text()); return json({ sha: "c2", html_url: "u2" }); } },
      { method: "PATCH", url: `${R}/git/refs/heads/main`, respond: () => json({}) },
    ]);
    const s = new EncryptingStore(new GitHubStore(new GitHub("t"), env.CACHE_KV), ring, KEYS_URL);
    expect((await readMemories(s, T, ["old"]))[0]).toMatchObject({ content: mem("old", "quiet harbor", "tide tables\n") });
    expect(await save(s, "new", "quiet harbor again", "tide tables again\n")).toMatchObject({ status: "created" });
    const cached = await env.CACHE_KV.get(`snap:v3:${REPO}:${commit}:`);
    expect(cached).toContain("memories/old.md");
    expect(posted.length).toBe(2);
    for (const text of [cached!, ...posted]) {
      expect(text).not.toContain("quiet harbor");
      expect(text).not.toContain("tide tables");
    }
  });

  describe("deleted or unsigned marker keeps the repo encrypted", () => {
    const variants: [string, () => Promise<string | null>][] = [
      ["deleted", async () => null],
      ["unsigned enabled: false", async () => JSON.stringify({ format: 1, enabled: false, repo_id: REPO_ID, key_id: key.id, mac: "00" }, null, 2) + "\n"],
      ["changed repo_id", async () => (await marker(true)).replace(REPO_ID, newRepoId())],
      ["unparseable", async () => "{not json"],
    ];
    for (const [label, make] of variants) {
      it(label, async () => {
        await encrypted();
        await save(store, "a");
        inner.put(REPO, MARKER_PATH, await make());
        const snap = await store.snapshot(REPO, "");
        expect(snap.encryption).toMatchObject({ encrypted: true, enabled: true, key: "ok", markerProblem: true });
        await save(store, "b", "second thing", "quiet harbor\n");
        expect(isEncryptedFile(files().get("memories/b.md")!)).toBe(true);
        expect(files().get("MEMORY.md")).not.toMatch(/^- .* — /m);
        await ring.remove(REPO);
        const before = inner.commits.length;
        await expect(save(new EncryptingStore(inner, ring, KEYS_URL), "c")).rejects.toMatchObject({ code: "key_required" });
        expect(inner.commits.length).toBe(before);
      });
    }

    it("no record, a sealed file present: deleting the marker still blocks plaintext saves", async () => {
      inner.put(REPO, "memories/a.md", await sealMemoryFile(key, REPO_ID, "memories/a.md", mem("a", "x", "y\n")));
      const snap = await store.snapshot(REPO, "");
      expect(snap.encryption).toMatchObject({ encrypted: true, enabled: true, key: "missing", markerProblem: true, sealed: 1 });
      expect(snap.files.get("memories/a.md")).toMatchObject({ locked: true, content: "" });
      const before = inner.commits.length;
      await expect(save(store, "b")).rejects.toMatchObject({ code: "key_required" });
      expect(inner.commits.length).toBe(before);
    });

    it("no record, unsigned enabled: false marker with sealed files: forced enabled", async () => {
      inner.put(REPO, "memories/a.md", await sealMemoryFile(key, REPO_ID, "memories/a.md", mem("a", "x", "y\n")));
      inner.put(REPO, MARKER_PATH, JSON.stringify({ format: 1, enabled: false, repo_id: REPO_ID, key_id: key.id, mac: "00" }));
      expect((await store.snapshot(REPO, "")).encryption).toMatchObject({ encrypted: true, enabled: true, markerProblem: true });
      await expect(save(store, "b")).rejects.toMatchObject({ code: "key_required" });
    });
  });

  it("legit stop: record already disabled (as the key page writes it) + signed enabled: false marker", async () => {
    await encrypted();
    await save(store, "a", "first thing", "quiet harbor\n");
    await ring.putRecord(REPO, { repoId: REPO_ID, keyId: key.id, enabled: false });
    inner.put(REPO, MARKER_PATH, await marker(false));
    const snap = await store.snapshot(REPO, "");
    expect(snap.encryption).toEqual({ encrypted: true, enabled: false, key: "ok", markerProblem: false, sealed: 1, outside: 0 });
    expect(await ring.getRecord(REPO)).toEqual({ repoId: REPO_ID, keyId: key.id, enabled: false });
    await save(store, "b", "second thing", "plain\n");
    expect(files().get("memories/b.md")).toBe(mem("b", "second thing", "plain\n"));
    expect(isEncryptedFile(files().get("memories/a.md")!)).toBe(true);
    expect(files().get("MEMORY.md")).not.toMatch(/^- .* — /m);
    expect((await readMemories(store, T, ["a"]))[0]).toMatchObject({ content: mem("a", "first thing", "quiet harbor\n") });
  });

  it("a replayed signed enabled: false marker never downgrades an enabled record", async () => {
    await encrypted();
    inner.put(REPO, MARKER_PATH, await marker(false));
    expect((await store.snapshot(REPO, "")).encryption).toMatchObject({ enabled: true, key: "ok", markerProblem: true });
    await save(store, "a", "first thing", "quiet harbor\n");
    expect(isEncryptedFile(files().get("memories/a.md")!)).toBe(true);
    expect(await ring.getRecord(REPO)).toEqual({ repoId: REPO_ID, keyId: key.id, enabled: true });
  });

  it("a signed marker updates a stale record", async () => {
    await ring.put(REPO, KEY_TEXT, "dav", Date.now());
    inner.put(REPO, MARKER_PATH, await marker(true));
    await store.snapshot(REPO, "");
    expect(await ring.getRecord(REPO)).toEqual({ repoId: REPO_ID, keyId: key.id, enabled: true });
    await ring.putRecord(REPO, { repoId: REPO_ID, keyId: key.id, enabled: false });
    await store.snapshot(REPO, "");
    expect(await ring.getRecord(REPO)).toEqual({ repoId: REPO_ID, keyId: key.id, enabled: true });
  });

  it("with no record, a signed enabled: false marker creates a disabled record", async () => {
    await ring.put(REPO, KEY_TEXT, "dav", Date.now());
    inner.put(REPO, MARKER_PATH, await marker(false));
    expect((await store.snapshot(REPO, "")).encryption).toMatchObject({ encrypted: false, enabled: false, markerProblem: false });
    expect(await ring.getRecord(REPO)).toEqual({ repoId: REPO_ID, keyId: key.id, enabled: false });
  });

  it("sealed files under one prefix keep another prefix encrypted (sticky record)", async () => {
    inner.put(REPO, "memories/a.md", await sealMemoryFile(key, REPO_ID, "memories/a.md", mem("a", "x", "y\n")));
    expect((await store.snapshot(REPO, "")).encryption).toMatchObject({ encrypted: true, enabled: true, markerProblem: true });
    expect(await ring.getRecord(REPO)).toEqual({ repoId: "", keyId: key.id, enabled: true });
    const s = new EncryptingStore(inner, ring, KEYS_URL);
    expect((await s.snapshot(REPO, "projects/x/")).encryption).toMatchObject({ encrypted: true, enabled: true });
    const before = inner.commits.length;
    await expect(save(s, "p", "about p", "quiet harbor\n", { ...P, prefix: "projects/x/" })).rejects.toMatchObject({ code: "key_required" });
    // With the key registered, the repo ID is still unknown: never sealed under a guessed ID, never plaintext.
    await ring.put(REPO, KEY_TEXT, "dav", Date.now());
    await expect(save(new EncryptingStore(inner, ring, KEYS_URL), "p", "about p", "quiet harbor\n", { ...P, prefix: "projects/x/" })).rejects.toMatchObject({ code: "key_required" });
    expect(inner.commits.length).toBe(before);
    expect([...files().keys()].some((k) => k.startsWith("projects/x/"))).toBe(false);
  });

  it("a forged marker naming the registered key forces encryption on", async () => {
    await ring.put(REPO, KEY_TEXT, "dav", Date.now());
    inner.put(REPO, MARKER_PATH, JSON.stringify({ format: 1, enabled: false, repo_id: REPO_ID, key_id: key.id, mac: "00".repeat(32) }));
    expect((await store.snapshot(REPO, "")).encryption).toMatchObject({ encrypted: true, enabled: true, key: "ok", markerProblem: true });
    await save(store, "a", "first thing", "quiet harbor\n");
    expect(isEncryptedFile(files().get("memories/a.md")!)).toBe(true);
    expect((await readMemories(store, T, ["a"]))[0]).toMatchObject({ content: mem("a", "first thing", "quiet harbor\n") });
  });

  it("mismatched key is treated as missing", async () => {
    await encrypted();
    await save(store, "a");
    await ring.put(REPO, OTHER_TEXT, "dav", Date.now());
    const s = new EncryptingStore(inner, ring, KEYS_URL);
    const snap = await s.snapshot(REPO, "");
    expect(snap.encryption).toMatchObject({ encrypted: true, enabled: true, key: "mismatch" });
    expect(snap.files.get("memories/a.md")).toMatchObject({ locked: true, content: "" });
    const before = inner.commits.length;
    await expect(save(s, "b")).rejects.toMatchObject({ code: "key_required" });
    expect(inner.commits.length).toBe(before);
  });

  it("missing key: names listed, save key_required, delete succeeds", async () => {
    await encrypted();
    await save(store, "a");
    await ring.remove(REPO);
    const s = new EncryptingStore(inner, ring, KEYS_URL);
    const snap = await s.snapshot(REPO, "");
    expect(snap.encryption).toMatchObject({ key: "missing", sealed: 1 });
    expect([...snap.files.keys()]).toEqual(["memories/a.md"]);
    expect(snap.files.get("memories/a.md")).toMatchObject({ locked: true, content: "" });
    const err = await save(s, "b").catch((e) => e);
    expect(err).toMatchObject({
      code: "key_required",
      message: "dav/mem is encrypted and its key isn't registered, so this can't be saved yet.",
      action: `Register the repo's key (from your password manager) at ${KEYS_URL}?repo=dav/mem, then try again.`,
    });
    expect(await deleteMemory(s, T, "a")).toMatchObject({ status: "deleted" });
    expect(files().has("memories/a.md")).toBe(false);
  });

  it("no key ring: unsupported, save write_rejected, no commit", async () => {
    await encrypted();
    await save(store, "a");
    const s = new EncryptingStore(inner, null, KEYS_URL);
    const snap = await s.snapshot(REPO, "");
    expect(snap.encryption).toMatchObject({ encrypted: true, enabled: true, key: "unsupported" });
    expect(snap.files.get("memories/a.md")).toMatchObject({ locked: true });
    const before = inner.commits.length;
    await expect(save(s, "b")).rejects.toMatchObject({
      code: "write_rejected",
      message: "dav/mem is an encrypted memory repo and this memory server doesn't support encryption. Not saved.",
      action: "Ask the memory server's operator to turn on encryption, or use one that has it.",
    });
    expect(inner.commits.length).toBe(before);
  });

  it("tampered file is unreadable, others still load", async () => {
    await encrypted();
    await save(store, "a", "first thing");
    await save(store, "b", "second thing");
    const t = files().get("memories/a.md")!;
    const blob = t.split("\n")[5]!;
    inner.put(REPO, "memories/a.md", t.replace(blob, (blob[0] === "A" ? "B" : "A") + blob.slice(1)));
    const snap = await store.snapshot(REPO, "");
    expect(snap.files.get("memories/a.md")).toMatchObject({ unreadable: true, content: "" });
    expect(snap.files.get("memories/b.md")!.content).toBe(mem("b", "second thing", "b body\n"));
    // A sealed file moved to another path doesn't open either.
    inner.put(REPO, "memories/c.md", files().get("memories/b.md")!.replace("name: b", "name: c"));
    expect((await store.snapshot(REPO, "")).files.get("memories/c.md")).toMatchObject({ unreadable: true });
  });

  it("outside files: marked, never sealed by an unrelated save; saving it seals it", async () => {
    await encrypted();
    inner.put(REPO, "memories/b.md", mem("b", "hand added", "plain\n"));
    const snap = await store.snapshot(REPO, "");
    expect(snap.files.get("memories/b.md")).toMatchObject({ outside: true, content: mem("b", "hand added", "plain\n") });
    expect(snap.encryption).toMatchObject({ outside: 1, sealed: 0 });
    await save(store, "a", "first thing");
    expect(files().get("memories/b.md")).toBe(mem("b", "hand added", "plain\n"));
    await saveMemory(store, T, { name: "b", description: "hand added", type: "project", body: "now sealed\n", version: snap.files.get("memories/b.md")!.sha, source: "t" }, NOW, G);
    expect(isEncryptedFile(files().get("memories/b.md")!)).toBe(true);
    expect((await store.snapshot(REPO, "")).encryption).toMatchObject({ outside: 0, sealed: 2 });
  });

  it("saves wait while switching", async () => {
    await encrypted();
    await ring.setSwitching(REPO);
    await expect(save(store, "a")).rejects.toMatchObject({ code: "unavailable", message: "Encryption is being turned on for this memory repo.", action: "Try again in a minute." });
    expect(inner.commits.length).toBe(0);
  });

  it("saves wait while moving; the move clears once the signed marker with its repoId appears", async () => {
    await ring.put(REPO, KEY_TEXT, "dav", Date.now());
    await ring.putRecord(REPO, { repoId: REPO_ID, keyId: key.id, enabled: true });
    const newId = newRepoId();
    await ring.setMove(REPO, "dav/mem-encrypted", newId);
    const snap = await store.snapshot(REPO, "");
    expect(snap.encryption).toMatchObject({ moving: "dav/mem-encrypted", markerProblem: false });
    await expect(save(store, "a")).rejects.toMatchObject({ code: "unavailable", message: "Encryption is being turned on for this memory repo.", action: `Finish the move on the key page: ${KEYS_URL}?repo=dav/mem` });
    expect(inner.commits.length).toBe(0);
    inner.put(REPO, MARKER_PATH, await marker(true, newId));
    const after = await store.snapshot(REPO, "");
    expect(after.encryption).not.toHaveProperty("moving");
    expect(await ring.getMove(REPO)).toBeNull();
    expect(await save(store, "a")).toMatchObject({ status: "created" });
    expect(isEncryptedFile(files().get("memories/a.md")!)).toBe(true);
  });

  it("no marker, no record, no sealed files: identical to the inner store", async () => {
    inner.put(REPO, "memories/x.md", mem("x", "plain", "text\n"));
    const plain = new FakeStore();
    plain.put(REPO, "README.md", "r");
    plain.put(REPO, "memories/x.md", mem("x", "plain", "text\n"));
    expect(await store.snapshot(REPO, "")).toEqual(await plain.snapshot(REPO, ""));
    await save(store, "a", "first thing", "quiet harbor\n");
    await save(plain, "a", "first thing", "quiet harbor\n");
    expect([...files()]).toEqual([...plain.repo(REPO)]);
    expect(inner.commits).toEqual(plain.commits);
  });
});
