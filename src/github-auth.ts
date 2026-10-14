import { AuthorizationError, authorizationErrorRedirect, CimdFetchError, OAuthError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { consentPage, esc } from "./consent";
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

/** Refresh the upstream GitHub token when our refresh grant runs and GitHub's token is within 2h of expiry. */
export async function tokenExchangeCallback(o: { grantType: string; props: Props; env: Env }) {
  if (o.grantType !== "refresh_token") return;
  if (o.props.githubTokenExpiresAt - Date.now() > 2 * 3600_000) return;
  if (!o.props.githubRefreshToken) throw new OAuthError("invalid_grant", { description: "GitHub sign-in expired; reconnect" });
  const r = await refreshGitHubToken(o.env, o.props.githubRefreshToken);
  if (!r.ok && r.revoked) throw new OAuthError("invalid_grant", { description: "GitHub access was revoked" });
  if (!r.ok) throw new OAuthError("temporarily_unavailable", { description: "GitHub is unavailable", statusCode: 503 });
  return { newProps: { ...o.props, githubToken: r.accessToken, githubRefreshToken: r.refreshToken, githubTokenExpiresAt: Date.now() + r.expiresIn * 1000 } };
}

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
  if (!scopesFor(parseScopeMap(env.SCOPES), user.login)) return false;
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
    const remember = { secret: env.COOKIE_ENCRYPTION_KEY, maxAgeSeconds: 30 * 86400 };

    if (url.pathname === "/authorize" && req.method === "GET") {
      const request = await oauth.parseAuthRequest(req);
      if (!isAllowedRedirect(request.redirectUri)) return html("<h1>Redirect URI not allowed</h1>");
      if (await oauth.isConsentRemembered(req, request, { secret: env.COOKIE_ENCRYPTION_KEY })) return startUpstream(env, request);
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
      const approved = await oauth.approveConsent(req, handle, { remember });
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
      if (!(await isAllowedUser(env, user))) return notAllowed(user.login);
      const props: Props = {
        login: user.login, githubToken: tok.accessToken, githubRefreshToken: tok.refreshToken,
        githubTokenExpiresAt: Date.now() + tok.expiresIn * 1000,
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
