import { describe, expect, it } from "vitest";
import { DecryptError, generateKeyText, hmacHex, open, parseKeyText, parseMasterKey, newRepoId, seal } from "../src/crypto";
import vectors from "./fixtures/crypto-vectors.json";

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

describe("repo key text", () => {
  it("generates distinct cmk1_ keys", () => {
    const a = generateKeyText(), b = generateKeyText();
    expect(a).toMatch(/^cmk1_[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
  });
  it("parses with surrounding whitespace and a stable id", async () => {
    const t = generateKeyText();
    const k = await parseKeyText(" " + t + "\n");
    expect(k.id).toMatch(/^[0-9a-f]{16}$/);
    expect((await parseKeyText(t)).id).toBe(k.id);
  });
  it.each(["", "hello", "cmk2_" + "A".repeat(43), "cmk1_short", "cmk1_" + "A".repeat(44)])("rejects %j without echoing it", async (bad) => {
    const e = await parseKeyText(bad).catch((x) => x);
    expect(e.code).toBe("invalid");
    if (bad) expect(e.message).not.toContain(bad);
  });
});

describe("seal/open", () => {
  it("round-trips", async () => {
    const k = await parseKeyText(generateKeyText());
    expect(await open(k.fileKey, await seal(k.fileKey, "é memory", "aad"), "aad")).toBe("é memory");
  });
  it("rejects wrong aad, tampering, another key", async () => {
    const k = await parseKeyText(generateKeyText()), o = await parseKeyText(generateKeyText());
    const s = await seal(k.fileKey, "x", "aad");
    const raw = b64(s); raw[raw.length - 1]! ^= 1;
    const flipped = btoa(String.fromCharCode(...raw));
    await expect(open(k.fileKey, s, "other")).rejects.toBeInstanceOf(DecryptError);
    await expect(open(k.fileKey, flipped, "aad")).rejects.toBeInstanceOf(DecryptError);
    await expect(open(o.fileKey, s, "aad")).rejects.toBeInstanceOf(DecryptError);
    await expect(open(k.fileKey, "!!!", "aad")).rejects.toBeInstanceOf(DecryptError);
    await expect(open(k.fileKey, "AAAA", "aad")).rejects.toBeInstanceOf(DecryptError);
  });
  it("uses a fresh IV each time", async () => {
    const k = await parseKeyText(generateKeyText());
    expect(await seal(k.fileKey, "same", "a")).not.toBe(await seal(k.fileKey, "same", "a"));
  });
});

describe("misc", () => {
  it("parses master keys", async () => {
    await parseMasterKey(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))));
    await expect(parseMasterKey("abc")).rejects.toThrow("MEMORY_MASTER_KEY must be base64 of 32 bytes");
    await expect(parseMasterKey("!!!")).rejects.toThrow("MEMORY_MASTER_KEY must be base64 of 32 bytes");
  });
  it("makes repo ids", () => {
    expect(newRepoId()).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newRepoId()).not.toBe(newRepoId());
  });
});

describe("cross-implementation vectors", () => {
  it("has 3 vectors", () => expect(vectors.length).toBe(3));
  it.each(vectors.map((v, i) => [i, v] as const))("vector %i", async (_i, v) => {
    const k = await parseKeyText(v.key_text);
    expect(k.id).toBe(v.key_id);
    expect(await seal(k.fileKey, v.plaintext, v.aad, b64(v.iv_b64))).toBe(v.sealed);
    expect(await open(k.fileKey, v.sealed, v.aad)).toBe(v.plaintext);
    expect(await hmacHex(k.macKey, v.mac_message)).toBe(v.mac);
  });
});
