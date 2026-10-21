import { OpError } from "./errors";

export const KEY_PREFIX = "cmk1_";
export interface RepoKey { fileKey: CryptoKey; macKey: CryptoKey; id: string }

/** Thrown by open() for any failure (wrong key, wrong AAD, tampering, malformed blob); never says which. */
export class DecryptError extends Error {
  constructor() { super("decryption failed"); }
}

const enc = new TextEncoder();
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const toB64Url = (b: Uint8Array) => toB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const rand = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export const generateKeyText = () => KEY_PREFIX + toB64Url(rand(32));

async function hkdf(ikm: CryptoKey, info: string, bits: number): Promise<ArrayBuffer> {
  return crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) }, ikm, bits);
}

/** Derives the file key, marker-MAC key and key ID from key text; the error never echoes the input. */
export async function parseKeyText(text: string): Promise<RepoKey> {
  const t = text.trim();
  if (!/^cmk1_[A-Za-z0-9_-]{43}$/.test(t)) throw new OpError("invalid", "That isn't a claude-memory repo key.");
  const raw = fromB64(t.slice(KEY_PREFIX.length).replace(/-/g, "+").replace(/_/g, "/") + "=");
  const ikm = await crypto.subtle.importKey("raw", raw, "HKDF", false, ["deriveBits"]);
  const [file, id, mac] = await Promise.all([hkdf(ikm, "claude-memory v1 file-key", 256), hkdf(ikm, "claude-memory v1 key-id", 64), hkdf(ikm, "claude-memory v1 marker-mac", 256)]);
  return {
    fileKey: await crypto.subtle.importKey("raw", file, "AES-GCM", false, ["encrypt", "decrypt"]),
    macKey: await crypto.subtle.importKey("raw", mac, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
    id: [...new Uint8Array(id)].map((b) => b.toString(16).padStart(2, "0")).join(""),
  };
}

/** Standard base64 of iv(12) ‖ ciphertext ‖ tag(16); `iv` is for tests only. */
export async function seal(key: CryptoKey, plaintext: string, aad: string, iv: Uint8Array = rand(12)): Promise<string> {
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, key, enc.encode(plaintext)));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv); out.set(ct, 12);
  return toB64(out);
}

export async function open(key: CryptoKey, sealed: string, aad: string): Promise<string> {
  try {
    const b = fromB64(sealed);
    if (b.length < 28) throw 0;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(0, 12), additionalData: enc.encode(aad) }, key, b.slice(12));
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(pt);
  } catch { throw new DecryptError(); }
}

export async function hmacHex(key: CryptoKey, message: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** MEMORY_MASTER_KEY: standard base64 of 32 bytes, as an AES-GCM key for wrapping repo keys. */
export async function parseMasterKey(text: string): Promise<CryptoKey> {
  let raw: Uint8Array | undefined;
  try { raw = fromB64(text.trim()); } catch { /* falls through */ }
  if (!raw || raw.length !== 32) throw new Error("MEMORY_MASTER_KEY must be base64 of 32 bytes");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export const newRepoId = () => toB64Url(rand(16));
