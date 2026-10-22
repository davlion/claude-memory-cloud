import { generateKeyText, parseKeyText, toB64Url, type RepoKey } from "./crypto";
import { isEncryptedFile, MARKER_PATH, markerSignedBy, parseMarker, serializeMarker, signMarker, type Marker } from "./encrypted-files";
import { EncryptingStore } from "./encrypting-store";
import type { Env } from "./env";
import type { ErrorCode } from "./errors";
import { GitHub, toOpError } from "./github";
import { scopeReachabilityDetailed } from "./health";
import type { KeyAction, KeySession } from "./key-page";
import { adminOnly, errorBody, freshDoneBody, inPlaceDoneBody, message, page, stepItem, turningOnEnd, turningOnHead, turnOnPage } from "./key-page-html";
import type { EncryptedRepoRecord, KeyRing } from "./keyring";
import { parseMemoryPath } from "./memory";
import { REPO_RE } from "./scopes";
import { clearSnapshots, GitHubStore, splitSet } from "./store";
import { checkFreshTarget, switchOnFresh, switchOnInPlace, trailers, type Progress } from "./switch-on";

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
const errorText = (e: unknown, prefix = "") => {
  const err = toOpError(e);
  return { text: `${prefix}${err.message}${err.action ? ` ${err.action}` : ""}`, status: statusOf(err.code) };
};
const fail = (title: string, e: unknown, prefix = "") => {
  const { text, status } = errorText(e, prefix);
  return message(title, text, status);
};

/**
 * The page shown while encryption is turned on, streamed: its head at once, a list item per finished step, then the HTML
 * `run` returns. No JavaScript (the CSP has none), so streaming is the progress bar. The work isn't tied to the browser:
 * writes to a closed page are ignored, `ctx.waitUntil` keeps it running, and the writer always closes.
 */
function streamTurnOn(repo: string, ctx: ExecutionContext | undefined, run: (step: Progress) => Promise<string>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const w = writable.getWriter();
  const enc = new TextEncoder();
  const write = (html: string) => { w.write(enc.encode(html)).catch(() => { /* the browser left */ }); };
  write(turningOnHead(repo));
  const work = (async () => {
    let end: string;
    try { end = await run((step) => write(stepItem(step))); } catch {
      end = errorBody("This page couldn't finish", `Reload the key page to see whether encryption is on for ${repo}.`);
    }
    write(turningOnEnd(end));
  })().finally(() => { w.close().catch(() => { /* the browser left */ }); });
  ctx?.waitUntil(work);
  return page(readable);
}
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
  let outside: string[] = [];
  if (!p.st.marker && !p.st.rec) {
    key = generateKeyText();
    const h = await sidHash(s.sid);
    await env.OAUTH_KV.put(pendingKey(h, p.repo), await ring.wrapText(key, pendingAad(h, p.repo)), { expirationTtl: PENDING_TTL });
  } else {
    try { outside = await flaggedOutside(env, ring, p); } catch (e) { return fail(NOT_ON, e); }
  }
  return page(turnOnPage({ repo: p.repo, csrf: s.csrf, key, outside }));
};

/**
 * Turning back on seals every plaintext memory, including any the memory tool flags as added outside it (it flags them
 * while the record is on): their paths, for the admin to review first. Names only.
 */
async function flaggedOutside(env: Env, ring: KeyRing, t: Target): Promise<string[]> {
  const status = await new EncryptingStore(t.store, ring, `${env.PUBLIC_URL}/keys`, env.CACHE_KV).status(t.repo, "");
  if (!status?.enabled || status.moving) return [];
  return (await t.store.readTree(t.repo)).files
    .filter((f) => parseMemoryPath(splitSet(f.path).rel) !== null && f.text !== null && !isEncryptedFile(f.text)).map((f) => f.path);
}

const confirm: KeyAction = async (_req, env, ring, s, form, ctx) => {
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
  // A fresh copy would keep the repo's ID, and the old repo's "off" marker would then end the move before the rename.
  if (path === "fresh" && (st.marker || st.rec)) {
    return message(NOT_ON, "Turning encryption back on works in place only. Nothing was changed.", 400);
  }
  if (path === "fresh") {
    try { await checkFreshTarget(store, repo, newRepo); } catch (e) { return fail(NOT_ON, e); }
  }

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
  // Validation is done: from here the page streams each step as it finishes.
  return streamTurnOn(repo, ctx, async (step) => {
    try {
      if (path === "fresh") {
        await switchOnFresh(store, ring, env.CACHE_KV, repo, newRepo, keyText, s.login, step);
        return freshDoneBody(repo, newRepo, "h2");
      }
      const { url } = await switchOnInPlace(store, ring, env.CACHE_KV, repo, keyText, s.login, step);
      return inPlaceDoneBody(repo, url, "h2");
    } catch (e) {
      const failed = (title: string, prefix = "") => errorBody(title, errorText(e, prefix).text);
      if (pending && !pushed) await env.OAUTH_KV.put(pendingKey(h, repo), pending, { expirationTtl: PENDING_TTL }); // retry with the same key
      if (pushed && path === "in-place") {
        return failed("Encryption is on, but didn't finish", `${repo} IS encrypted now, but this memory tool couldn't store its key: register the key on this page. `);
      }
      if (pushed) {
        // Undo the move flag and record, so saves to the old repo aren't held for a move that won't finish.
        let undone = true;
        try {
          await ring.clearMove(repo);
          if (st.rec) await ring.putRecord(repo, st.rec); else await ring.deleteRecord(repo);
        } catch { undone = false; }
        const now = undone ? `${repo} is unchanged and saves to it continue.` : `Saves to ${repo} may wait until the key page is used again.`;
        return failed(NOT_ON, `The encrypted copy was written to ${newRepo}, but the switch didn't finish. ${now} Delete ${newRepo} and recreate it as an empty private repo before trying again. `);
      }
      return failed(NOT_ON);
    }
  });
};

/** Registering a key that names a different key or repo ID than the record (a rotate, or a planted marker) needs admin. */
export const newKeyAdminOnly = (repo: string) =>
  `Only an admin of ${repo} can register a new key for it (the key was changed, e.g. with memcrypt rotate).`;
/** No admin has confirmed the repo's key yet (the record was learned from repo content, or is missing): only an admin may register. */
export const unconfirmedAdminOnly = (repo: string) =>
  `Only an admin of ${repo} can register this key: the memory tool hasn't seen an admin confirm this repo's encryption key.`;

const register: KeyAction = async (_req, env, ring, s, form) => {
  const title = "Key not registered";
  const p = await prepare(env, ring, s, form, false, title);
  if (p instanceof Response) return p;
  const k = await withKey(form, p.st, p.repo, title);
  if (k instanceof Response) return k;
  const m = p.st.marker;
  const rec = p.st.rec;
  // A write user may register only the key an admin confirmed: a record written by an admin's key page action whose IDs the
  // verified marker repeats. A record the memory tool learned from the repo (a planted marker) or a changed key needs admin,
  // or a co-writer could make the memory tool seal everyone's saves under a key only they hold.
  if (!p.admin) {
    if (!rec?.confirmed || !k.verified || !m) return message("Not allowed", unconfirmedAdminOnly(p.repo), 403);
    if (m.keyId !== rec.keyId || m.repoId !== rec.repoId) return message("Not allowed", newKeyAdminOnly(p.repo), 403);
  }
  // The record follows the marker this key signed, except that registering never turns encryption off: an off marker
  // (memcrypt decrypt, or an old one put back from history) leaves an enabled record on until an admin confirms.
  // An admin's register confirms the key.
  const keptOn = Boolean(k.verified && m && rec?.enabled && !m.enabled);
  const confirmed = p.admin || Boolean(rec?.confirmed);
  if (k.verified && m) {
    const want = { repoId: m.repoId, keyId: m.keyId, enabled: m.enabled || keptOn, ...(confirmed ? { confirmed: true } : {}) };
    if (!rec || rec.repoId !== want.repoId || rec.keyId !== want.keyId || rec.enabled !== want.enabled || Boolean(rec.confirmed) !== confirmed) {
      await ring.putRecord(p.repo, want);
    }
  } else if (rec && p.admin && !rec.confirmed) {
    await ring.putRecord(p.repo, { ...rec, confirmed: true }); // no marker: the record's key, which the pasted key matched
  }
  // After the rename the repo carries the copy's marker: the move is done (the key may have expired before a read saw it).
  const move = await ring.getMove(p.repo);
  if (k.verified && m && move?.repoId === m.repoId) {
    await ring.clearMove(p.repo);
    try { await clearSnapshots(env.CACHE_KV, p.repo); } catch { /* they expire by TTL */ }
  }
  const { expiresAt } = await ring.put(p.repo, k.text, s.login, Date.now());
  if (keptOn) {
    return message("Key registered", p.admin
      ? `Key registered. Encryption stays on for ${p.repo}: its marker says it was decrypted (memcrypt decrypt?). To turn encryption off, use Confirm decryption on the key page.`
      : `Key registered. Encryption stays on for ${p.repo}; an admin can turn it off with Stop.`, 200);
  }
  return message("Key registered", `${registered(p.repo, expiresAt)} The memory tool can read and save its memories.`, 200);
};

const registered = (repo: string, expiresAt: number | null) =>
  `The key for ${repo} is registered${expiresAt === null ? "" : ` until ${new Date(expiresAt).toISOString().slice(0, 16).replace("T", " ")} UTC`}.`;

/**
 * After memcrypt decrypt: the admin pastes the key, which must sign the current marker, and that marker must say off.
 * Only then is the enabled record turned off (and the key registered). Plain register never does this.
 */
const confirmDecryption: KeyAction = async (_req, env, ring, s, form) => {
  const title = "Encryption wasn't turned off";
  const p = await prepare(env, ring, s, form, true, title);
  if (p instanceof Response) return p;
  const k = await withKey(form, p.st, p.repo, title);
  if (k instanceof Response) return k;
  const blocked = await busy(ring, p.repo);
  if (blocked) return blocked;
  const { marker: m, rec } = p.st;
  if (!rec?.enabled) return message(title, `${p.repo} isn't encrypting new saves.`, 409);
  if (!k.verified || !m || m.enabled) {
    return message(title, `The encryption marker of ${p.repo} doesn't say off, so there is no decryption to confirm. Nothing was changed.`, 409);
  }
  // memcrypt decrypt leaves no sealed memory; an old off marker put back from history does (and can't remove them without the key).
  let files;
  try { files = (await p.store.readTree(p.repo)).files; } catch (e) { return fail(title, e); }
  const sealed = files.filter((f) => parseMemoryPath(splitSet(f.path).rel) !== null && f.text !== null && isEncryptedFile(f.text)).length;
  if (sealed) {
    return message(title, `${p.repo} still has ${sealed} encrypted memory ${sealed === 1 ? "file" : "files"}, so it wasn't decrypted (an old marker put back from history?). Nothing was changed. Run memcrypt decrypt first, or use Stop to keep the encrypted memories and save new ones unencrypted.`, 409);
  }
  await ring.putRecord(p.repo, { repoId: m.repoId, keyId: m.keyId, enabled: false, confirmed: true });
  const { expiresAt } = await ring.put(p.repo, k.text, s.login, Date.now());
  return message("Encryption is off", `Encryption is off for ${p.repo}: new memories are saved unencrypted. ${registered(p.repo, expiresAt)}`, 200);
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
    await ring.putRecord(p.repo, { repoId, keyId: k.key.id, enabled: false, confirmed: true });
  } catch {
    return message("Encryption stopped, but didn't finish", `The marker of ${p.repo} now says encryption is off, but this memory tool couldn't record it, so saves stay encrypted: register the key on this page.`, 500);
  }
  return message("Encryption stopped", `New memories in ${p.repo} are saved unencrypted from now on. Existing memories stay encrypted; to decrypt them, run memcrypt decrypt (docs/ENCRYPTION.md).`, 200);
};

/** Abandons a fresh-repo move: the record from before the switch comes back and saves to the old repo go through again. */
const cancelMove: KeyAction = async (_req, env, ring, s, form) => {
  const t = await target(env, s, form, true);
  if (t instanceof Response) return t;
  const move = await ring.getMove(t.repo);
  if (!move) return message("Nothing to cancel", `No move is in progress for ${t.repo}.`, 409);
  // The record first: with the move flag gone, saves must not be sealed under the abandoned copy's repo ID.
  if (move.prevRecord) await ring.putRecord(t.repo, move.prevRecord); else await ring.deleteRecord(t.repo);
  await ring.clearMove(t.repo);
  return message("Move cancelled", `The move of ${t.repo} to ${move.to} is cancelled, and saves to ${t.repo} go through again as before. You can delete ${move.to}. To encrypt, start again from the key page with a new, empty private repo.`, 200);
};

/**
 * Drops a record the memory tool learned from repo content (a planted marker or encrypted-looking file, since removed), so
 * the repo is no longer treated as encrypted. Only while nothing in the whole repo is encrypted or marked; any marker file
 * counts, even one that doesn't parse, since the next read would learn the record again from it.
 */
const forget: KeyAction = async (_req, env, ring, s, form) => {
  const title = "Encryption wasn't forgotten";
  const t = await target(env, s, form, true);
  if (t instanceof Response) return t;
  if (await ring.isSwitching(t.repo)) return message("Busy", `Encryption is being turned on for ${t.repo}. Finish or wait for that first.`, 409);
  if (!(await ring.getRecord(t.repo))) return message(title, `${t.repo} isn't treated as encrypted.`, 409);
  let files;
  try { files = (await t.store.readTree(t.repo)).files; } catch (e) { return fail(title, e); }
  const memory = files.filter((f) => parseMemoryPath(splitSet(f.path).rel) !== null);
  const sealed = memory.filter((f) => f.text !== null && isEncryptedFile(f.text)).map((f) => f.path);
  const unreadable = memory.filter((f) => f.text === null).map((f) => f.path);
  const still = [
    files.some((f) => f.path === MARKER_PATH) ? `an encryption marker (${MARKER_PATH})` : "",
    sealed.length ? `${sealed.length} encrypted memory ${sealed.length === 1 ? "file" : "files"} (${sealed.join(", ")})` : "",
    unreadable.length ? `${unreadable.length} memory ${unreadable.length === 1 ? "file" : "files"} that couldn't be read (${unreadable.join(", ")})` : "",
  ].filter(Boolean);
  if (still.length) {
    return message(title, `${t.repo} still has ${still.join(" and ")}, so it stays encrypted. Nothing was changed.`, 409);
  }
  await ring.deleteRecord(t.repo);
  await ring.remove(t.repo);
  await ring.clearMove(t.repo);
  try { await clearSnapshots(env.CACHE_KV, t.repo); } catch { /* they expire by TTL */ }
  return message("Encryption forgotten", `${t.repo} isn't treated as encrypted any more.`, 200);
};

/** POST /keys/<name> handlers; key-page.ts runs them only after the Origin, session and csrf checks. */
export const actions: Record<string, KeyAction> = {
  "turn-on": turnOn, "turn-on/confirm": confirm, register, remove, stop, "cancel-move": cancelMove, "confirm-decryption": confirmDecryption, forget,
};
