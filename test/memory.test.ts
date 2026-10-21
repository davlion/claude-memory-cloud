import { describe, expect, it } from "vitest";
import {
  buildIndex, cleanDescription, conflictPath, findSimilar, isValidName, MAX_DESCRIPTION, MemoryFormatError,
  memoryPath, namesOnlyIndex, parseMemory, parseMemoryPath, serializeMemory, type Memory,
} from "../src/memory";

const sample: Memory = {
  name: "debugging-discipline",
  description: "Measure first; question failed theories",
  type: "feedback",
  body: "Measure before theorizing.\n**Why:** wasted hours.\n",
};

describe("names", () => {
  it.each(["a", "debugging-discipline", "x1-2", "a".repeat(64)])("valid %s", (n) => expect(isValidName(n)).toBe(true));
  it.each(["", "-a", "A", "a_b", "a.b", "a".repeat(65), "a/b"])("invalid %s", (n) => expect(isValidName(n)).toBe(false));
});

describe("parse/serialize", () => {
  it("round-trips", () => {
    expect(parseMemory(serializeMemory(sample))).toEqual(sample);
  });

  it("serializes in the auto-memory layout", () => {
    expect(serializeMemory(sample)).toBe(
      "---\nname: debugging-discipline\ndescription: Measure first; question failed theories\nmetadata:\n  type: feedback\n---\n\nMeasure before theorizing.\n**Why:** wasted hours.\n",
    );
  });

  it("accepts legacy top-level type and ignores extra keys", () => {
    const text = "---\nname: old-one\ndescription: legacy\ntype: project\noriginSessionId: abc\n---\n\nbody\n";
    expect(parseMemory(text)).toEqual({ name: "old-one", description: "legacy", type: "project", body: "body\n" });
  });

  it("defaults missing type to reference", () => {
    expect(parseMemory("---\nname: x\ndescription: d\n---\nb").type).toBe("reference");
  });

  it.each([
    ["no frontmatter", "just text"],
    ["missing name", "---\ndescription: d\n---\nb"],
    ["bad name", "---\nname: Bad Name\ndescription: d\n---\nb"],
    ["missing description", "---\nname: x\n---\nb"],
    ["bad type", "---\nname: x\ndescription: d\nmetadata:\n  type: nope\n---\nb"],
  ])("rejects %s", (_label, text) => {
    expect(() => parseMemory(text)).toThrow(MemoryFormatError);
  });
});

describe("paths", () => {
  it("memoryPath", () => expect(memoryPath("abc")).toBe("memories/abc.md"));
  it("conflictPath", () =>
    expect(conflictPath("abc", new Date("2026-10-13T18:04:05.123Z"))).toBe("memories/abc.conflict-20261013T180405Z.md"));
  it("conflictPath with a collision suffix, and parseMemoryPath accepts it", () => {
    expect(conflictPath("abc", new Date("2026-10-13T18:04:05.123Z"), 2)).toBe("memories/abc.conflict-20261013T180405Z-2.md");
    expect(parseMemoryPath("memories/abc.conflict-20261013T180405Z-2.md")).toEqual({ name: "abc", conflict: true });
    expect(parseMemoryPath("memories/abc.conflict-20261013T180405Z-x.md")).toBeNull();
  });
  it("parseMemoryPath", () => {
    expect(parseMemoryPath("memories/abc.md")).toEqual({ name: "abc", conflict: false });
    expect(parseMemoryPath("memories/abc.conflict-20261013T180405Z.md")).toEqual({ name: "abc", conflict: true });
    expect(parseMemoryPath("MEMORY.md")).toBeNull();
    expect(parseMemoryPath("memories/sub/abc.md")).toBeNull();
    expect(parseMemoryPath("memories/Bad.md")).toBeNull();
  });
});

describe("buildIndex", () => {
  it("lists entries sorted by name, without a conflicts section when none", () => {
    const out = buildIndex("general", [
      { name: "zeta", description: "last" },
      { name: "alpha", description: "first" },
    ], []);
    expect(out).toBe(
      "# Memory index — general\n\n- [alpha](memories/alpha.md) — first\n- [zeta](memories/zeta.md) — last\n",
    );
  });

  it("adds a conflicts section", () => {
    const out = buildIndex("project billing", [{ name: "a", description: "d" }], ["memories/a.conflict-20261013T180405Z.md"]);
    expect(out).toContain("## Conflicts\n- memories/a.conflict-20261013T180405Z.md — reconcile with a.md\n");
  });

  it("handles empty sets", () => {
    expect(buildIndex("general", [], [])).toBe("# Memory index — general\n\n(no memories yet)\n");
  });

  it("keeps a multi-line description on one line and cannot forge a conflicts heading", () => {
    const out = buildIndex("general", [{ name: "a", description: "line one\n## Conflicts\nline two" }], []);
    const lines = out.split("\n");
    expect(lines.filter((l) => l.startsWith("- [a]("))).toHaveLength(1);
    expect(out).toContain("- [a](memories/a.md) — line one ## Conflicts line two\n");
    expect(lines.filter((l) => l === "## Conflicts")).toHaveLength(0);
  });
});

describe("findSimilar", () => {
  const existing = [
    { name: "debugging-discipline", description: "Measure first; question failed theories" },
    { name: "prefers-concise-answers", description: "User wants short answers" },
  ];
  it("finds near-duplicates", () => {
    const r = findSimilar({ name: "debugging-rules", description: "measure first, question failed theories" }, existing);
    expect(r.map((e) => e.name)).toEqual(["debugging-discipline"]);
  });
  it("ignores unrelated", () => {
    expect(findSimilar({ name: "deploy-tuesdays", description: "Acme deploys on Tuesdays" }, existing)).toEqual([]);
  });
  it("excludes an identical name (that is 'exists', not 'similar')", () => {
    expect(findSimilar({ name: "debugging-discipline", description: "x" }, existing)).toEqual([]);
  });
});

describe("cleanDescription", () => {
  it("one line, no fences, no leading heading marks", () =>
    expect(cleanDescription("## Title\n```js\nrun()\n```\n  tail")).toBe("Title js run() tail"));
  it("caps at 200 characters with an ellipsis", () => {
    const out = cleanDescription("x".repeat(500));
    expect(out).toHaveLength(MAX_DESCRIPTION);
    expect(out.endsWith("…")).toBe(true);
  });
  it("buildIndex applies it", () =>
    expect(buildIndex("general", [{ name: "a", description: `### ${"y".repeat(300)}` }], [])).toContain(`— ${"y".repeat(199)}…\n`));
});

describe("namesOnlyIndex", () => {
  it("drops descriptions but keeps the heading and Conflicts", () => {
    const idx = buildIndex("billing", [{ name: "a", description: "secret thing" }], ["memories/a.conflict-20261020T101010Z.md"]);
    const out = namesOnlyIndex(idx);
    expect(out).toContain("# Memory index — billing");
    expect(out).toContain("- [a](memories/a.md)\n");
    expect(out).not.toContain("secret thing");
    expect(out).toContain("## Conflicts");
    expect(out).toContain("- memories/a.conflict-20261020T101010Z.md — reconcile with a.md");
  });
});
