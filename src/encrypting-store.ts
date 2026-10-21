import type { RepoKey } from "./crypto";
import { isEncryptedFile, markerSignedBy, openMemoryFile, parseMarker, sealMemoryFile, type Marker } from "./encrypted-files";
import { OpError } from "./errors";
import type { KeyRing } from "./keyring";
import { namesOnlyIndex, parseMemoryPath } from "./memory";
import type { Change, CommitResult, EncryptionStatus, FileEntry, Snapshot, Store } from "./store";

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

  constructor(private inner: Store, private keys: KeyRing | null, private keysUrl: string) {}

  get cacheWriteFailed() { return this.inner.cacheWriteFailed; }

  /** null: not encrypted and no move in progress, so everything passes through unchanged. */
  private async state(repo: string, raw: Snapshot): Promise<State | null> {
    const sealed = [...raw.files.values()].filter((f) => !f.unreadable && isEncryptedFile(f.content)).length;
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
      enabled = m.enabled; ids = m;
      if (!rec || !sameIds(rec, m)) await ring.putRecord(repo, { repoId: m.repoId, keyId: m.keyId, enabled: m.enabled });
      if (move && move.repoId === m.repoId) { await ring.clearMove(repo); move = null; }
    } else if (rec) {
      enabled = rec.enabled; ids = rec;
      problem = !m || !sameIds(m, rec) || forged;
    } else if (m) {
      enabled = m.enabled || sealed > 0; ids = m;
      problem = (!m.enabled && sealed > 0) || forged;
    } else if (badMarker || sealed > 0) {
      enabled = true; ids = null; problem = true;
    } else if (move) {
      enabled = false; ids = null;
    } else return null;

    const key = !ring ? "unsupported" : !k ? "missing" : !ids || k.key.id !== ids.keyId ? "mismatch" : "ok";
    const status: EncryptionStatus = {
      encrypted: enabled || sealed > 0, enabled, key, markerProblem: move ? false : problem, sealed, outside: 0,
      ...(move ? { moving: move.to } : {}),
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

  async commit(repo: string, prefix: string, base: string | null, changes: Change[], message: string): Promise<CommitResult> {
    if (this.keys) {
      const [switching, move] = await Promise.all([this.keys.isSwitching(repo), this.keys.getMove(repo)]);
      if (switching || move) {
        throw new OpError("unavailable", "Encryption is being turned on for this memory repo.",
          switching ? "Try again in a minute." : `Finish the move on the key page: ${this.keysUrl}?repo=${repo}`);
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
