import { GitHub, GitHubError } from "./github";
import { toB64 } from "./crypto";
import { MARKER_PATH } from "./encrypted-files";
import { OpError } from "./errors";
import { parseMemoryPath } from "./memory";

export interface FileEntry {
  path: string; sha: string; content: string;
  /** True when GitHub couldn't give us the blob's full text (binary, truncated, or missing): content is "" and the file must not be overwritten blind. */
  unreadable?: boolean;
  /** Set only by EncryptingStore: the file is sealed and this repo's key is missing or doesn't match. */
  locked?: true;
  /** Set only by EncryptingStore: a plaintext file in an encrypted repo (the memory tool didn't write it). */
  outside?: true;
}
export interface EncryptionStatus {
  encrypted: boolean; enabled: boolean; key: "ok" | "missing" | "mismatch" | "unsupported";
  markerProblem: boolean; sealed: number; outside: number;
  /** Target repo of an in-progress fresh-repo move. */
  moving?: string;
  /** Only while moving: the old repo changed after its encrypted copy was written, so the copy lacks those changes. */
  moveStale?: boolean;
  /** The marker is the record's except for its key ID (memcrypt rotate, new key not registered yet): not a marker problem. */
  rotated?: boolean;
}
export interface HeadCommit { sha: string; message: string; author: string; date: string; url: string }
export interface Snapshot {
  commitSha: string | null;
  isPrivate: boolean;
  /** Blob SHA of the set's MEMORY.md (the index version), or null when there is none. */
  indexSha: string | null;
  /** The set's memory files (memories/<name>.md and conflict copies), keyed by path relative to the prefix. */
  files: Map<string, FileEntry>;
  /** The branch head commit, for provenance checks; null for an empty repo. */
  head: HeadCommit | null;
  /** Raw text of the repo-root encryption marker (any prefix), or null when there is none. */
  marker: string | null;
  encryption?: EncryptionStatus;
}
export interface Change { path: string; content: string | null }
/** One non-tree entry of a repo's tree. `text` only for memory files, `MEMORY.md` files and the marker; null if unreadable or not one of those. */
export interface TreeFile { path: string; mode: string; sha: string; text: string | null }
/** A file of a whole-tree write: new content, or an existing object by SHA (a commit SHA for a submodule). */
export interface TreeWrite { path: string; mode: string; sha?: string; content?: string }
export type CommitResult = { ok: true; commitSha: string; url: string } | { ok: false; reason: "ref_moved" };

export interface Store {
  snapshot(repo: string, prefix: string): Promise<Snapshot>;
  commit(repo: string, prefix: string, baseCommitSha: string | null, changes: Change[], message: string): Promise<CommitResult>;
  /** True once a cache write failed during this request (for example, Cloudflare's KV write quota). */
  readonly cacheWriteFailed?: boolean;
}

export const README = `# claude-memory

Memories for Claude, maintained by the claude-memory-cloud server.

- \`MEMORY.md\` is the index; \`memories/\` holds one file per memory; \`projects/<repo>/\` holds per-project sets.
- **Never put secrets here.** The server rejects anything that looks like a credential.
- Editing by hand is fine; the server rebuilds the index on its next write.
`;

/** Snapshot cache lifetime (spec §10b): memory text in KV lives at most a week. */
export const CACHE_TTL_SECONDS = 7 * 24 * 3600;
/** KV values max out at 25 MiB; a larger snapshot is simply not cached (that is not a KV write problem). */
export const MAX_CACHE_BYTES = 24 * 1024 * 1024;
const GRAPHQL_CHUNK = 100;
const GRAPHQL_CONCURRENCY = 2;
const OID_RE = /^[0-9a-f]{40}$/;

const encode = (s: string) => toB64(new TextEncoder().encode(s));

/**
 * Deletes the repo's cached snapshots (they can hold plaintext), ten at a time and at most `max` per call so a request stays
 * within its KV operation limit; the rest expire by TTL or go on the next call.
 */
export async function clearSnapshots(cache: KVNamespace, repo: string, max = 900): Promise<void> {
  let left = max;
  for (const prefix of new Set([`snap:v3:${repo}:`, `snap:v3:${repo.toLowerCase()}:`])) {
    let cursor: string | undefined;
    do {
      if (left <= 0) return;
      const page = await cache.list({ prefix, cursor, limit: Math.min(1000, left) });
      await mapLimit(page.keys, 10, (k) => cache.delete(k.name));
      left -= page.keys.length;
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  }
}

/** Runs fn over items with at most `limit` calls in flight; results keep the input order. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type TreeEntry = { path: string; type: string; sha: string; mode?: string };
interface CommitTree { head: HeadCommit; treeSha: string; tree: TreeEntry[] }
interface CachedSnapshot { marker: string | null; indexSha: string | null; head: HeadCommit; files: [string, string, string, boolean?][] }

/** The memory set a repo path belongs to (root "" or `projects/<repo>/`) and the path within it. */
export const splitSet = (path: string) => {
  const m = /^(projects\/[^/]+\/)?(.*)$/.exec(path)!;
  return { prefix: m[1] ?? "", rel: m[2]! };
};
const wantsText = (path: string) => {
  if (path === MARKER_PATH) return true;
  const { rel } = splitSet(path);
  return rel === "MEMORY.md" || parseMemoryPath(rel) !== null;
};

const FORCE_PUSH_ACTION =
  "A rule on the default branch blocks force pushes (branch protection or a ruleset). Ask a repo admin to allow force pushes while encryption is turned on, or use the fresh-repo path.";
const MOVED = () => new OpError("unavailable", "The memory repo changed during switch-on; nothing was changed.", "Try again.");

const isEmptyRepo = (e: unknown) =>
  e instanceof GitHubError && (e.kind === "empty_repo" || (e.kind === "not_found" && /empty/i.test(e.message)));

export class GitHubStore implements Store {
  cacheWriteFailed = false;
  /** Snapshots serialized larger than this skip the KV cache. Overridable for tests. */
  maxCacheBytes = MAX_CACHE_BYTES;
  private meta = new Map<string, Promise<{ branch: string; isPrivate: boolean; canWrite: boolean }>>();
  private heads = new Map<string, Promise<string | null>>();
  private trees = new Map<string, Promise<CommitTree>>();
  constructor(private gh: GitHub, private cache?: KVNamespace) {}

  private repoMeta(repo: string) {
    let m = this.meta.get(repo);
    if (!m) {
      // Only "private" counts: "internal" (GitHub Enterprise) is readable by every enterprise member; missing fails closed.
      m = this.gh.request<{ default_branch: string; visibility?: string; permissions?: { push?: boolean } }>("GET", `/repos/${repo}`)
        .then((r) => ({ branch: r.default_branch, isPrivate: r.visibility === "private", canWrite: r.permissions?.push === true }));
      this.meta.set(repo, m);
      m.catch(() => this.meta.delete(repo));
    }
    return m;
  }

  /** Branch head SHA, memoized until this store commits to the repo; null for an empty repo. */
  private headSha(repo: string, branch: string): Promise<string | null> {
    let p = this.heads.get(repo);
    if (!p) {
      p = this.gh.request<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${branch}`).then(
        (r) => r.object.sha,
        (e) => { if (isEmptyRepo(e)) return null; throw e; },
      );
      this.heads.set(repo, p);
      p.catch(() => this.heads.delete(repo));
    }
    return p;
  }

  /** Commit metadata and recursive tree, memoized per commit SHA (immutable). */
  private commitTree(repo: string, sha: string): Promise<CommitTree> {
    const key = `${repo}@${sha}`;
    let p = this.trees.get(key);
    if (!p) {
      p = (async () => {
        const c = await this.gh.request<{ sha: string; message: string; author?: { name?: string; date?: string }; html_url: string; tree: { sha: string } }>(
          "GET", `/repos/${repo}/git/commits/${sha}`);
        const t = await this.gh.request<{ tree: TreeEntry[]; truncated: boolean }>("GET", `/repos/${repo}/git/trees/${c.tree.sha}?recursive=1`);
        if (t.truncated) throw new GitHubError("memory repo tree too large (truncated)", 0, "other");
        return {
          head: { sha: c.sha, message: c.message, author: c.author?.name ?? "unknown", date: c.author?.date ?? "", url: c.html_url },
          treeSha: c.tree.sha,
          tree: t.tree,
        };
      })();
      this.trees.set(key, p);
      p.catch(() => this.trees.delete(key));
    }
    return p;
  }

  private async cacheGet(key: string): Promise<CachedSnapshot | null> {
    if (!this.cache) return null;
    try {
      const v = await this.cache.get(key);
      return v ? (JSON.parse(v) as CachedSnapshot) : null;
    } catch {
      return null; // best effort: a cache problem is only a cache miss
    }
  }

  private async cachePut(key: string, v: CachedSnapshot): Promise<void> {
    if (!this.cache) return;
    try {
      const body = JSON.stringify(v);
      if (new TextEncoder().encode(body).length > this.maxCacheBytes) return; // too big for KV: skip, don't flag a write failure
      await this.cache.put(key, body, { expirationTtl: CACHE_TTL_SECONDS });
    } catch {
      this.cacheWriteFailed = true;
    }
  }

  /** Text of each blob, fetched with GraphQL in chunks (one request per 100 blobs). Missing, binary or truncated blobs map to null. */
  private async texts(repo: string, shas: string[]): Promise<Map<string, string | null>> {
    const [owner, name] = repo.split("/") as [string, string];
    const valid = [...new Set(shas.filter((s) => OID_RE.test(s)))];
    const chunks: string[][] = [];
    for (let i = 0; i < valid.length; i += GRAPHQL_CHUNK) chunks.push(valid.slice(i, i + GRAPHQL_CHUNK));
    const out = new Map<string, string | null>();
    await mapLimit(chunks, GRAPHQL_CONCURRENCY, async (chunk) => {
      const fields = chunk.map((s, i) => `b${i}: object(oid: "${s}") { ... on Blob { text isBinary isTruncated } }`).join(" ");
      const data = await this.gh.graphql<{ repository: Record<string, { text?: string | null; isBinary?: boolean; isTruncated?: boolean } | null> | null }>(
        `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, { owner, name });
      chunk.forEach((s, i) => {
        const b = data.repository?.[`b${i}`];
        out.set(s, b && typeof b.text === "string" && !b.isBinary && !b.isTruncated ? b.text : null);
      });
    });
    return out;
  }

  async snapshot(repo: string, prefix: string): Promise<Snapshot> {
    const { branch, isPrivate } = await this.repoMeta(repo);
    const commitSha = await this.headSha(repo, branch);
    if (commitSha === null) return { commitSha: null, isPrivate, indexSha: null, files: new Map(), head: null, marker: null };
    const key = `snap:v3:${repo}:${commitSha}:${prefix}`;
    let c = await this.cacheGet(key);
    if (!c) {
      const { head, tree } = await this.commitTree(repo, commitSha);
      let indexSha: string | null = null;
      const wanted: TreeEntry[] = [];
      let markerSha: string | null = null;
      for (const t of tree) {
        if (t.type === "blob" && t.path === MARKER_PATH) markerSha = t.sha;
        if (t.type !== "blob" || !t.path.startsWith(prefix)) continue;
        const rel = t.path.slice(prefix.length);
        if (rel === "MEMORY.md") indexSha = t.sha;
        else if (parseMemoryPath(rel)) wanted.push(t);
      }
      const texts = await this.texts(repo, [...wanted.map((t) => t.sha), ...(markerSha ? [markerSha] : [])]);
      let marker: string | null = null;
      if (markerSha) {
        marker = texts.get(markerSha) ?? null;
        if (marker === null) throw new OpError("internal", "The repo's encryption marker could not be read.", "Check .claude-memory/encryption.json in the memory repo.");
      }
      c = { marker, indexSha, head, files: wanted.map((t): [string, string, string, boolean?] => {
        const text = texts.get(t.sha) ?? null;
        const rel = t.path.slice(prefix.length);
        return text === null ? [rel, t.sha, "", true] : [rel, t.sha, text];
      }) };
      await this.cachePut(key, c);
    }
    return {
      commitSha, isPrivate, indexSha: c.indexSha, head: c.head, marker: c.marker,
      files: new Map(c.files.map(([path, sha, content, unreadable]) => [path, unreadable ? { path, sha, content, unreadable } : { path, sha, content }])),
    };
  }

  private async baseTreeSha(repo: string, sha: string): Promise<string> {
    const memo = this.trees.get(`${repo}@${sha}`);
    if (memo) return (await memo).treeSha;
    return (await this.gh.request<{ tree: { sha: string } }>("GET", `/repos/${repo}/git/commits/${sha}`)).tree.sha;
  }

  async commit(repo: string, prefix: string, base: string | null, changes: Change[], message: string): Promise<CommitResult> {
    this.heads.delete(repo); // whatever happens below, the next snapshot re-reads the ref
    const { branch } = await this.repoMeta(repo);
    if (base === null) {
      // Git Data API can't write to an empty repo: create README via the contents API, then let the caller retry.
      try {
        await this.gh.request("PUT", `/repos/${repo}/contents/README.md`, { message: "init: claude-memory", content: encode(README), branch });
      } catch (e) {
        // A concurrent first save already created README.md.
        if (e instanceof GitHubError && e.status === 422) return { ok: false, reason: "ref_moved" };
        throw e;
      }
      return { ok: false, reason: "ref_moved" };
    }
    const tree = await this.gh.request<{ sha: string }>("POST", `/repos/${repo}/git/trees`, {
      base_tree: await this.baseTreeSha(repo, base),
      tree: changes.map((c) => c.content === null
        ? { path: prefix + c.path, mode: "100644", type: "blob", sha: null }
        : { path: prefix + c.path, mode: "100644", type: "blob", content: c.content }),
    });
    const commit = await this.gh.request<{ sha: string; html_url: string }>("POST", `/repos/${repo}/git/commits`, {
      message, tree: tree.sha, parents: [base],
    });
    try {
      await this.gh.request("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) {
        // A racing writer and a branch rule both answer 409/422. Only a ref that actually moved is a race.
        const cur = await this.gh.request<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${branch}`);
        if (cur.object.sha !== base) return { ok: false, reason: "ref_moved" };
        throw new GitHubError(e.message, e.status, "unprocessable");
      }
      throw e;
    }
    return { ok: true, commitSha: commit.sha, url: commit.html_url };
  }
  /** The whole tree at the current head (re-read, never memoized), for switch-on. */
  async readTree(repo: string): Promise<{ head: string | null; branch: string; isPrivate: boolean; canWrite: boolean; files: TreeFile[] }> {
    this.heads.delete(repo);
    const { branch, isPrivate, canWrite } = await this.repoMeta(repo);
    const head = await this.headSha(repo, branch);
    if (head === null) return { head, branch, isPrivate, canWrite, files: [] };
    const { tree } = await this.commitTree(repo, head);
    const entries = tree.filter((t) => t.type !== "tree");
    const texts = await this.texts(repo, entries.filter((t) => t.type === "blob" && wantsText(t.path)).map((t) => t.sha));
    return { head, branch, isPrivate, canWrite, files: entries.map((t) => ({
      path: t.path, mode: t.mode ?? "100644", sha: t.sha, text: t.type === "blob" && wantsText(t.path) ? texts.get(t.sha) ?? null : null,
    })) };
  }

  /** The branch head right now (not memoized); null for an empty repo. */
  async currentHead(repo: string): Promise<string | null> {
    this.heads.delete(repo);
    return this.headSha(repo, (await this.repoMeta(repo)).branch);
  }

  /** Other branches, tags and pull requests (any state): each keeps old commits reachable. Counts are of the first page, so they are lower bounds. */
  async extraRefs(repo: string): Promise<{ branches: number; tags: number; pulls: number }> {
    const { branch } = await this.repoMeta(repo);
    const [branches, tags, pulls] = await Promise.all([
      this.gh.request<{ name: string }[]>("GET", `/repos/${repo}/branches?per_page=100`),
      this.gh.request<unknown[]>("GET", `/repos/${repo}/tags?per_page=100`),
      this.gh.request<unknown[]>("GET", `/repos/${repo}/pulls?state=all&per_page=1`),
    ]);
    return { branches: branches.filter((b) => b.name !== branch).length, tags: tags.length, pulls: pulls.length };
  }

  private async rootCommit(repo: string, files: TreeWrite[], message: string): Promise<{ sha: string; html_url: string }> {
    const tree = await this.gh.request<{ sha: string }>("POST", `/repos/${repo}/git/trees`, {
      tree: files.map((f) => f.content !== undefined
        ? { path: f.path, mode: f.mode, type: "blob", content: f.content }
        : { path: f.path, mode: f.mode, type: f.mode === "160000" ? "commit" : "blob", sha: f.sha }),
    });
    return this.gh.request<{ sha: string; html_url: string }>("POST", `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [] });
  }

  /** Force-moves the branch to `sha`, only if it still points at `expected`. */
  private async forceMove(repo: string, branch: string, expected: string, sha: string): Promise<void> {
    const cur = await this.gh.request<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${branch}`);
    if (cur.object.sha !== expected) throw MOVED();
    try {
      await this.gh.request("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha, force: true });
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) {
        throw new OpError("write_rejected", `GitHub refused the force push: ${e.message}. Nothing was changed.`, FORCE_PUSH_ACTION);
      }
      throw e;
    }
  }

  /** Replaces the branch's history with one root commit holding `files`, unless the branch moved from `expectedHead`. */
  async replaceHistory(repo: string, expectedHead: string, files: TreeWrite[], message: string): Promise<{ sha: string; url: string }> {
    this.heads.delete(repo);
    const { branch } = await this.repoMeta(repo);
    const c = await this.rootCommit(repo, files, message);
    await this.forceMove(repo, branch, expectedHead, c.sha);
    return { sha: c.sha, url: c.html_url };
  }

  /** First commit of an empty repo. Files given by SHA are blobs copied from `from` (or already in `repo`). */
  async writeFirstCommit(repo: string, files: TreeWrite[], message: string, from?: string): Promise<{ sha: string; url: string }> {
    this.heads.delete(repo);
    const { branch } = await this.repoMeta(repo);
    const notEmpty = () => new OpError("invalid", `${repo} isn't empty.`, "Create a new, empty private repo (no README) and try again.");
    if (await this.headSha(repo, branch) !== null) throw notEmpty();
    this.heads.delete(repo);
    // The Git Data API can't write to an empty repo: a placeholder commit via the contents API comes first, then is replaced.
    let placeholder: string;
    try {
      placeholder = (await this.gh.request<{ commit: { sha: string } }>("PUT", `/repos/${repo}/contents/README.md`,
        { message: "init: claude-memory", content: encode(README), branch })).commit.sha;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422) throw notEmpty();
      throw e;
    }
    if (from) {
      const copy = [...new Set(files.filter((f) => f.content === undefined && f.mode !== "160000").map((f) => f.sha!))];
      await mapLimit(copy, 4, async (sha) => {
        const b = await this.gh.request<{ content: string; encoding: string }>("GET", `/repos/${from}/git/blobs/${sha}`);
        if (b.encoding !== "base64") throw new GitHubError(`unexpected blob encoding ${b.encoding}`, 0, "other");
        await this.gh.request("POST", `/repos/${repo}/git/blobs`, { content: b.content.replace(/\s/g, ""), encoding: "base64" });
      });
    }
    const c = await this.rootCommit(repo, files, message);
    await this.forceMove(repo, branch, placeholder, c.sha);
    return { sha: c.sha, url: c.html_url };
  }
}
