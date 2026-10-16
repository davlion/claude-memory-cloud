import { OpError, RETRYABLE, type ErrorCode } from "./errors";
import { toOpError } from "./github";
import { scanCrossClient, scanPersonal } from "./guard";
import {
  buildIndex, cleanDescription, conflictPath, findSimilar, isValidName, MAX_BODY, MAX_DESCRIPTION, memoryPath, MemoryFormatError,
  parseMemory, parseMemoryPath, serializeMemory, type IndexEntry, type Memory,
} from "./memory";
import type { Target } from "./scopes";
import { scanForSecrets } from "./secrets";
import type { Change, HeadCommit, Snapshot, Store } from "./store";

export const MAX_ATTEMPTS = 3;
const UNREADABLE_MESSAGE = "This file is binary, truncated or otherwise can't be read as text by the memory server.";
const TYPES = ["user", "feedback", "project", "reference"];

export interface SaveInput { name: string; description: string; type: string; body: string; version?: string; force?: boolean; confirmed?: boolean; source?: string }
/** Where a save lands, for the personal/cross-client guard. `others` are the other clients' scope names and owner logins. */
export interface GuardContext { kind: "general" | "client" | "project"; others: { scope: string; owner: string }[] }
export interface OpResult {
  status: "created" | "updated" | "conflict" | "exists" | "similar_found" | "rejected_secret" | "rejected_personal" | "needs_confirmation" | "rejected_cross_client" | "invalid" | "not_found" | "deleted";
  name: string; scope: string; commit_url?: string; similar?: IndexEntry[]; conflict_file?: string; pattern?: string; category?: string; client?: string; version?: string; message?: string;
}

export interface SearchHit { scope: string; name: string; description: string; snippet: string }
export interface IndexResult { text: string; version: string; head: HeadCommit | null; /** Names of memories that look personal (restricted, or candid in a client/project scope). Names only. */ flagged: string[] }
export interface ScopeFailure { scope: string; error: ErrorCode; message: string; action?: string; retryable: boolean }

export function scopeFailure(scope: string, e: unknown): ScopeFailure {
  const err = toOpError(e);
  return { scope, error: err.code, message: err.message, action: err.action, retryable: RETRYABLE.has(err.code) };
}

function entries(snap: Snapshot): { list: IndexEntry[]; conflicts: string[] } {
  const list: IndexEntry[] = [];
  const conflicts: string[] = [];
  for (const [path, f] of snap.files) {
    const p = parseMemoryPath(path);
    if (!p) continue;
    if (p.conflict) { conflicts.push(path); continue; }
    if (f.unreadable) continue; // binary, truncated or missing text: not indexed, and never overwritten blind
    try {
      const m = parseMemory(f.content);
      list.push({ name: p.name, description: cleanDescription(m.description) });
    } catch {
      list.push({ name: p.name, description: "(unparseable frontmatter — fix by hand)" });
    }
  }
  return { list, conflicts };
}

/** Memories (by name) whose text the personal guard flags: restricted anywhere, candid in client/project scopes. Unreadable files and conflict copies are skipped. */
function flaggedNames(snap: Snapshot, kind: GuardContext["kind"]): string[] {
  const out: string[] = [];
  for (const [path, f] of snap.files) {
    const p = parseMemoryPath(path);
    if (!p || p.conflict || f.unreadable) continue;
    let text: string;
    try { const m = parseMemory(f.content); text = `${p.name}\n${m.description}\n${m.body}`; } catch { text = `${p.name}\n${f.content}`; }
    const hit = scanPersonal(text);
    if (hit && (hit.tier === "restricted" || kind !== "general")) out.push(p.name);
  }
  return out;
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
      throw new OpError("repo_public", `${t.repo} is not private (public or internal), so people outside its access list can read these memories. Not saved.`,
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

export async function saveMemory(store: Store, t: Target, input: SaveInput, now: Date, guard: GuardContext): Promise<OpResult> {
  const r = (status: OpResult["status"], extra: Partial<OpResult> = {}): OpResult => ({ status, name: input.name, scope: t.displayLabel, ...extra });
  const description = (input.description ?? "").replace(/\s+/g, " ").trim();
  if (!isValidName(input.name)) return r("invalid", { message: "name must match ^[a-z0-9][a-z0-9-]{0,63}$" });
  if (!TYPES.includes(input.type)) return r("invalid", { message: `type must be one of ${TYPES.join(", ")}` });
  if (!description) return r("invalid", { message: "description is required" });
  if (description.length > MAX_DESCRIPTION) return r("invalid", { message: `description must be at most ${MAX_DESCRIPTION} characters on one line; put details in the body` });
  if (!input.body?.trim()) return r("invalid", { message: "body is required" });
  if (input.body.length > MAX_BODY) return r("invalid", { message: `body must be at most ${MAX_BODY} characters; split it into several memories` });
  const pattern = scanForSecrets(`${input.name}\n${description}\n${input.body}\n${input.source ?? ""}`);
  if (pattern) return r("rejected_secret", { pattern, message: "Remove the credential and save again." });

  // Runs on every write (create, update, conflict copy); `force` does not bypass it. Results carry a category, never the matched text.
  const scanned = `${input.name}\n${description}\n${input.body}`;
  const hit = scanPersonal(scanned);
  if (hit) {
    if (hit.tier === "restricted" || guard.kind !== "general") {
      return r("rejected_personal", { category: hit.category, message: "Personal facts aren't stored on GitHub; keep it in claude.ai memory." });
    }
    if (!input.confirmed) {
      return r("needs_confirmation", { category: hit.category, message: "Ask the user; save again with confirmed: true only if they explicitly want it kept in general." });
    }
  }
  if (guard.kind !== "general" && guard.others.length) {
    const client = scanCrossClient(scanned, guard.others);
    if (client) return r("rejected_cross_client", { client, message: `This names another client (${client}); memories stay within their own client's scope.` });
  }

  const mem: Memory = { name: input.name, description, type: input.type as Memory["type"], body: input.body };
  let content: string;
  try { content = serializeMemory(mem); parseMemory(content); }
  catch (e) { return r("invalid", { message: (e as MemoryFormatError).message }); }
  const path = memoryPath(input.name);

  return withRetry(store, t, (snap) => {
    const existing = snap.files.get(path);
    if (existing?.unreadable) {
      throw new OpError("write_rejected", `${memoryPath(input.name)} is unreadable to the memory server (binary or truncated), so it is not overwritten. Not saved.`,
        `Edit this file on GitHub: https://github.com/${t.repo}/blob/HEAD/${t.prefix}${memoryPath(input.name)}`);
    }
    if (input.version === undefined) {
      if (existing) return { result: r("exists", { version: existing.sha, message: "Read it and update with its version instead." }) };
      if (!input.force) {
        const similar = findSimilar({ name: input.name, description }, entries(snap).list);
        if (similar.length) return { result: r("similar_found", { similar, message: "Update one of these, or save again with force: true." }) };
      }
      return { result: r("created"), changes: [{ path, content }], op: "save", source: input.source };
    }
    if (!existing) return { result: r("not_found") };
    if (existing.sha === input.version) return { result: r("updated"), changes: [{ path, content }], op: "update", source: input.source };
    // Conflict copies never overwrite each other: add a suffix when two land in the same second.
    let n = 1;
    let cpath = conflictPath(input.name, now);
    while (snap.files.has(cpath)) cpath = conflictPath(input.name, now, ++n);
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
    if (!f) return { name, error: "not_found" as const };
    if (f.unreadable) return { name, error: "unreadable" as const, message: UNREADABLE_MESSAGE };
    return { name, content: f.content, version: f.sha };
  });
}

/**
 * The index is always rebuilt from the memory files' frontmatter; the stored MEMORY.md is never served
 * (spec §10b: a hand edit can't inject text). The version is the SHA-1 of the rebuilt text, so a hand-edited
 * memory changes it even when MEMORY.md is untouched ("none" for a set with no memories).
 */
export async function getIndexVersioned(store: Store, t: Target, kind: GuardContext["kind"] = "general"): Promise<IndexResult> {
  const snap = await store.snapshot(t.repo, t.prefix);
  const { list, conflicts } = entries(snap);
  const text = buildIndex(t.displayLabel, list, conflicts);
  return { text, version: snap.files.size === 0 ? "none" : await sha1Hex(text), head: snap.head, flagged: flaggedNames(snap, kind) };
}

async function sha1Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function getIndex(store: Store, t: Target): Promise<string> {
  return (await getIndexVersioned(store, t)).text;
}

export async function searchMemories(store: Store, targets: Target[], query: string): Promise<{ results: SearchHit[]; failures: ScopeFailure[] }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const results: SearchHit[] = [];
  const failures: ScopeFailure[] = [];
  for (const t of targets) {
    let snap: Snapshot;
    try {
      snap = await store.snapshot(t.repo, t.prefix);
    } catch (e) {
      failures.push(scopeFailure(t.displayLabel, e));
      continue;
    }
    for (const [path, f] of snap.files) {
      const p = parseMemoryPath(path);
      if (!p || p.conflict || f.unreadable) continue;
      let description = "";
      let searchable = f.content;
      try {
        const m = parseMemory(f.content);
        description = cleanDescription(m.description);
        searchable = `${m.name}\n${m.description}\n${m.body}`;
      } catch { /* unparseable: search the raw content */ }
      const lower = searchable.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      const at = Math.max(0, f.content.toLowerCase().indexOf(terms[0] ?? "") - 40);
      results.push({ scope: t.displayLabel, name: p.name, description, snippet: f.content.slice(at, at + 120).replace(/\s+/g, " ").trim() });
      if (results.length >= 20) return { results, failures };
    }
  }
  return { results, failures };
}
