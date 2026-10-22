import { open, parseKeyText, parseMasterKey, seal, type RepoKey } from "./crypto";
import type { Env } from "./env";

/** KV key prefixes (OAUTH_KV), each followed by the lower-cased `owner/repo`. */
export const KV = { key: "repokey:v1:", record: "repoenc:v1:", switching: "switching:v1:", moving: "moving:v1:" } as const;
const SWITCHING_TTL = 300;
const MIN_TTL = 60;

export interface RegisteredKey { key: RepoKey; registeredBy: string; registeredAt: number; expiresAt: number | null }
/**
 * `confirmed`: written by an admin's key page action (switch-on, register, Confirm decryption, Stop). A record the memory
 * tool learned from the repo's content (a marker, sealed files) isn't, and neither is one from before this flag existed.
 */
export interface EncryptedRepoRecord { repoId: string; keyId: string; enabled: boolean; confirmed?: boolean }
/** A fresh-repo move: the copy in `to` (its repo ID), the old repo's head that was copied, and the record before the switch. */
export interface MoveRecord { to: string; repoId: string; head: string | null; prevRecord: EncryptedRepoRecord | null }

type RecordJson = { repo_id: string; key_id: string; enabled: boolean; confirmed?: boolean };
const recordJson = (r: EncryptedRepoRecord): RecordJson =>
  ({ repo_id: r.repoId, key_id: r.keyId, enabled: r.enabled, ...(r.confirmed ? { confirmed: true } : {}) });
const fromJson = (v: RecordJson): EncryptedRepoRecord =>
  ({ repoId: v.repo_id, keyId: v.key_id, enabled: v.enabled, ...(v.confirmed === true ? { confirmed: true } : {}) });

const keyAad = (repo: string) => `repokey-v1\n${repo}`;

/** Repo keys wrapped under the master key in OAUTH_KV, plus the per-repo encryption records and switch/move flags. */
export class KeyRing {
  private cache = new Map<string, RegisteredKey>();

  constructor(private kv: KVNamespace, private master: CryptoKey, private ttlSeconds: number) {}

  static async fromEnv(env: Env): Promise<KeyRing | null> {
    if (!env.MEMORY_MASTER_KEY) return null;
    const ttl = Number(env.REPO_KEY_TTL_SECONDS);
    return new KeyRing(env.OAUTH_KV, await parseMasterKey(env.MEMORY_MASTER_KEY), ttl > 0 ? ttl : 0);
  }

  async get(repo: string): Promise<RegisteredKey | null> {
    const r = repo.toLowerCase();
    const hit = this.cache.get(r);
    if (hit) return hit;
    const raw = await this.kv.get(KV.key + r);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { sealed: string; by: string; at: number; expires_at: number | null };
      const key = await parseKeyText(await open(this.master, v.sealed, keyAad(r)));
      const out = { key, registeredBy: v.by, registeredAt: v.at, expiresAt: v.expires_at ?? null };
      this.cache.set(r, out);
      return out;
    } catch { return null; }
  }

  async put(repo: string, keyText: string, login: string, now: number): Promise<{ expiresAt: number | null }> {
    const r = repo.toLowerCase();
    const key = await parseKeyText(keyText);
    const ttl = this.ttlSeconds > 0 ? Math.max(MIN_TTL, this.ttlSeconds) : 0;
    const expiresAt = ttl ? now + ttl * 1000 : null;
    const sealed = await seal(this.master, keyText.trim(), keyAad(r));
    await this.kv.put(KV.key + r, JSON.stringify({ sealed, key_id: key.id, by: login, at: now, expires_at: expiresAt }), ttl ? { expirationTtl: ttl } : undefined);
    this.cache.set(r, { key, registeredBy: login, registeredAt: now, expiresAt });
    return { expiresAt };
  }

  async remove(repo: string): Promise<void> {
    const r = repo.toLowerCase();
    this.cache.delete(r);
    await this.kv.delete(KV.key + r);
  }

  async getRecord(repo: string): Promise<EncryptedRepoRecord | null> {
    const raw = await this.kv.get(KV.record + repo.toLowerCase());
    if (!raw) return null;
    return fromJson(JSON.parse(raw) as RecordJson);
  }

  async putRecord(repo: string, r: EncryptedRepoRecord): Promise<void> {
    await this.kv.put(KV.record + repo.toLowerCase(), JSON.stringify(recordJson(r)));
  }

  async deleteRecord(repo: string): Promise<void> { await this.kv.delete(KV.record + repo.toLowerCase()); }

  async isSwitching(repo: string): Promise<boolean> { return (await this.kv.get(KV.switching + repo.toLowerCase())) !== null; }
  async setSwitching(repo: string): Promise<void> { await this.kv.put(KV.switching + repo.toLowerCase(), "1", { expirationTtl: SWITCHING_TTL }); }
  async clearSwitching(repo: string): Promise<void> { await this.kv.delete(KV.switching + repo.toLowerCase()); }

  async getMove(repo: string): Promise<MoveRecord | null> {
    const raw = await this.kv.get(KV.moving + repo.toLowerCase());
    if (!raw) return null;
    const v = JSON.parse(raw) as { to: string; repo_id: string; head?: string | null; prev_record?: RecordJson | null };
    return { to: v.to, repoId: v.repo_id, head: v.head ?? null, prevRecord: v.prev_record ? fromJson(v.prev_record) : null };
  }
  async setMove(repo: string, m: MoveRecord): Promise<void> {
    await this.kv.put(KV.moving + repo.toLowerCase(),
      JSON.stringify({ to: m.to, repo_id: m.repoId, head: m.head, prev_record: m.prevRecord && recordJson(m.prevRecord) }));
  }
  async clearMove(repo: string): Promise<void> { await this.kv.delete(KV.moving + repo.toLowerCase()); }

  /** Wraps arbitrary text under the master key; `aad` binds it to its purpose. */
  wrapText(text: string, aad: string): Promise<string> { return seal(this.master, text, aad); }
  async unwrapText(sealed: string, aad: string): Promise<string | null> {
    try { return await open(this.master, sealed, aad); } catch { return null; }
  }
}
