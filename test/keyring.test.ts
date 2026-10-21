import { describe, expect, it } from "vitest";
import { generateKeyText, parseKeyText, parseMasterKey } from "../src/crypto";
import { KeyRing } from "../src/keyring";

const MASTER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const OTHER = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=";

/** In-memory KV that records the options of every put. */
const fakeKv = () => {
  const data = new Map<string, string>();
  const puts: { key: string; opts?: { expirationTtl?: number } }[] = [];
  const kv = {
    get: async (k: string) => data.get(k) ?? null,
    put: async (k: string, v: string, opts?: { expirationTtl?: number }) => { data.set(k, v); puts.push({ key: k, opts }); },
    delete: async (k: string) => { data.delete(k); },
  } as unknown as KVNamespace;
  return { kv, data, puts };
};
const ring = async (kv: KVNamespace, ttl = 0, master = MASTER) => new KeyRing(kv, await parseMasterKey(master), ttl);

describe("repo keys", () => {
  it("round-trips a key without storing its text", async () => {
    const { kv, data } = fakeKv();
    const text = generateKeyText();
    const r = await ring(kv);
    await r.put("Acme/Repo", text, "dav", 1000);
    const got = await (await ring(kv)).get("acme/repo");
    expect(got!.key.id).toBe((await parseKeyText(text)).id);
    expect(got).toMatchObject({ registeredBy: "dav", registeredAt: 1000, expiresAt: null });
    const raw = data.get("repokey:v1:acme/repo")!;
    expect(raw).not.toContain(text);
    expect(raw).not.toContain(text.slice(5));
    expect(JSON.parse(raw).key_id).toBe(got!.key.id);
  });
  it("memoizes and sees put/remove", async () => {
    const { kv, data } = fakeKv();
    const r = await ring(kv);
    await r.put("a/b", generateKeyText(), "dav", 1);
    const first = await r.get("a/b");
    data.clear();
    expect(await r.get("a/b")).toBe(first);
    await r.remove("a/b");
    expect(await r.get("a/b")).toBeNull();
  });
  it("applies the TTL setting", async () => {
    for (const [ttl, want, exp] of [[0, undefined, null], [86400, 86400, 1000 + 86400000], [10, 60, 1000 + 60000]] as const) {
      const { kv, puts } = fakeKv();
      const out = await (await ring(kv, ttl)).put("a/b", generateKeyText(), "dav", 1000);
      expect(out.expiresAt).toBe(exp);
      expect(puts[0]!.opts?.expirationTtl).toBe(want);
    }
  });
  it("returns null for another master key or another repo's slot", async () => {
    const { kv, data } = fakeKv();
    await (await ring(kv)).put("a/b", generateKeyText(), "dav", 1);
    expect(await (await ring(kv, 0, OTHER)).get("a/b")).toBeNull();
    data.set("repokey:v1:c/d", data.get("repokey:v1:a/b")!);
    expect(await (await ring(kv)).get("c/d")).toBeNull();
  });
  it("removes keys", async () => {
    const { kv, data } = fakeKv();
    const r = await ring(kv);
    await r.put("a/b", generateKeyText(), "dav", 1);
    await r.remove("a/b");
    expect(data.size).toBe(0);
  });
});

describe("records, flags, moves", () => {
  it("records persist without TTL and survive remove", async () => {
    const { kv, puts } = fakeKv();
    const r = await ring(kv);
    expect(await r.getRecord("A/B")).toBeNull();
    await r.putRecord("A/B", { repoId: "rid", keyId: "kid", enabled: true });
    expect(puts[0]!.key).toBe("repoenc:v1:a/b");
    expect(puts[0]!.opts?.expirationTtl).toBeUndefined();
    expect(JSON.parse(await kv.get("repoenc:v1:a/b") as string)).toEqual({ repo_id: "rid", key_id: "kid", enabled: true });
    await r.remove("a/b");
    expect(await r.getRecord("a/b")).toEqual({ repoId: "rid", keyId: "kid", enabled: true });
  });
  it("switching flag has a 300 s TTL", async () => {
    const { kv, puts } = fakeKv();
    const r = await ring(kv);
    expect(await r.isSwitching("a/b")).toBe(false);
    await r.setSwitching("a/b");
    expect(puts[0]).toMatchObject({ key: "switching:v1:a/b", opts: { expirationTtl: 300 } });
    expect(await r.isSwitching("A/B")).toBe(true);
    await r.clearSwitching("a/b");
    expect(await r.isSwitching("a/b")).toBe(false);
  });
  it("moves round-trip and clear", async () => {
    const { kv, puts } = fakeKv();
    const r = await ring(kv);
    expect(await r.getMove("a/b")).toBeNull();
    await r.setMove("a/b", "c/d", "rid");
    expect(puts[0]!.opts?.expirationTtl).toBeUndefined();
    expect(await r.getMove("a/b")).toEqual({ to: "c/d", repoId: "rid" });
    await r.clearMove("a/b");
    expect(await r.getMove("a/b")).toBeNull();
  });
});

describe("wrapText", () => {
  it("round-trips and binds the AAD and master", async () => {
    const { kv } = fakeKv();
    const r = await ring(kv);
    const s = await r.wrapText("secret", "aad1");
    expect(s).not.toContain("secret");
    expect(await r.unwrapText(s, "aad1")).toBe("secret");
    expect(await r.unwrapText(s, "aad2")).toBeNull();
    expect(await (await ring(kv, 0, OTHER)).unwrapText(s, "aad1")).toBeNull();
  });
});

describe("fromEnv", () => {
  const base = { OAUTH_KV: fakeKv().kv } as never;
  it("is null without the secret", async () => {
    expect(await KeyRing.fromEnv(base)).toBeNull();
  });
  it("builds with the secret and rejects a malformed one", async () => {
    expect(await KeyRing.fromEnv({ OAUTH_KV: fakeKv().kv, MEMORY_MASTER_KEY: MASTER, REPO_KEY_TTL_SECONDS: "86400" } as never)).toBeInstanceOf(KeyRing);
    await expect(KeyRing.fromEnv({ OAUTH_KV: fakeKv().kv, MEMORY_MASTER_KEY: "nope" } as never)).rejects.toThrow();
  });
});
