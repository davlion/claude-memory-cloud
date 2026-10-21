import { DecryptError, hmacHex, open, seal, type RepoKey } from "./crypto";
import { OpError } from "./errors";
import { parseMemoryPath } from "./memory";

export const MARKER_PATH = ".claude-memory/encryption.json";
export interface Marker { enabled: boolean; repoId: string; keyId: string; mac: string }

const invalidMarker = () => new OpError("internal", "The repo's encryption marker is invalid.", "Restore .claude-memory/encryption.json in the memory repo.");

/** The fixed formats: a repo ID is base64url of 16 bytes, a key ID 8 bytes and a MAC 32 bytes of lower-case hex (none can hold a newline). */
const REPO_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const KEY_ID_RE = /^[0-9a-f]{16}$/;
const MAC_RE = /^[0-9a-f]{64}$/;

export function parseMarker(text: string): Marker {
  let j: Record<string, unknown>;
  try { j = JSON.parse(text) as Record<string, unknown>; } catch { throw invalidMarker(); }
  if (!j || typeof j !== "object" || j.format !== 1 || typeof j.enabled !== "boolean"
    || typeof j.repo_id !== "string" || typeof j.key_id !== "string" || typeof j.mac !== "string"
    || !REPO_ID_RE.test(j.repo_id) || !KEY_ID_RE.test(j.key_id) || !MAC_RE.test(j.mac)) throw invalidMarker();
  return { enabled: j.enabled, repoId: j.repo_id, keyId: j.key_id, mac: j.mac };
}

const markerMessage = (m: Omit<Marker, "mac">) => `claude-memory-marker-v1\n1\n${m.enabled}\n${m.repoId}\n${m.keyId}`;

export async function signMarker(key: RepoKey, m: Omit<Marker, "mac">): Promise<Marker> {
  return { enabled: m.enabled, repoId: m.repoId, keyId: m.keyId, mac: await hmacHex(key.macKey, markerMessage(m)) };
}

export async function markerSignedBy(key: RepoKey, m: Marker): Promise<boolean> {
  const want = await hmacHex(key.macKey, markerMessage(m));
  if (want.length !== m.mac.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m.mac.charCodeAt(i);
  return diff === 0;
}

export const serializeMarker = (m: Marker) =>
  JSON.stringify({ format: 1, enabled: m.enabled, repo_id: m.repoId, key_id: m.keyId, mac: m.mac }, null, 2) + "\n";

const FILE_RE = /^---\nencrypted: claude-memory-v1\nname: ([a-z0-9][a-z0-9-]{0,63})\nkey_id: ([0-9a-f]{16})\n---\n([A-Za-z0-9+/]+={0,2})\n?$/;
export const isEncryptedFile = (text: string) => text.startsWith("---\nencrypted: claude-memory-v1\n");

export const aadFor = (repoId: string, fullPath: string) => `claude-memory-v1\n${repoId}\n${fullPath}`;

/** The memory name a path stands for (a conflict copy's original), from its `memories/…` tail. */
function nameOf(fullPath: string): string | undefined {
  const tail = /(?:^|\/)(memories\/[^/]+)$/.exec(fullPath)?.[1];
  return tail ? parseMemoryPath(tail)?.name : undefined;
}

export async function sealMemoryFile(key: RepoKey, repoId: string, fullPath: string, plaintext: string, iv?: Uint8Array): Promise<string> {
  const name = nameOf(fullPath);
  if (!name) throw new OpError("internal", "Not a memory file path.");
  const blob = await seal(key.fileKey, plaintext, aadFor(repoId, fullPath), iv);
  return `---\nencrypted: claude-memory-v1\nname: ${name}\nkey_id: ${key.id}\n---\n${blob}\n`;
}

export async function openMemoryFile(key: RepoKey, repoId: string, fullPath: string, text: string): Promise<string> {
  const m = FILE_RE.exec(text);
  if (!m || m[2] !== key.id || m[1] !== nameOf(fullPath)) throw new DecryptError();
  return open(key.fileKey, m[3] as string, aadFor(repoId, fullPath));
}
