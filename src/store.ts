import { GitHub, GitHubError } from "./github";

export interface FileEntry { path: string; sha: string; content: string }
export interface Snapshot { commitSha: string | null; isPrivate: boolean; files: Map<string, FileEntry> }
export interface Change { path: string; content: string | null }
export type CommitResult = { ok: true; commitSha: string; url: string } | { ok: false; reason: "ref_moved" };

export interface Store {
  snapshot(repo: string, prefix: string): Promise<Snapshot>;
  commit(repo: string, prefix: string, baseCommitSha: string | null, changes: Change[], message: string): Promise<CommitResult>;
}

export const README = `# claude-memory

Memories for Claude, maintained by the claude-memory-cloud server.

- \`MEMORY.md\` is the index; \`memories/\` holds one file per memory; \`projects/<repo>/\` holds per-project sets.
- **Never put secrets here.** The server rejects anything that looks like a credential.
- Editing by hand is fine; the server rebuilds the index on its next write.
`;

const decode = (b64: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
const encode = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

export class GitHubStore implements Store {
  private meta = new Map<string, { branch: string; isPrivate: boolean }>();
  constructor(private gh: GitHub, private cache?: KVNamespace) {}

  private async repoMeta(repo: string) {
    let m = this.meta.get(repo);
    if (!m) {
      const r = await this.gh.request<{ default_branch: string; private?: boolean }>("GET", `/repos/${repo}`);
      m = { branch: r.default_branch, isPrivate: r.private === true };
      this.meta.set(repo, m);
    }
    return m;
  }

  private async blob(repo: string, sha: string): Promise<string> {
    const cached = await this.cache?.get(`blob:${sha}`);
    if (cached !== null && cached !== undefined) return cached;
    const b = await this.gh.request<{ content: string }>("GET", `/repos/${repo}/git/blobs/${sha}`);
    const text = decode(b.content);
    await this.cache?.put(`blob:${sha}`, text, { expirationTtl: 30 * 24 * 3600 });
    return text;
  }

  async snapshot(repo: string, prefix: string): Promise<Snapshot> {
    const { branch, isPrivate } = await this.repoMeta(repo);
    let commitSha: string;
    try {
      commitSha = (await this.gh.request<{ object: { sha: string } }>("GET", `/repos/${repo}/git/ref/heads/${branch}`)).object.sha;
    } catch (e) {
      if (e instanceof GitHubError && (e.kind === "empty_repo" || e.kind === "not_found" && /empty/i.test(e.message))) {
        return { commitSha: null, isPrivate, files: new Map() };
      }
      throw e;
    }
    const treeSha = (await this.gh.request<{ tree: { sha: string } }>("GET", `/repos/${repo}/git/commits/${commitSha}`)).tree.sha;
    const tree = await this.gh.request<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
      "GET", `/repos/${repo}/git/trees/${treeSha}?recursive=1`,
    );
    if (tree.truncated) throw new GitHubError("memory repo tree too large (truncated)", 0, "other");
    const wanted = tree.tree.filter((t) => {
      if (t.type !== "blob" || !t.path.startsWith(prefix)) return false;
      const rel = t.path.slice(prefix.length);
      return rel === "MEMORY.md" || (rel.startsWith("memories/") && !rel.slice(9).includes("/"));
    });
    const files = new Map<string, FileEntry>();
    await Promise.all(wanted.map(async (t) => {
      const rel = t.path.slice(prefix.length);
      files.set(rel, { path: rel, sha: t.sha, content: await this.blob(repo, t.sha) });
    }));
    return { commitSha, isPrivate, files };
  }

  async commit(repo: string, prefix: string, base: string | null, changes: Change[], message: string): Promise<CommitResult> {
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
    const baseTree = (await this.gh.request<{ tree: { sha: string } }>("GET", `/repos/${repo}/git/commits/${base}`)).tree.sha;
    const tree = await this.gh.request<{ sha: string }>("POST", `/repos/${repo}/git/trees`, {
      base_tree: baseTree,
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
      if (e instanceof GitHubError && e.kind === "conflict") return { ok: false, reason: "ref_moved" };
      throw e;
    }
    return { ok: true, commitSha: commit.sha, url: commit.html_url };
  }
}
