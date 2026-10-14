import { AuthorizationError, authorizationErrorRedirect, CimdFetchError, OAuthError, type AuthRequest, type ClientRegistrationCallbackResult, type TokenExchangeCallbackResult } from "@cloudflare/workers-oauth-provider";
import { consentPage, esc } from "./consent";
import { SCOPES_MISCONFIGURED } from "./errors";
import type { Env, Props } from "./env";
import { parseScopeMap, scopesFor } from "./scopes";

const ALLOWED = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);

export function isAllowedRedirect(uri: string): boolean {
  if (ALLOWED.has(uri)) return true;
  try {
    const u = new URL(uri);
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/** DCR filter (spec §10b): store a client only if every redirect URI is on the allowlist, so junk registrations cost nothing. */
export function checkRegistration(meta: Record<string, unknown>): ClientRegistrationCallbackResult | undefined {
  const uris = meta.redirect_uris;
  if (Array.isArray(uris) && uris.length > 0 && uris.every((u) => typeof u === "string" && isAllowedRedirect(u))) return undefined;
  return {
    code: "invalid_redirect_uri",
    description: "redirect_uris must be https://claude.ai/api/mcp/auth_callback, https://claude.com/api/mcp/auth_callback, or a loopback http:// URL",
    status: 400,
  };
}

export async function s256(verifier: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function tokenRequest(env: Env, params: Record<string, string>) {
  // Network errors and non-JSON bodies are reported as { ok: false, data: {} } rather than thrown.
  try {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded", "user-agent": "claude-memory-cloud" },
      body: new URLSearchParams({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
    });
    const data = (res.ok ? await res.json() : {}) as Record<string, unknown>;
    return { res: { ok: res.ok, status: res.status }, data };
  } catch {
    return { res: { ok: false, status: 0 }, data: {} as Record<string, unknown> };
  }
}

export async function exchangeCode(env: Env, code: string, verifier: string) {
  const { res, data } = await tokenRequest(env, { code, code_verifier: verifier, redirect_uri: `${env.PUBLIC_URL}/callback` });
  if (!res.ok || data.error || !data.access_token) throw new Error(`GitHub code exchange failed: ${String(data.error ?? res.status)}`);
  return { accessToken: String(data.access_token), refreshToken: String(data.refresh_token ?? ""), expiresIn: Number(data.expires_in ?? 28800) };
}

export async function refreshGitHubToken(env: Env, refreshToken: string) {
  const { res, data } = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: refreshToken });
  if (res.ok && data.access_token) {
    return { ok: true as const, accessToken: String(data.access_token), refreshToken: data.refresh_token ? String(data.refresh_token) : refreshToken, expiresIn: Number(data.expires_in ?? 28800) };
  }
  return { ok: false as const, revoked: res.ok && data.error === "bad_refresh_token" };
}

/** Grant lifetime (spec §10b): 30 days sliding idle, 180 days absolute from sign-in. */
export const GRANT_IDLE_SECONDS = 30 * 86400;
export const GRANT_MAX_SECONDS = 180 * 86400;

/**
 * Runs on every MCP token exchange. On a refresh: slides the grant (capped at 180 days from sign-in), and refreshes the
 * upstream GitHub token when it is within 2 h of expiry. Only a dead GitHub token with a rejected refresh token revokes
 * the grant (invalid_grant); while the GitHub token still works, a lost refresh race or an outage never does.
 */
export async function tokenExchangeCallback(o: { grantType: string; props: Props; env: Env; now?: number }): Promise<TokenExchangeCallbackResult | undefined> {
  if (o.grantType !== "refresh_token") return undefined;
  const now = o.now ?? Date.now();
  const authorizedAt = o.props.authorizedAt ?? now;
  const left = Math.floor((authorizedAt + GRANT_MAX_SECONDS * 1000 - now) / 1000);
  if (left < 60) throw new OAuthError("invalid_grant", { description: "This connection is 180 days old; reconnect" });
  const out: TokenExchangeCallbackResult = { refreshTokenIdleTTL: Math.min(GRANT_IDLE_SECONDS, left) };
  const props: Props = o.props.authorizedAt === undefined ? { ...o.props, authorizedAt } : o.props;
  if (props !== o.props) out.newProps = props;

  if (o.props.githubTokenExpiresAt - now > 2 * 3600_000) return out;
  const stillValid = o.props.githubTokenExpiresAt - now > 60_000;
  if (!o.props.githubRefreshToken) {
    if (stillValid) return out;
    throw new OAuthError("invalid_grant", { description: "GitHub sign-in expired; reconnect" });
  }
  const r = await refreshGitHubToken(o.env, o.props.githubRefreshToken);
  if (r.ok) {
    out.newProps = { ...props, githubToken: r.accessToken, githubRefreshToken: r.refreshToken, githubTokenExpiresAt: now + r.expiresIn * 1000 };
    return out;
  }
  if (stillValid) {
    // bad_refresh_token here means another request already rotated the refresh token (or its grant write was lost).
    if (r.revoked) throw new OAuthError("temporarily_unavailable", { description: "GitHub token refresh raced another request; retry", statusCode: 503 });
    return out; // GitHub hiccup: keep the grant and the still-valid token; the next refresh retries
  }
  if (r.revoked) throw new OAuthError("invalid_grant", { description: "GitHub access was revoked" });
  throw new OAuthError("temporarily_unavailable", { description: "GitHub is unavailable", statusCode: 503 });
}

class ScopesError extends Error {}

const html = (body: string, status = 400) => new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

async function startUpstream(env: Env, request: AuthRequest, headers?: Headers) {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const up = await env.OAUTH_PROVIDER.beginUpstream(request, { data: { verifier }, headers });
  const gh = new URL("https://github.com/login/oauth/authorize");
  gh.search = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID, redirect_uri: `${env.PUBLIC_URL}/callback`, state: up.state,
    code_challenge: await s256(verifier), code_challenge_method: "S256",
  }).toString();
  up.headers.set("Location", gh.toString());
  return new Response(null, { status: 302, headers: up.headers });
}

export const authHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env);
    } catch (e) {
      // Validation failures carry no secrets; render locally, or redirect only when the library says it is safe.
      if (e instanceof AuthorizationError) {
        if (e.redirectTo && e.redirectUri && isAllowedRedirect(e.redirectUri)) return new Response(null, { status: 302, headers: { Location: e.redirectTo } });
        return html("<h1>Sign-in could not continue</h1><p>This page expired, was already used, or was opened in another browser. Start again from the app.</p>");
      }
      if (e instanceof CimdFetchError) return html("<h1>This app could not be verified</h1>");
      throw e;
    }
  },
};

const notAllowed = (login: string) => html(
  `<h1>This GitHub account isn't on this memory server</h1><p>You signed in to GitHub as <strong>${esc(login)}</strong>. Ask the server's owner to add this account, or sign in to GitHub with the account they added, then connect again.</p>`,
  403);

/**
 * Sign-in allowlist (spec §10b): the login must be a key in SCOPES, and its numeric GitHub ID must match the one
 * recorded at that login's first sign-in, so a renamed and re-registered login is refused.
 */
export async function isAllowedUser(env: Env, user: { login: string; id: number }): Promise<boolean> {
  let cfg;
  try {
    cfg = scopesFor(parseScopeMap(env.SCOPES), user.login);
  } catch {
    throw new ScopesError();
  }
  if (!cfg) return false;
  const key = `allowlist:github-id:${user.login.toLowerCase()}`;
  const pinned = await env.OAUTH_KV.get(key);
  if (pinned === null) {
    try { await env.OAUTH_KV.put(key, String(user.id)); } catch { /* recorded at a later sign-in */ }
    return true;
  }
  return pinned === String(user.id);
}

async function handle(req: Request, env: Env): Promise<Response> {
  {
    const url = new URL(req.url);
    const oauth = env.OAUTH_PROVIDER;

    if (url.pathname === "/authorize" && req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      if (!isAllowedRedirect(request.redirectUri)) return html("<h1>Redirect URI not allowed</h1>");
      // Consent is asked every time: remembered consent let a link from someone else's flow run through this browser (TM §6).
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }

    if (url.pathname === "/authorize" && req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle"));
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        denied.headers.set("Location", denied.redirectTo);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(req, handle);
      if (!isAllowedRedirect(approved.request.redirectUri)) return html("<h1>Redirect URI not allowed</h1>");
      return startUpstream(env, approved.request, approved.headers);
    }

    if (url.pathname === "/callback" && req.method === "GET") {
      const { request, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
      const code = url.searchParams.get("code");
      if (url.searchParams.get("error") || !code) {
        headers.set("Location", authorizationErrorRedirect(request, "access_denied"));
        return new Response(null, { status: 302, headers });
      }
      const failed = () => html("<h1>Sign-in failed</h1><p>Please try connecting again.</p>", 502);
      let tok: Awaited<ReturnType<typeof exchangeCode>>;
      let user: { login: string; id: number };
      try {
        tok = await exchangeCode(env, code, data.verifier);
        const userRes = await fetch("https://api.github.com/user", {
          headers: { authorization: `Bearer ${tok.accessToken}`, accept: "application/vnd.github+json", "user-agent": "claude-memory-cloud" },
        });
        if (!userRes.ok) return failed();
        user = (await userRes.json()) as { login: string; id: number };
      } catch {
        return failed();
      }
      let allowed: boolean;
      try {
        allowed = await isAllowedUser(env, user);
      } catch (e) {
        // A bad SCOPES secret or an unavailable KV is the server's problem: say so on a page, never a bare 500.
        return e instanceof ScopesError
          ? html(`<h1>Sign-in is unavailable</h1><p>${esc(SCOPES_MISCONFIGURED.message)}.</p><p>${esc(SCOPES_MISCONFIGURED.action!)}.</p>`, 503)
          : html("<h1>Sign-in is unavailable</h1><p>The memory server could not check its allowlist right now. Try connecting again in a moment.</p>", 503);
      }
      if (!allowed) return notAllowed(user.login);
      const props: Props = {
        login: user.login, githubToken: tok.accessToken, githubRefreshToken: tok.refreshToken,
        githubTokenExpiresAt: Date.now() + tok.expiresIn * 1000, authorizedAt: Date.now(), githubId: user.id,
      };
      const { redirectTo } = await oauth.completeAuthorization({
        request, userId: String(user.id), metadata: { label: user.login }, scope: request.scope, props,
      });
      headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers });
    }

    return new Response("not found", { status: 404 });
  }
}
