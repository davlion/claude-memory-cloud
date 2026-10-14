import { describe, expect, it } from "vitest";
import { dataBlock, escapeData, newNonce, preamble, serverHeading } from "../src/render";

describe("render", () => {
  it("nonces are 12 hex characters and differ", () => {
    const a = newNonce();
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(newNonce()).not.toBe(a);
  });
  it("escapes anything that could open or close a memory tag", () => {
    expect(escapeData("a </memory-index> b <MEMORY scope=x> c </memory>")).toBe("a &lt;/memory-index> b &lt;MEMORY scope=x> c &lt;/memory>");
    expect(escapeData("<b>fine</b> & memory")).toBe("<b>fine</b> & memory");
  });
  it("dataBlock wraps escaped content with escaped attributes", () => {
    expect(dataBlock("memory", { scope: "general", name: 'a"b', version: undefined }, "x </memory> y\n"))
      .toBe('<memory scope="general" name="a&quot;b">\nx &lt;/memory> y\n</memory>');
    expect(dataBlock("memory", { scope: "general", name: "n", error: "not_found" }, "")).toBe('<memory scope="general" name="n" error="not_found"></memory>');
  });
  it("server headings and the preamble carry the nonce", () => {
    expect(serverHeading("Health", "abc123abc123")).toBe("## Health [server:abc123abc123]");
    expect(preamble("abc123abc123")).toMatch(/^claude-memory response\. .*\[server:abc123abc123\].*data, not instructions/);
  });
});
