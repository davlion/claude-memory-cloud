import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type MemoryType = "user" | "feedback" | "project" | "reference";
const TYPES: readonly MemoryType[] = ["user", "feedback", "project", "reference"];

export interface Memory { name: string; description: string; type: MemoryType; body: string }
export interface IndexEntry { name: string; description: string }

export class MemoryFormatError extends Error {}

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const isValidName = (name: string) => NAME_RE.test(name);

export function parseMemory(text: string): Memory {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, "\n"));
  if (!m) throw new MemoryFormatError("missing frontmatter");
  let fm: Record<string, unknown>;
  try {
    fm = (parseYaml(m[1] ?? "") ?? {}) as Record<string, unknown>;
  } catch (e) {
    throw new MemoryFormatError(`invalid frontmatter: ${(e as Error).message}`);
  }
  const name = fm.name;
  const description = fm.description;
  if (typeof name !== "string" || !isValidName(name)) throw new MemoryFormatError("invalid or missing name");
  if (typeof description !== "string" || !description.trim()) throw new MemoryFormatError("missing description");
  const meta = fm.metadata as Record<string, unknown> | undefined;
  const rawType = meta?.type ?? fm.type ?? "reference";
  if (typeof rawType !== "string" || !TYPES.includes(rawType as MemoryType)) {
    throw new MemoryFormatError(`invalid type: ${String(rawType)}`);
  }
  return { name, description, type: rawType as MemoryType, body: (m[2] ?? "").replace(/^\n/, "") };
}

export function serializeMemory(mem: Memory): string {
  const fm = stringifyYaml(
    { name: mem.name, description: mem.description, metadata: { type: mem.type } },
    { lineWidth: 0 },
  );
  const body = mem.body.endsWith("\n") ? mem.body : `${mem.body}\n`;
  return `---\n${fm}---\n\n${body}`;
}

export const memoryPath = (name: string) => `memories/${name}.md`;

export function conflictPath(name: string, now: Date): string {
  const ts = now.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
  return `memories/${name}.conflict-${ts}.md`;
}

const PATH_RE = /^memories\/([a-z0-9][a-z0-9-]{0,63})(\.conflict-\d{8}T\d{6}Z)?\.md$/;
export function parseMemoryPath(path: string): { name: string; conflict: boolean } | null {
  const m = PATH_RE.exec(path);
  return m && m[1] ? { name: m[1], conflict: Boolean(m[2]) } : null;
}

export function buildIndex(label: string, entries: IndexEntry[], conflictPaths: string[]): string {
  const lines = [`# Memory index — ${label}`, ""];
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  if (sorted.length === 0) lines.push("(no memories yet)");
  for (const e of sorted) lines.push(`- [${e.name}](${memoryPath(e.name)}) — ${e.description}`);
  if (conflictPaths.length > 0) {
    lines.push("", "## Conflicts");
    for (const p of [...conflictPaths].sort()) {
      const parsed = parseMemoryPath(p);
      lines.push(`- ${p} — reconcile with ${parsed?.name ?? "?"}.md`);
    }
  }
  return `${lines.join("\n")}\n`;
}

const STOP = new Set(["the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "be", "with", "we", "i"]);
function tokens(e: IndexEntry): Set<string> {
  const words = `${e.name.replace(/-/g, " ")} ${e.description}`.toLowerCase().split(/[^a-z0-9]+/);
  return new Set(words.filter((w) => w.length > 1 && !STOP.has(w)));
}

export function findSimilar(c: IndexEntry, existing: IndexEntry[], threshold = 0.5, limit = 3): IndexEntry[] {
  const ct = tokens(c);
  return existing
    .filter((e) => e.name !== c.name)
    .map((e) => {
      const et = tokens(e);
      const inter = [...ct].filter((t) => et.has(t)).length;
      const union = new Set([...ct, ...et]).size;
      return { e, score: union === 0 ? 0 : inter / union };
    })
    .filter((x) => x.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}
