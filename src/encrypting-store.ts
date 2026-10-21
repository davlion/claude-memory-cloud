import type { RepoKey } from "./crypto";
import { isEncryptedFile, markerSignedBy, openMemoryFile, parseMarker, sealMemoryFile, type Marker } from "./encrypted-files";
import { OpError } from "./errors";
import type { KeyRing } from "./keyring";
import { namesOnlyIndex, parseMemoryPath } from "./memory";
import { clearSnapshots, type Change, type CommitResult, type EncryptionStatus, type FileEntry, type Snapshot, type Store } from "./store";

export const keyRequired = (repo: string, keysUrl: string) => new OpError("key_required",
  `${repo} is encrypted and its key isn't registered, so this can't be saved yet.`,
  `Register the repo's key (from your password manager) at ${keysUrl}?repo=${repo}, then try again.`);

const unsupported = (repo: string) => new OpError("write_rejected",
  `${repo} is an encrypted memory repo and this memory server doesn't support encryption. Not saved.`,
  "Ask the memory server's operator to turn on encryption, or use one that has it.");

/** A repo's encryption state for one snapshot; `key`/`repoId` are set only when sealed files can be opened and new ones sealed. */
interface State { status: EncryptionStatus; key: RepoKey | null; repoId: string | null }

const sameIds = (a: { enabled: boolean; repoId: string; keyId: string }, b: { enabled: boolean; repoId: string; keyId: string }) =>
  a.enabled === b.enabled && a.repoId === b.repoId && a.keyId === b.keyId;

/** Seals memory files before commit and opens them after snapshot, per the repo's marker, record and key. */
export class EncryptingStore implements Store {
  /** The inner snapshot last taken per repo and prefix, so commit can decide the state without re-reading. */
  private last = new Map<string, Snapshot>();

  /** `cache` is the snapshot cache (CACHE_KV): cleared when a repo is first seen encrypted or its move ends. */
  constructor(private inner: Store, private keys: KeyRing | null, private keysUrl: string, private cache?: KVNamespace) {}

  get cacheWriteFailed() { return this.inner.cacheWriteFailed; }

  /** Best effort: a cache problem never fails a read. */
  private async clearCache(repo: string): Promise<void> {
    if (!this.cache) return;
    try { await clearSnapshots(this.cache, repo); } catch { /* they expire by TTL */ }
  }

  /** null: not encrypted and no move in progress, so everything passes through unchanged. */
  private async state(repo: string, raw: Snapshot): Promise<State | null> {
    const sealed = [...raw.files.values()].filter((f) => !f.unreadable && isEncryptedFile(f.content));
    let m: Marker | null = null;
    let badMarker = false;
    if (raw.marker !== null) { try { m = parseMarker(raw.marker); } catch { badMarker = true; } }
    const ring = this.keys;
    const [k, rec] = ring ? await Promise.all([ring.get(repo), ring.getRecord(repo)]) : [null, null];
    let move = ring ? await ring.getMove(repo) : null;
    const verified = Boolean(m && k && await markerSignedBy(k.key, m));
    // A marker naming the registered key but failing its MAC is forged.
    const forged = Boolean(m && k && !verified && m.keyId === k.key.id);

    let enabled: boolean;
    let problem = false;
    let ids: { repoId: string; keyId: string } | null;
    if (verified && m && ring) {
      // A verified marker never downgrades an enabled record: an old signed `enabled: false` could be replayed from history.
      const downgrade = Boolean(rec?.enabled && !m.enabled);
      enabled = m.enabled || downgrade; ids = m; problem = downgrade;
      const want = { repoId: m.repoId, keyId: m.keyId, enabled };
      if (!rec || !sameIds(rec, want)) await ring.putRecord(repo, want);
      if (move && move.repoId === m.repoId) { await ring.clearMove(repo); move = null; await this.clearCache(repo); }
      else if (!rec) await this.clearCache(repo);
    } else {
      if (rec) {
        enabled = rec.enabled; ids = rec;
        problem = !m || !sameIds(m, rec);
      } else if (m) {
        enabled = m.enabled || sealed.length > 0; ids = m;
        problem = !m.enabled && sealed.length > 0;
      } else if (badMarker || sealed.length > 0) {
        enabled = true; ids = null; problem = true;
      } else if (move) {
        enabled = false; ids = null;
      } else return null;
      if (forged) { enabled = true; problem = true; }
      // Sticky: once seen encrypted, the repo stays encrypted for every prefix, even one with no sealed files.
      if (ring && !rec && (enabled || sealed.length > 0)) {
        const keyId = m?.keyId ?? sealed.map((f) => /^key_id: ([0-9a-f]{16})$/m.exec(f.content)?.[1]).find(Boolean) ?? "";
        await ring.putRecord(repo, { repoId: m?.repoId ?? "", keyId, enabled: true });
        await this.clearCache(repo);
      }
    }

    // A marker the registered key didn't sign, naming another key (rotated elsewhere), means the registered key is stale.
    const stale = Boolean(m && k && !verified && m.keyId !== k.key.id);
    const key = !ring ? "unsupported" : !k ? "missing" : stale || !ids?.repoId || k.key.id !== ids.keyId ? "mismatch" : "ok";
    // The old repo moved past the copied head: a save that didn't yet see the move flag (KV lag) isn't in the copy.
    // A marker with the move's repo ID means this is already the renamed copy, never stale.
    const moveStale = Boolean(move && raw.commitSha !== move.head && m?.repoId !== move.repoId);
    const status: EncryptionStatus = {
      encrypted: enabled || sealed.length > 0, enabled, key, markerProblem: move ? false : problem, sealed: sealed.length, outside: 0,
      ...(move ? { moving: move.to } : {}), ...(moveStale ? { moveStale } : {}),
    };
    return { status, key: key === "ok" ? k!.key : null, repoId: key === "ok" ? ids!.repoId : null };
  }

  async snapshot(repo: string, prefix: string): Promise<Snapshot> {
    const raw = await this.inner.snapshot(repo, prefix);
    this.last.set(`${repo}\n${prefix}`, raw);
    const st = await this.state(repo, raw);
    if (!st) return raw;
    let outside = 0;
    const files = new Map<string, FileEntry>();
    for (const [path, f] of raw.files) {
      let out: FileEntry = f;
      if (f.unreadable) out = f;
      else if (isEncryptedFile(f.content)) {
        if (!st.key || !st.repoId) out = { path, sha: f.sha, content: "", locked: true };
        else {
          try { out = { path, sha: f.sha, content: await openMemoryFile(st.key, st.repoId, prefix + path, f.content) }; }
          catch { out = { path, sha: f.sha, content: "", unreadable: true }; }
        }
      } else if (st.status.enabled) { out = { ...f, outside: true }; outside++; }
      files.set(path, out);
    }
    return { ...raw, files, encryption: { ...st.status, outside } };
  }

  /** The repo's encryption status without opening any file; null when it isn't encrypted. */
  async status(repo: string, prefix: string): Promise<EncryptionStatus | null> {
    const raw = await this.inner.snapshot(repo, prefix);
    const st = await this.state(repo, raw);
    if (!st) return null;
    const outside = st.status.enabled ? [...raw.files.values()].filter((f) => !f.unreadable && !isEncryptedFile(f.content)).length : 0;
    return { ...st.status, outside };
  }

  async commit(repo: string, prefix: string, base: string | null, changes: Change[], message: string): Promise<CommitResult> {
    if (this.keys) {
      const [switching, move] = await Promise.all([this.keys.isSwitching(repo), this.keys.getMove(repo)]);
      if (switching || move) {
        throw new OpError("unavailable", "Encryption is being turned on for this memory repo.",
          switching ? "Try again in a minute." : `Finish or cancel the move on the key page: ${this.keysUrl}?repo=${repo}`);
      }
    }
    const memo = this.last.get(`${repo}\n${prefix}`);
    const raw = memo && memo.commitSha === base ? memo : await this.inner.snapshot(repo, prefix);
    const st = await this.state(repo, raw);
    if (!st || !st.status.encrypted) return this.inner.commit(repo, prefix, base, changes, message);

    const sealing = st.status.enabled;
    if (sealing && changes.some((c) => c.content !== null && parseMemoryPath(c.path))) {
      if (!this.keys) throw unsupported(repo);
      if (!st.key || !st.repoId) throw keyRequired(repo, this.keysUrl);
    }
    const out = await Promise.all(changes.map(async (c): Promise<Change> => {
      if (c.content === null) return c;
      if (c.path === "MEMORY.md") return { path: c.path, content: namesOnlyIndex(c.content) };
      if (sealing && parseMemoryPath(c.path)) return { path: c.path, content: await sealMemoryFile(st.key!, st.repoId!, prefix + c.path, c.content) };
      return c;
    }));
    return this.inner.commit(repo, prefix, base, out, message);
  }
}
