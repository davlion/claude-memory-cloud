import { generateKeyText, parseKeyText, toB64Url, type RepoKey } from "./crypto";
import { MARKER_PATH, markerSignedBy, parseMarker, serializeMarker, signMarker, type Marker } from "./encrypted-files";
import type { Env } from "./env";
import type { ErrorCode } from "./errors";
import { GitHub, toOpError } from "./github";
import { scopeReachabilityDetailed } from "./health";
import type { KeyAction, KeySession } from "./key-page";
import { adminOnly, freshDone, inPlaceDone, message, page, turnOnPage } from "./key-page-html";
import { KV, type EncryptedRepoRecord, type KeyRing } from "./keyring";
import { REPO_RE } from "./scopes";
import { GitHubStore } from "./store";
import { switchOnFresh, switchOnInPlace, trailers } from "./switch-on";

const PENDING_TTL = 900;
const NOT_ON = "Encryption wasn't turned on";

export const sidHash = async (sid: string) =>
  toB64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sid))));

export function same(a: string, b: string): boolean {
  const [x, y] = [new TextEncoder().encode(a), new TextEncoder().encode(b)];
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

/** Turning encryption on or off (or back on) needs admin on the repo; register and remove need only write. */
export const mayChangeEncryption = (perms: { push?: boolean; admin?: boolean }) => perms.admin === true;

const pendingKey = (h: string, repo: string) => `keypending:${h}:${repo.toLowerCase()}`;
const pendingAad = (h: string, repo: string) => `keypending-v1\n${h}\n${repo.toLowerCase()}`;
const field = (form: FormData, name: string) => {
  const v = form.get(name);
  return typeof v === "string" ? v.trim() : "";
};

const statusOf = (code: ErrorCode) =>
  code === "unavailable" || code === "server_limit" || code === "reauth_required" ? 503 : code === "internal" ? 500 : code === "write_rejected" ? 409 : 400;
/** The error's own message and action; OpErrors and GitHub errors never carry key text. */
const fail = (title: string, e: unknown, prefix = "") => {
  const err = toOpError(e);
  return message(title, `${prefix}${err.message}${err.action ? ` ${err.action}` : ""}`, statusOf(err.code));
};
const notTheKey = (title: string, repo: string) => message(title, `This isn't the key for ${repo}.`, 400);

interface Target { repo: string; store: GitHubStore; admin: boolean }
interface RepoState { marker: Marker | null; rec: EncryptedRepoRecord | null; base: string | null }

/** The form's repo, if it is one of the user's memory repos and they can write to it (and, for `change`, are its admin). */
async function target(env: Env, s: KeySession, form: FormData, change: boolean): Promise<Target | Response> {
  const want = field(form, "repo").toLowerCase();
  const scopes = Object.entries(s.cfg).filter(([, r]) => r.toLowerCase() === want);
  if (!want || !scopes.length) return message("Not allowed", "That repo isn't one of your memory repos.", 403);
  const repo = scopes[0]![1];
  const gh = new GitHub(s.token);
  const r = (await scopeReachabilityDetailed(gh, Object.fromEntries(scopes), env.GITHUB_APP_SLUG)).reach[0]!;
  if (r.reason === "error") return message("Couldn't check access", `${r.error!.message}${r.error!.action ? ` ${r.error!.action}` : ""}`, 503);
  if (!r.reachable || !r.writable) return message("Not allowed", `The memory tool can't write to ${repo}.`, 403);
  if (change && !mayChangeEncryption({ push: r.writable, admin: r.admin })) return message("Not allowed", adminOnly(repo), 403);
  return { repo, store: new GitHubStore(gh, env.CACHE_KV), admin: mayChangeEncryption({ push: r.writable, admin: r.admin }) };
}

async function readState(t: Target, ring: KeyRing): Promise<RepoState> {
  const snap = await t.store.snapshot(t.repo, "");
  let marker: Marker | null = null;
  try { marker = snap.marker === null ? null : parseMarker(snap.marker); } catch { /* unparseable: the record decides */ }
  return { marker, rec: await ring.getRecord(t.repo), base: snap.commitSha };
}

/** With a marker, only the key that signed it matches (an old key after a rotate doesn't); without one, the record's key ID. */
async function matches(key: RepoKey, st: RepoState): Promise<{ ok: boolean; verified: boolean }> {
  if (st.marker) {
    const verified = await markerSignedBy(key, st.marker) && st.marker.keyId === key.id;
    return { ok: verified, verified };
  }
  return { ok: st.rec?.keyId === key.id, verified: false };
}

/** New saves are being sealed: the marker says so, or (with no marker) the record does. */
const sealing = (st: RepoState) => (st.marker ? st.marker.enabled : Boolean(st.rec?.enabled));
const busy = async (ring: KeyRing, repo: string) =>
  (await ring.isSwitching(repo)) || (await ring.getMove(repo)) !== null
    ? message("Busy", `Encryption is being turned on for ${repo}. Finish or wait for that first.`, 409) : null;

/** Common start of every action: the target repo and its state, or the response to send. */
async function prepare(env: Env, ring: KeyRing, s: KeySession, form: FormData, change: boolean, title: string) {
  const t = await target(env, s, form, change);
  if (t instanceof Response) return t;
  try { return { ...t, st: await readState(t, ring) }; } catch (e) { return fail(title, e); }
}

/** With the pasted key parsed and checked against the repo's key ID, or the response to send. */
async function withKey(form: FormData, st: RepoState, repo: string, title: string) {
  let key: RepoKey;
  try { key = await parseKeyText(field(form, "key")); } catch (e) { return fail(title, e); }
  if (!st.marker && !st.rec) return message(title, `${repo} isn't encrypted.`, 400);
  const m = await matches(key, st);
  return m.ok ? { key, text: field(form, "key"), verified: m.verified } : notTheKey(title, repo);
}

const turnOn: KeyAction = async (_req, env, ring, s, form) => {
  const p = await prepare(env, ring, s, form, true, NOT_ON);
  if (p instanceof Response) return p;
  const blocked = await busy(ring, p.repo);
  if (blocked) return blocked;
  if (sealing(p.st)) return message("Already encrypted", `${p.repo} is already encrypted.`, 409);
  let key: string | null = null;
  if (!p.st.marker && !p.st.rec) {
    key = generateKeyText();
    const h = await sidHash(s.sid);
    await env.OAUTH_KV.put(pendingKey(h, p.repo), await ring.wrapText(key, pendingAad(h, p.repo)), { expirationTtl: PENDING_TTL });
  }
  return page(turnOnPage({ repo: p.repo, csrf: s.csrf, key }));
};

const confirm: KeyAction = async (_req, env, ring, s, form) => {
  const t = await target(env, s, form, true);
  if (t instanceof Response) return t;
  const { repo, store } = t;
  const path = field(form, "path");
  const newRepo = field(form, "new_repo");
  if (field(form, "confirm_repo").toLowerCase() !== repo.toLowerCase()) {
    return message(NOT_ON, `The repo name you typed doesn't match ${repo}. Nothing was changed.`, 400);
  }
  if (path !== "fresh" && path !== "in-place") return message(NOT_ON, "Choose a fresh repo or in place. Nothing was changed.", 400);
  if (path === "fresh") {
    if (!REPO_RE.test(newRepo)) return message(NOT_ON, "Type the new repo as owner/name. Nothing was changed.", 400);
    const owner = repo.split("/")[0]!;
    if (newRepo.split("/")[0]!.toLowerCase() !== owner.toLowerCase()) {
      return message(NOT_ON, `The new repo must belong to ${owner}, so it can be renamed to ${repo}. Nothing was changed.`, 400);
    }
  }
  let st: RepoState;
  try { st = await readState(t, ring); } catch (e) { return fail(NOT_ON, e); }
  const blocked = await busy(ring, repo);
  if (blocked) return blocked;
  if (sealing(st)) return message("Already encrypted", `${repo} is already encrypted.`, 409);

  const h = await sidHash(s.sid);
  let keyText: string;
  let pending: string | null = null;
  if (!st.marker && !st.rec) {
    pending = await env.OAUTH_KV.get(pendingKey(h, repo));
    const shown = pending && await ring.unwrapText(pending, pendingAad(h, repo));
    if (!shown) return message(NOT_ON, "This key expired or was already used. Nothing was changed. Start again from the key page.", 400);
    if (!same(field(form, "key"), shown)) {
      return message(NOT_ON, "That isn't the key shown when you started. Nothing was changed.", 400);
    }
    await env.OAUTH_KV.delete(pendingKey(h, repo)); // one use
    keyText = shown;
  } else {
    const k = await withKey(form, st, repo, NOT_ON);
    if (k instanceof Response) return k;
    keyText = k.text;
  }

  // Notes when a write reached GitHub, so a later failure (record, key or cache) isn't reported as "nothing changed".
  let pushed = false;
  for (const m of ["replaceHistory", "writeFirstCommit"] as const) {
    const orig = store[m].bind(store) as (...a: unknown[]) => Promise<{ sha: string; url: string }>;
    store[m] = (async (...a: unknown[]) => { const r = await orig(...a); pushed = true; return r; }) as never;
  }
  try {
    if (path === "fresh") {
      await switchOnFresh(store, ring, env.CACHE_KV, repo, newRepo, keyText, s.login);
      return page(freshDone(repo, newRepo));
    }
    const { url } = await switchOnInPlace(store, ring, env.CACHE_KV, repo, keyText, s.login);
    return page(inPlaceDone(repo, url));
  } catch (e) {
    if (pending && !pushed) await env.OAUTH_KV.put(pendingKey(h, repo), pending, { expirationTtl: PENDING_TTL }); // retry with the same key
    if (pushed && path === "in-place") {
      return fail("Encryption is on, but didn't finish", e, `${repo} IS encrypted now, but this memory tool couldn't store its key: register the key on this page. `);
    }
    if (pushed) {
      // Undo the move flag and record, so saves to the old repo aren't held for a move that won't finish.
      let undone = true;
      try {
        await ring.clearMove(repo);
        if (st.rec) await ring.putRecord(repo, st.rec); else await env.OAUTH_KV.delete(KV.record + repo.toLowerCase());
      } catch { undone = false; }
      const now = undone ? `${repo} is unchanged and saves to it continue.` : `Saves to ${repo} may wait until the key page is used again.`;
      return fail(NOT_ON, e, `The encrypted copy was written to ${newRepo}, but the switch didn't finish. ${now} Delete ${newRepo} and recreate it as an empty private repo before trying again. `);
    }
    return fail(NOT_ON, e);
  }
};

const register: KeyAction = async (_req, env, ring, s, form) => {
  const title = "Key not registered";
  const p = await prepare(env, ring, s, form, false, title);
  if (p instanceof Response) return p;
  const k = await withKey(form, p.st, p.repo, title);
  if (k instanceof Response) return k;
  const m = p.st.marker;
  const rec = p.st.rec;
  // The marker this key signed is current (after memcrypt decrypt or rotate): the record follows it.
  // Only an admin may turn the record off this way; write users keep it on.
  const keptOn = Boolean(k.verified && m && rec?.enabled && !m.enabled && !p.admin);
  if (k.verified && m) {
    const want = { repoId: m.repoId, keyId: m.keyId, enabled: m.enabled || keptOn };
    if (!rec || rec.repoId !== want.repoId || rec.keyId !== want.keyId || rec.enabled !== want.enabled) await ring.putRecord(p.repo, want);
  }
  const { expiresAt } = await ring.put(p.repo, k.text, s.login, Date.now());
  if (keptOn) return message("Key registered", `Key registered. Encryption stays on for ${p.repo}; an admin can turn it off with Stop.`, 200);
  const until = expiresAt === null ? "" : ` until ${new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC`;
  return message("Key registered", `The key for ${p.repo} is registered${until}. The memory tool can read and save its memories.`, 200);
};

const remove: KeyAction = async (_req, env, ring, s, form) => {
  const title = "Key not removed";
  const p = await prepare(env, ring, s, form, false, title);
  if (p instanceof Response) return p;
  const k = await withKey(form, p.st, p.repo, title);
  if (k instanceof Response) return k;
  await ring.remove(p.repo);
  return message("Key removed", `The key for ${p.repo} is removed. The memory tool can't read or save its memories until it is registered again.`, 200);
};

const stop: KeyAction = async (_req, env, ring, s, form) => {
  const title = "Encryption wasn't stopped";
  const p = await prepare(env, ring, s, form, true, title);
  if (p instanceof Response) return p;
  const k = await withKey(form, p.st, p.repo, title);
  if (k instanceof Response) return k;
  const blocked = await busy(ring, p.repo);
  if (blocked) return blocked;
  const { marker, rec, base } = p.st;
  if (!(marker?.enabled || rec?.enabled)) return message(title, `${p.repo} isn't encrypting new saves.`, 409);
  const repoId = k.verified ? marker!.repoId : rec?.repoId;
  if (!repoId || base === null) {
    return message(title, `The encryption marker of ${p.repo} is missing or doesn't match. Run memory_health for details.`, 409);
  }
  const off = await signMarker(k.key, { enabled: false, repoId, keyId: k.key.id });
  try {
    const res = await p.store.commit(p.repo, "", base, [{ path: MARKER_PATH, content: serializeMarker(off) }],
      `encrypt: stop encrypting new saves${trailers(s.login)}`);
    if (!res.ok) return message(title, "The memory repo changed while this ran. Nothing was changed. Try again.", 409);
  } catch (e) { return fail(title, e); }
  try {
    await ring.putRecord(p.repo, { repoId, keyId: k.key.id, enabled: false });
  } catch {
    return message("Encryption stopped, but didn't finish", `The marker of ${p.repo} now says encryption is off, but this memory tool couldn't record it, so saves stay encrypted: register the key on this page.`, 500);
  }
  return message("Encryption stopped", `New memories in ${p.repo} are saved unencrypted from now on. Existing memories stay encrypted; to decrypt them, run memcrypt decrypt (docs/ENCRYPTION.md).`, 200);
};

/** POST /keys/<name> handlers; key-page.ts runs them only after the Origin, session and csrf checks. */
export const actions: Record<string, KeyAction> = { "turn-on": turnOn, "turn-on/confirm": confirm, register, remove, stop };
