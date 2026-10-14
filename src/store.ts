import { GitHub, GitHubError } from "./github";
import { parseMemoryPath } from "./memory";

export interface FileEntry { path: string; sha: string; content: string }
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
}
export interface Change { path: string; content: string | null }
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

const encode = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

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

type TreeEntry = { path: string; type: string; sha: string };
interface CommitTree { head: HeadCommit; treeSha: string; tree: TreeEntry[] }
interface CachedSnapshot { indexSha: string | null; head: HeadCommit; files: [string, string, string][] }

const isEmptyRepo = (e: unknown) =>
  e instanceof GitHubError && (e.kind === "empty_repo" || (e.kind === "not_found" && /empty/i.test(e.message)));

export class GitHubStore implements Store {
  cacheWriteFailed = false;
  /** Snapshots serialized larger than this skip the KV cache. Overridable for tests. */
  maxCacheBytes = MAX_CACHE_BYTES;
  private meta = new Map<string, Promise<{ branch: string; isPrivate: boolean }>>();
  private heads = new Map<string, Promise<string | null>>();
  private trees = new Map<string, Promise<CommitTree>>();
  constructor(private gh: GitHub, private cache?: KVNamespace) {}

  private repoMeta(repo: string) {
    let m = this.meta.get(repo);
    if (!m) {
      m = this.gh.request<{ default_branch: string; private?: boolean }>("GET", `/repos/${repo}`)
        .then((r) => ({ branch: r.default_branch, isPrivate: r.private === true }));
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

  /** Text of each blob, fetched with GraphQL in chunks (one request per 100 blobs). Missing or binary blobs read as "". */
  private async texts(repo: string, shas: string[]): Promise<Map<string, string>> {
    const [owner, name] = repo.split("/") as [string, string];
    const valid = [...new Set(shas.filter((s) => OID_RE.test(s)))];
    const chunks: string[][] = [];
    for (let i = 0; i < valid.length; i += GRAPHQL_CHUNK) chunks.push(valid.slice(i, i + GRAPHQL_CHUNK));
    const out = new Map<string, string>();
    await mapLimit(chunks, GRAPHQL_CONCURRENCY, async (chunk) => {
      const fields = chunk.map((s, i) => `b${i}: object(oid: "${s}") { ... on Blob { text } }`).join(" ");
      const data = await this.gh.graphql<{ repository: Record<string, { text?: string | null } | null> | null }>(
        `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`, { owner, name });
      chunk.forEach((s, i) => out.set(s, data.repository?.[`b${i}`]?.text ?? ""));
    });
    return out;
  }

  async snapshot(repo: string, prefix: string): Promise<Snapshot> {
    const { branch, isPrivate } = await this.repoMeta(repo);
    const commitSha = await this.headSha(repo, branch);
    if (commitSha === null) return { commitSha: null, isPrivate, indexSha: null, files: new Map(), head: null };
    const key = `snap:v1:${repo}:${commitSha}:${prefix}`;
    let c = await this.cacheGet(key);
    if (!c) {
      const { head, tree } = await this.commitTree(repo, commitSha);
      let indexSha: string | null = null;
      const wanted: TreeEntry[] = [];
      for (const t of tree) {
        if (t.type !== "blob" || !t.path.startsWith(prefix)) continue;
        const rel = t.path.slice(prefix.length);
        if (rel === "MEMORY.md") indexSha = t.sha;
        else if (parseMemoryPath(rel)) wanted.push(t);
      }
      const texts = await this.texts(repo, wanted.map((t) => t.sha));
      c = { indexSha, head, files: wanted.map((t) => [t.path.slice(prefix.length), t.sha, texts.get(t.sha) ?? ""]) };
      await this.cachePut(key, c);
    }
    return {
      commitSha, isPrivate, indexSha: c.indexSha, head: c.head,
      files: new Map(c.files.map(([path, sha, content]) => [path, { path, sha, content }])),
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
}
