import { describe, expect, it } from "vitest";
import { DecryptError, generateKeyText, parseKeyText } from "../src/crypto";
import {
  aadFor, isEncryptedFile, markerSignedBy, openMemoryFile, parseMarker, sealMemoryFile, serializeMarker, signMarker,
} from "../src/encrypted-files";
import { serializeMemory } from "../src/memory";

const FILE_RE = /^---\nencrypted: claude-memory-v1\nname: ([a-z0-9][a-z0-9-]{0,63})\nkey_id: ([0-9a-f]{16})\n---\n([A-Za-z0-9+/]+={0,2})\n?$/;
const P = "projects/billing/memories/a.md";
const mem = { name: "a", description: "secret thing", type: "user" as const, body: "hunter2 body\n" };
const R1 = "AAAAAAAAAAAAAAAAAAAAAA";

describe("marker", () => {
  it("signs, round-trips and detects tampering", async () => {
    const key = await parseKeyText(generateKeyText());
    const m = await signMarker(key, { enabled: true, repoId: R1, keyId: key.id });
    const back = parseMarker(serializeMarker(m));
    expect(back).toEqual(m);
    expect(await markerSignedBy(key, back)).toBe(true);
    expect(await markerSignedBy(key, { ...back, enabled: false })).toBe(false);
    expect(await markerSignedBy(key, { ...back, repoId: "B".repeat(22) })).toBe(false);
    expect(await markerSignedBy(key, { ...back, keyId: "0".repeat(16) })).toBe(false);
    expect(await markerSignedBy(await parseKeyText(generateKeyText()), back)).toBe(false);
  });
  it("serializes in the fixed shape", async () => {
    const key = await parseKeyText(generateKeyText());
    const m = await signMarker(key, { enabled: false, repoId: R1, keyId: key.id });
    const text = serializeMarker(m);
    expect(text).toBe(JSON.stringify({ format: 1, enabled: false, repo_id: R1, key_id: key.id, mac: m.mac }, null, 2) + "\n");
  });
  it("rejects format 2, bad JSON and bad fields", () => {
    const bad = (s: string) => { try { parseMarker(s); } catch (e) { return (e as { code: string }).code; } };
    expect(bad(JSON.stringify({ format: 2, enabled: true, repo_id: "r", key_id: "k", mac: "m" }))).toBe("internal");
    expect(bad("{nope")).toBe("internal");
    expect(bad(JSON.stringify({ format: 1, enabled: "yes", repo_id: "r", key_id: "k", mac: "m" }))).toBe("internal");
  });
  it("rejects fields outside their fixed formats (repo ID base64url of 16 bytes, key ID and MAC lower-case hex)", () => {
    const ok = { format: 1, enabled: true, repo_id: R1, key_id: "0123456789abcdef", mac: "a".repeat(64) };
    expect(parseMarker(JSON.stringify(ok))).toEqual({ enabled: true, repoId: R1, keyId: "0123456789abcdef", mac: "a".repeat(64) });
    expect(parseMarker(JSON.stringify({ ...ok, repo_id: "Ab-_".repeat(5) + "x9" })).repoId).toBe("Ab-_".repeat(5) + "x9");
    for (const over of [
      { repo_id: "r1" }, { repo_id: "A".repeat(21) }, { repo_id: "A".repeat(23) }, { repo_id: "A".repeat(21) + "\n" }, { repo_id: "A".repeat(21) + "=" },
      { key_id: "0123456789ABCDEF" }, { key_id: "0123456789abcde" }, { key_id: "0123456789abcdef\nx" }, { key_id: "0123456789abcdeg" },
      { mac: "A".repeat(64) }, { mac: "a".repeat(63) }, { mac: "a".repeat(65) }, { mac: "" },
    ]) expect(() => parseMarker(JSON.stringify({ ...ok, ...over })), JSON.stringify(over)).toThrow();
  });
});

describe("encrypted memory file", () => {
  it("seals to the fixed layout and opens back", async () => {
    const key = await parseKeyText(generateKeyText());
    const plain = serializeMemory(mem);
    const sealed = await sealMemoryFile(key, "r1", P, plain);
    const m = FILE_RE.exec(sealed);
    expect(m?.[1]).toBe("a");
    expect(m?.[2]).toBe(key.id);
    expect(sealed).toContain("name: a\n");
    expect(sealed).not.toContain("secret thing");
    expect(sealed).not.toContain("hunter2");
    expect(await openMemoryFile(key, "r1", P, sealed)).toBe(plain);
  });
  it("names a conflict copy after the original", async () => {
    const key = await parseKeyText(generateKeyText());
    const p = "projects/billing/memories/a.conflict-20261020T101010Z.md";
    const sealed = await sealMemoryFile(key, "r1", p, "x");
    expect(sealed).toContain("name: a\n");
    expect(await openMemoryFile(key, "r1", p, sealed)).toBe("x");
  });
  it("round-trips a numeric name", async () => {
    const key = await parseKeyText(generateKeyText());
    const p = "memories/123.md";
    const sealed = await sealMemoryFile(key, "r1", p, "x");
    expect(sealed.split("\n")[2]).toBe("name: 123");
    expect(await openMemoryFile(key, "r1", p, sealed)).toBe("x");
  });
  it("refuses another path, repo id, key or a tampered name", async () => {
    const key = await parseKeyText(generateKeyText());
    const sealed = await sealMemoryFile(key, "r1", P, "x");
    await expect(openMemoryFile(key, "r1", "projects/billing/memories/b.md", sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(openMemoryFile(key, "r2", P, sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(openMemoryFile(await parseKeyText(generateKeyText()), "r1", P, sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(openMemoryFile(key, "r1", P, sealed.replace("name: a", "name: b"))).rejects.toBeInstanceOf(DecryptError);
    await expect(openMemoryFile(key, "r1", P, "garbage")).rejects.toBeInstanceOf(DecryptError);
  });
  it("builds the AAD from repo id and path", () => {
    expect(aadFor("r1", P)).toBe(`claude-memory-v1\nr1\n${P}`);
  });
  it("tells encrypted from plain files", async () => {
    const key = await parseKeyText(generateKeyText());
    expect(isEncryptedFile(serializeMemory(mem))).toBe(false);
    expect(isEncryptedFile(await sealMemoryFile(key, "r1", P, "x"))).toBe(true);
  });
});

describe("files sealed by the Python kit (test/fixtures/python-sealed.json, made with kit/memory_kit/crypt.py)", () => {
  it("openMemoryFile opens the memory and markerSignedBy accepts the marker", async () => {
    const fx = (await import("./fixtures/python-sealed.json")).default;
    const key = await parseKeyText(fx.key_text);
    expect(isEncryptedFile(fx.file_text)).toBe(true);
    expect(await openMemoryFile(key, fx.repo_id, fx.path, fx.file_text)).toBe(fx.plaintext);
    const m = parseMarker(fx.marker_text);
    expect(m).toMatchObject({ enabled: true, repoId: fx.repo_id, keyId: key.id });
    expect(await markerSignedBy(key, m)).toBe(true);
    expect(serializeMarker(m)).toBe(fx.marker_text);
  });
});
