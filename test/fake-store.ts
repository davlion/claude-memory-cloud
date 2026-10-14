import type { Change, CommitResult, Snapshot, Store } from "../src/store";

async function sha(s: string) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class FakeStore implements Store {
  files = new Map<string, Map<string, string>>();
  commits: { repo: string; message: string; changes: Change[] }[] = [];
  heads = new Map<string, number>();
  failNextCommit = 0;
  publicRepos = new Set<string>();
  /** Called after a snapshot is taken and before the commit is applied: simulates a concurrent writer. */
  beforeCommit?: () => void;

  repo(repo: string) {
    let m = this.files.get(repo);
    if (!m) this.files.set(repo, (m = new Map()));
    return m;
  }
  /** Direct write that bumps the head, as if another client committed. */
  put(repo: string, path: string, content: string | null) {
    const m = this.repo(repo);
    if (content === null) m.delete(path);
    else m.set(path, content);
    this.heads.set(repo, (this.heads.get(repo) ?? 0) + 1);
  }

  async snapshot(repo: string, prefix: string): Promise<Snapshot> {
    const m = this.repo(repo);
    const head = this.heads.get(repo);
    const files = new Map<string, { path: string; sha: string; content: string }>();
    for (const [p, content] of m) {
      if (!p.startsWith(prefix)) continue;
      const rel = p.slice(prefix.length);
      if (prefix === "" && rel.startsWith("projects/")) continue;
      files.set(rel, { path: rel, sha: await sha(content), content });
    }
    return { commitSha: head === undefined ? null : `c${head}`, isPrivate: !this.publicRepos.has(repo), files };
  }

  async commit(repo: string, prefix: string, base: string | null, changes: Change[], message: string): Promise<CommitResult> {
    this.beforeCommit?.();
    this.beforeCommit = undefined;
    const head = this.heads.get(repo);
    const current = head === undefined ? null : `c${head}`;
    if (this.failNextCommit > 0 || current !== base) {
      if (this.failNextCommit > 0) this.failNextCommit--;
      return { ok: false, reason: "ref_moved" };
    }
    for (const c of changes) {
      const full = prefix + c.path;
      if (c.content === null) this.repo(repo).delete(full);
      else this.repo(repo).set(full, c.content);
    }
    const next = (head ?? 0) + 1;
    this.heads.set(repo, next);
    this.commits.push({ repo, message, changes });
    return { ok: true, commitSha: `c${next}`, url: `https://github.com/${repo}/commit/c${next}` };
  }
}
