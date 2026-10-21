import { toB64Url } from "./crypto";
import { EncryptingStore } from "./encrypting-store";
import type { Env } from "./env";
import { MASTER_KEY_MISCONFIGURED, SCOPES_MISCONFIGURED } from "./errors";
import { GitHub, toOpError } from "./github";
import { exchangeCode, isAllowedUser, notAllowed, s256, ScopesError } from "./github-auth";
import { scopeReachabilityDetailed } from "./health";
import { actions, same, sidHash } from "./key-actions";
import { keysHome, message, messageHtml, notOnPage, page, reloadPage, type RepoView } from "./key-page-html";
import { KeyRing } from "./keyring";
import { idPinKey, parseScopeMap, REPO_RE, scopesFor, type ScopeConfig } from "./scopes";
import { GitHubStore } from "./store";

const SESSION_TTL = 3600;
const STATE_TTL = 600;
const SESSION_COOKIE = "__Host-keys";
const LOGIN_COOKIE = "__Host-keys-login";
const CLEAR_LOGIN = `${LOGIN_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const SECURITY: Record<string, string> = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
};

/** A signed-in key page browser. `token` is the unwrapped GitHub token; `id` is the numeric GitHub user ID. */
export interface KeySession { sid: string; login: string; id: number; csrf: string; token: string; cfg: ScopeConfig }
/** POST /keys/<action> handlers, run only after the session and its csrf check out. */
export type KeyAction = (req: Request, env: Env, ring: KeyRing, s: KeySession, form: FormData) => Promise<Response>;
export const keyActions: Record<string, KeyAction> = actions;
export { mayChangeEncryption } from "./key-actions";
export { message, messageHtml };

export const sessionAad = (sid: string) => `keysession-v1\n${sid}`;
/** KV holds the session under a hash of its id, so reading KV never yields a working cookie. */
const sessionKey = async (sid: string) => `keysession:${await sidHash(sid)}`;
const random = () => toB64Url(crypto.getRandomValues(new Uint8Array(32)));
const validRepo = (v: string | null | undefined) => (v && REPO_RE.test(v) ? v : null);
const keysPath = (repo: string | null) => (repo ? `/keys?repo=${encodeURIComponent(repo)}` : "/keys");

const redirect = (location: string, cookies: string[] = []) => {
  const h = new Headers({ Location: location });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 302, headers: h });
};
const unavailable = () => message("The key page is unavailable", "The memory server couldn't check its settings right now. Try again in a moment.", 503);
const scopesBroken = () => message("The key page is unavailable", `${SCOPES_MISCONFIGURED.message}. ${SCOPES_MISCONFIGURED.action}.`, 503);

/** Adds the key page security headers; index.ts uses it for responses it answers itself (429). */
export function harden(res: Response): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY)) out.headers.set(k, v);
  return out;
}

function cookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/** The session behind the `__Host-keys` cookie, still on the allowlist; otherwise the response to send. */
export async function requireSession(req: Request, env: Env, ring?: KeyRing): Promise<KeySession | Response> {
  const keys = ring ?? (await KeyRing.fromEnv(env))!;
  const sid = cookie(req, SESSION_COOKIE);
  const raw = sid && TOKEN_RE.test(sid) ? await env.OAUTH_KV.get(await sessionKey(sid)) : null;
  let s: Omit<KeySession, "sid" | "cfg"> | null = null;
  if (sid && raw) {
    try {
      const v = JSON.parse(raw) as { login: string; id: number; csrf: string; token: string };
      const token = await keys.unwrapText(v.token, sessionAad(sid));
      if (token) s = { login: v.login, id: v.id, csrf: v.csrf, token };
    } catch { /* unreadable session: none */ }
  }
  if (!s) {
    if (req.method !== "GET") return messageHtml("Sign in again", 'Your key page session ended. <a href="/keys">Sign in again</a>.', 403);
    const path = keysPath(validRepo(new URL(req.url).searchParams.get("repo")));
    // A link from another site carries no SameSite=Strict cookie; a reload from this page does.
    if (req.headers.get("sec-fetch-site") === "cross-site") return page(reloadPage(path));
    return redirect(`/keys/login${path.slice("/keys".length)}`);
  }
  let cfg: ScopeConfig | undefined;
  try { cfg = scopesFor(parseScopeMap(env.SCOPES), s.login); } catch { return scopesBroken(); }
  const pinned = await env.OAUTH_KV.get(idPinKey(s.login));
  if (!cfg || (pinned !== null && pinned !== String(s.id))) {
    await env.OAUTH_KV.delete(await sessionKey(sid!));
    return notAllowed(s.login);
  }
  return { ...s, sid: sid!, cfg };
}

async function login(url: URL, env: Env): Promise<Response> {
  const verifier = random();
  const state = random();
  const repo = validRepo(url.searchParams.get("repo"));
  await env.OAUTH_KV.put(`keystate:${state}`, JSON.stringify({ verifier, repo }), { expirationTtl: STATE_TTL });
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${env.PUBLIC_URL}/keys/callback`, state,
    code_challenge: await s256(verifier), code_challenge_method: "S256",
  }).toString();
  return redirect(gh.toString(), [`${LOGIN_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax`]);
}

async function callback(req: Request, url: URL, env: Env, ring: KeyRing): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const bound = cookie(req, LOGIN_COOKIE);
  const expired = () => messageHtml("Sign-in could not continue",
    'This sign-in expired, was already used, or was started in another browser. <a href="/keys">Start again</a>.', 400, [CLEAR_LOGIN]);
  if (!TOKEN_RE.test(state) || !bound || !same(state, bound)) return expired();
  const raw = await env.OAUTH_KV.get(`keystate:${state}`);
  if (!raw) return expired();
  await env.OAUTH_KV.delete(`keystate:${state}`);
  const { verifier, repo } = JSON.parse(raw) as { verifier: string; repo: string | null };
  const code = url.searchParams.get("code");
  if (url.searchParams.get("error") || !code) {
    return messageHtml("Sign-in was cancelled", '<a href="/keys">Start again</a>.', 400, [CLEAR_LOGIN]);
  }
  let token: string;
  let user: { login: string; id: number };
  try {
    token = (await exchangeCode(env, code, verifier, `${env.PUBLIC_URL}/keys/callback`)).accessToken;
    const res = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "claude-memory-cloud" },
    });
    if (!res.ok) throw new Error("user lookup failed");
    user = (await res.json()) as { login: string; id: number };
  } catch {
    return messageHtml("Sign-in failed", '<a href="/keys">Try again</a>.', 502, [CLEAR_LOGIN]);
  }
  let allowed: boolean;
  try {
    allowed = await isAllowedUser(env, user);
  } catch (e) {
    return e instanceof ScopesError ? scopesBroken() : unavailable();
  }
  if (!allowed) {
    const res = notAllowed(user.login);
    res.headers.append("Set-Cookie", CLEAR_LOGIN);
    return res;
  }
  const sid = random();
  const session = { login: user.login, id: user.id, csrf: random(), token: await ring.wrapText(token, sessionAad(sid)) };
  await env.OAUTH_KV.put(await sessionKey(sid), JSON.stringify(session), { expirationTtl: SESSION_TTL });
  // Not a 302: after GitHub's redirect chain some browsers withhold the new Strict cookie; a reload from this page sends it.
  return page(reloadPage(keysPath(validRepo(repo))), 200, [`${SESSION_COOKIE}=${sid}; Path=/; Secure; HttpOnly; SameSite=Strict`, CLEAR_LOGIN]);
}

async function home(req: Request, url: URL, env: Env, ring: KeyRing): Promise<Response> {
  const s = await requireSession(req, env, ring);
  if (s instanceof Response) return s;
  const gh = new GitHub(s.token);
  const { reach, listingError } = await scopeReachabilityDetailed(gh, s.cfg, env.GITHUB_APP_SLUG);
  const repos = [...new Map(reach.filter((r) => r.reachable && r.writable).map((r) => [r.repo.toLowerCase(), r])).values()];
  const failed = listingError ?? reach.find((r) => r.reason === "error")?.error;
  const problem = failed ? `Some memory repos couldn't be checked: ${toOpError(failed).message}` : undefined;
  const store = new EncryptingStore(new GitHubStore(gh, env.CACHE_KV), ring, `${env.PUBLIC_URL}/keys`, env.CACHE_KV);
  const views = await Promise.all(repos.map(async ({ repo, admin }): Promise<RepoView> => {
    try {
      const status = await store.status(repo, "");
      const k = await ring.get(repo);
      return { repo, admin, status, key: k && { registeredBy: k.registeredBy, expiresAt: k.expiresAt } };
    } catch (e) {
      return { repo, admin, status: null, key: null, error: toOpError(e).message };
    }
  }));
  const selected = validRepo(url.searchParams.get("repo"));
  return page(keysHome({ login: s.login, csrf: s.csrf, repos: views, selected, problem }));
}

async function post(req: Request, url: URL, env: Env, ring: KeyRing): Promise<Response> {
  const origin = req.headers.get("origin");
  if (origin !== null && origin !== new URL(env.PUBLIC_URL).origin) return message("Not allowed", "This form came from another site.", 403);
  const s = await requireSession(req, env, ring);
  if (s instanceof Response) return s;
  let form: FormData;
  try { form = await req.formData(); } catch { return message("Bad request", "The form couldn't be read.", 400); }
  const csrf = form.get("csrf");
  if (typeof csrf !== "string" || !same(csrf, s.csrf)) {
    return messageHtml("Not allowed", 'This form is out of date. <a href="/keys">Reload the key page</a> and try again.', 403);
  }
  const name = url.pathname.slice("/keys/".length);
  const action = Object.hasOwn(keyActions, name) ? keyActions[name] : undefined;
  return action ? action(req, env, ring, s, form) : message("Not found", "Unknown action.", 404);
}

async function route(req: Request, env: Env): Promise<Response> {
  let ring: KeyRing | null;
  try { ring = await KeyRing.fromEnv(env); } catch {
    return message("The key page is unavailable", `${MASTER_KEY_MISCONFIGURED.message}.`, 503);
  }
  if (!ring) return page(notOnPage(), 404);
  const url = new URL(req.url);
  const p = url.pathname;
  if (req.method === "GET" && p === "/keys") return home(req, url, env, ring);
  if (req.method === "GET" && p === "/keys/login") return login(url, env);
  if (req.method === "GET" && p === "/keys/callback") return callback(req, url, env, ring);
  if (req.method === "POST") return post(req, url, env, ring);
  return messageHtml("Not found", '<a href="/keys">Key page</a>.', 404);
}

export const keyPage = {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return harden(await route(req, env));
    } catch {
      // Never echo the error: it could carry request details. KV or GitHub trouble lands here.
      return harden(unavailable());
    }
  },
};
