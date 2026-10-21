import { newRepoId, parseKeyText, type RepoKey } from "./crypto";
import { isEncryptedFile, MARKER_PATH, markerSignedBy, openMemoryFile, parseMarker, sealMemoryFile, serializeMarker, signMarker, type Marker } from "./encrypted-files";
import { OpError } from "./errors";
import type { KeyRing } from "./keyring";
import { namesOnlyIndex, parseMemoryPath } from "./memory";
import { clearSnapshots, splitSet, type GitHubStore, type TreeFile, type TreeWrite } from "./store";

export const trailers = (login: string) => `\n\nMemory-Source: key page (${login})\nMemory-Scope: *\n`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The repo's whole tree with every memory sealed under `key`, names-only `MEMORY.md` files and a signed `enabled: true` marker.
 * Files already sealed must open with `key`; anything else is kept by SHA and mode.
 */
export async function planEncryptedTree(files: TreeFile[], key: RepoKey, existing: Marker | null): Promise<{ files: TreeWrite[]; marker: Marker }> {
  // An existing marker's repo ID is kept only when this key signed it; sealed files then still open.
  const repoId = existing && await markerSignedBy(key, existing) ? existing.repoId : newRepoId();
  const unreadable: string[] = [];
  const out: TreeWrite[] = [];
  for (const f of files) {
    if (f.path === MARKER_PATH) continue;
    const { rel } = splitSet(f.path);
    const isIndex = rel === "MEMORY.md";
    if (!isIndex && !parseMemoryPath(rel)) { out.push({ path: f.path, mode: f.mode, sha: f.sha }); continue; }
    if (f.text === null) { unreadable.push(f.path); continue; }
    if (isIndex) out.push({ path: f.path, mode: f.mode, content: namesOnlyIndex(f.text) });
    else if (isEncryptedFile(f.text)) {
      try { await openMemoryFile(key, repoId, f.path, f.text); } catch { throw new OpError("invalid", "That key doesn't match this repo."); }
      out.push({ path: f.path, mode: f.mode, sha: f.sha });
    } else out.push({ path: f.path, mode: f.mode, content: await sealMemoryFile(key, repoId, f.path, f.text) });
  }
  if (unreadable.length) {
    throw new OpError("write_rejected", `Encryption wasn't turned on: these memory files couldn't be read: ${unreadable.join(", ")}.`,
      "Fix or remove those files in the memory repo, then try again. Nothing was changed.");
  }
  const marker = await signMarker(key, { enabled: true, repoId, keyId: key.id });
  out.push({ path: MARKER_PATH, mode: "100644", content: serializeMarker(marker) });
  return { files: out, marker };
}

/** The current marker; an unparseable one counts as absent (a new repo ID, so files sealed under the old one fail to open). */
const existingMarker = (files: TreeFile[]): Marker | null => {
  const f = files.find((x) => x.path === MARKER_PATH);
  if (!f) return null;
  try { return parseMarker(f.text ?? ""); } catch { return null; }
};

/** Turns encryption on by replacing the repo's history with one root commit. Saves are held off while it runs. */
export async function switchOnInPlace(store: GitHubStore, keys: KeyRing, cache: KVNamespace, repo: string, keyText: string, login: string): Promise<{ url: string }> {
  const key = await parseKeyText(keyText);
  await keys.setSwitching(repo);
  try {
    const tree = await store.readTree(repo);
    if (!tree.isPrivate) throw new OpError("repo_public", `${repo} is not private, so encryption wasn't turned on.`, "Make the repo private, then try again.");
    const extra = await store.extraRefs(repo);
    if (extra.branches || extra.tags || extra.pulls) {
      const what = [
        extra.branches ? plural(extra.branches, "other branch", "other branches") : "",
        extra.tags ? plural(extra.tags, "tag", "tags") : "",
        extra.pulls ? plural(extra.pulls, "pull request", "pull requests") : "",
      ].filter(Boolean).join(", ");
      throw new OpError("invalid", `${repo} has ${what}, which would keep the old plaintext reachable. Nothing was changed.`,
        extra.pulls ? "Pull requests can't be deleted: move to a fresh repo instead." : "Delete the other branches and tags, then try again, or move to a fresh repo instead.");
    }
    const plan = await planEncryptedTree(tree.files, key, existingMarker(tree.files));
    const message = `encrypt: switch on, history squashed${trailers(login)}`;
    const res = tree.head === null
      ? await store.writeFirstCommit(repo, plan.files, message)
      : await store.replaceHistory(repo, tree.head, plan.files, message);
    await keys.putRecord(repo, { repoId: plan.marker.repoId, keyId: key.id, enabled: true });
    await keys.put(repo, keyText, login, Date.now());
    await clearSnapshots(cache, repo);
    return { url: res.url };
  } finally {
    await keys.clearSwitching(repo);
  }
}

/**
 * Turns encryption on by writing an encrypted copy of `repo` into the empty private `newRepo`. The user then deletes `repo`
 * and renames `newRepo` to it, so the record and key are stored under `repo`; saves to `repo` wait for that (the move flag).
 */
export async function switchOnFresh(store: GitHubStore, keys: KeyRing, cache: KVNamespace, repo: string, newRepo: string, keyText: string, login: string): Promise<{ url: string }> {
  const key = await parseKeyText(keyText);
  if (newRepo.toLowerCase() === repo.toLowerCase()) throw new OpError("invalid", "The new repo must be a different repo.", "Create a new, empty private repo.");
  const target = await store.readTree(newRepo);
  if (!target.isPrivate) throw new OpError("repo_public", `${newRepo} is not private.`, "Make it private, then try again.");
  if (!target.canWrite) throw new OpError("invalid", `You can't write to ${newRepo}.`, "Add it to the app installation and make sure you have write access, then try again.");
  if (target.head !== null) throw new OpError("invalid", `${newRepo} isn't empty.`, "Create a new, empty private repo (no README) and try again.");
  await keys.setSwitching(repo);
  try {
    const tree = await store.readTree(repo);
    const plan = await planEncryptedTree(tree.files, key, existingMarker(tree.files));
    const res = await store.writeFirstCommit(newRepo, plan.files, `encrypt: fresh encrypted copy of ${repo}${trailers(login)}`, repo);
    // A save that landed in `repo` during the copy would be lost with the old repo.
    if (await store.currentHead(repo) !== tree.head) {
      throw new OpError("unavailable", "The memory repo changed while its encrypted copy was being written; nothing was switched.",
        `Delete and recreate ${newRepo} as an empty private repo, then try again.`);
    }
    await keys.setMove(repo, { to: newRepo, repoId: plan.marker.repoId, head: tree.head, prevRecord: await keys.getRecord(repo) });
    await keys.putRecord(repo, { repoId: plan.marker.repoId, keyId: key.id, enabled: true });
    await keys.put(repo, keyText, login, Date.now());
    await clearSnapshots(cache, repo);
    return { url: res.url };
  } finally {
    await keys.clearSwitching(repo);
  }
}
