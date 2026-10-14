import { OpError } from "./errors";
import {
  buildIndex, conflictPath, findSimilar, isValidName, memoryPath, MemoryFormatError,
  parseMemory, parseMemoryPath, serializeMemory, type IndexEntry, type Memory,
} from "./memory";
import type { Target } from "./scopes";
import { scanForSecrets } from "./secrets";
import type { Change, Snapshot, Store } from "./store";

export const MAX_ATTEMPTS = 3;
const TYPES = ["user", "feedback", "project", "reference"];

export interface SaveInput { name: string; description: string; type: string; body: string; version?: string; force?: boolean; source?: string }
export interface OpResult {
  status: "created" | "updated" | "conflict" | "exists" | "similar_found" | "rejected_secret" | "invalid" | "not_found" | "deleted";
  name: string; scope: string; commit_url?: string; similar?: IndexEntry[]; conflict_file?: string; pattern?: string; version?: string; message?: string;
}

function entries(snap: Snapshot): { list: IndexEntry[]; conflicts: string[] } {
  const list: IndexEntry[] = [];
  const conflicts: string[] = [];
  for (const [path, f] of snap.files) {
    const p = parseMemoryPath(path);
    if (!p) continue;
    if (p.conflict) { conflicts.push(path); continue; }
    try {
      const m = parseMemory(f.content);
      list.push({ name: p.name, description: m.description });
    } catch {
      list.push({ name: p.name, description: "(unparseable frontmatter — fix by hand)" });
    }
  }
  return { list, conflicts };
}

/** Index after applying `changes` to `snap`. */
function indexAfter(t: Target, snap: Snapshot, changes: Change[]): string {
  const next = new Map(snap.files);
  for (const c of changes) {
    if (c.content === null) next.delete(c.path);
    else next.set(c.path, { path: c.path, sha: "", content: c.content });
  }
  const { list, conflicts } = entries({ ...snap, files: next });
  return buildIndex(t.displayLabel, list, conflicts);
}

const cleanSource = (source?: string) => (source ?? "").replace(/\s+/g, " ").trim().slice(0, 100).trim() || "unknown";

const message = (op: string, name: string, t: Target, source?: string) =>
  `${op}: ${name}\n\nMemory-Source: ${cleanSource(source)}\nMemory-Scope: ${t.scopeLabel}\n`;

/** Runs `decide` against fresh snapshots, committing its changes; retries on ref races. */
async function withRetry(
  store: Store, t: Target,
  decide: (snap: Snapshot) => { result: OpResult; changes?: Change[]; op?: string; source?: string },
): Promise<OpResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const snap = await store.snapshot(t.repo, t.prefix);
    if (!snap.isPrivate) {
      throw new OpError("repo_public", `${t.repo} is public, so anyone can read these memories. Not saved.`,
        `Make ${t.repo} private: repo Settings → General → Danger Zone → Change visibility. Then save again.`);
    }
    const d = decide(snap);
    if (!d.changes) return d.result;
    const changes = [...d.changes, { path: "MEMORY.md", content: indexAfter(t, snap, d.changes) }];
    const res = await store.commit(t.repo, t.prefix, snap.commitSha, changes, message(d.op!, d.result.name, t, d.source));
    if (res.ok) return { ...d.result, commit_url: res.url };
  }
  throw new OpError("unavailable", `could not commit after ${MAX_ATTEMPTS} attempts (concurrent writes)`, "Try again in a moment.");
}

export async function saveMemory(store: Store, t: Target, input: SaveInput, now = new Date()): Promise<OpResult> {
  const r = (status: OpResult["status"], extra: Partial<OpResult> = {}): OpResult => ({ status, name: input.name, scope: t.displayLabel, ...extra });
  if (!isValidName(input.name)) return r("invalid", { message: "name must match ^[a-z0-9][a-z0-9-]{0,63}$" });
  if (!TYPES.includes(input.type)) return r("invalid", { message: `type must be one of ${TYPES.join(", ")}` });
  if (!input.description?.trim()) return r("invalid", { message: "description is required" });
  if (!input.body?.trim()) return r("invalid", { message: "body is required" });
  const pattern = scanForSecrets(`${input.name}\n${input.description}\n${input.body}`);
  if (pattern) return r("rejected_secret", { pattern, message: "Remove the credential and save again." });

  const mem: Memory = { name: input.name, description: input.description, type: input.type as Memory["type"], body: input.body };
  let content: string;
  try { content = serializeMemory(mem); parseMemory(content); }
  catch (e) { return r("invalid", { message: (e as MemoryFormatError).message }); }
  const path = memoryPath(input.name);

  return withRetry(store, t, (snap) => {
    const existing = snap.files.get(path);
    if (input.version === undefined) {
      if (existing) return { result: r("exists", { version: existing.sha, message: "Read it and update with its version instead." }) };
      if (!input.force) {
        const similar = findSimilar({ name: input.name, description: input.description }, entries(snap).list);
        if (similar.length) return { result: r("similar_found", { similar, message: "Update one of these, or save again with force: true." }) };
      }
      return { result: r("created"), changes: [{ path, content }], op: "save", source: input.source };
    }
    if (!existing) return { result: r("not_found") };
    if (existing.sha === input.version) return { result: r("updated"), changes: [{ path, content }], op: "update", source: input.source };
    const cpath = conflictPath(input.name, now);
    return { result: r("conflict", { conflict_file: cpath, message: "The memory changed since you read it; your version was saved as a conflict copy. Reconcile them." }),
      changes: [{ path: cpath, content }], op: "conflict", source: input.source };
  });
}

export async function deleteMemory(store: Store, t: Target, name: string, version?: string, source?: string, _now = new Date()): Promise<OpResult> {
  const path = `memories/${name}.md`;
  const r = (status: OpResult["status"], extra: Partial<OpResult> = {}): OpResult => ({ status, name, scope: t.displayLabel, ...extra });
  if (!parseMemoryPath(path)) return r("invalid", { message: "invalid memory name" });
  return withRetry(store, t, (snap) => {
    const existing = snap.files.get(path);
    if (!existing) return { result: r("not_found") };
    if (version !== undefined && existing.sha !== version) return { result: r("conflict", { version: existing.sha, message: "Changed since you read it; re-read before deleting." }) };
    return { result: r("deleted"), changes: [{ path, content: null }], op: "delete", source };
  });
}

export async function readMemories(store: Store, t: Target, names: string[]) {
  const snap = await store.snapshot(t.repo, t.prefix);
  return names.map((name) => {
    const f = snap.files.get(`memories/${name}.md`);
    return f ? { name, content: f.content, version: f.sha } : { name, error: "not_found" as const };
  });
}

export async function getIndexVersioned(store: Store, t: Target): Promise<{ text: string; version: string }> {
  const snap = await store.snapshot(t.repo, t.prefix);
  const stored = snap.files.get("MEMORY.md");
  if (stored) return { text: stored.content, version: stored.sha };
  const { list, conflicts } = entries(snap);
  return { text: buildIndex(t.displayLabel, list, conflicts), version: "none" };
}

export async function getIndex(store: Store, t: Target): Promise<string> {
  return (await getIndexVersioned(store, t)).text;
}

export async function searchMemories(store: Store, targets: Target[], query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const out: { scope: string; name: string; description: string; snippet: string }[] = [];
  for (const t of targets) {
    const snap = await store.snapshot(t.repo, t.prefix);
    for (const [path, f] of snap.files) {
      const p = parseMemoryPath(path);
      if (!p || p.conflict) continue;
      let description = "";
      let searchable = f.content;
      try {
        const m = parseMemory(f.content);
        description = m.description;
        searchable = `${m.name}\n${m.description}\n${m.body}`;
      } catch { /* unparseable: search the raw content */ }
      const lower = searchable.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      const at = Math.max(0, f.content.toLowerCase().indexOf(terms[0] ?? "") - 40);
      out.push({ scope: t.displayLabel, name: p.name, description, snippet: f.content.slice(at, at + 120).replace(/\s+/g, " ").trim() });
      if (out.length >= 20) return out;
    }
  }
  return out;
}
