import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./env";
import { authHandler, checkRegistration, GRANT_IDLE_SECONDS, GRANT_MAX_SECONDS, tokenExchangeCallback } from "./github-auth";
import { harden, keyPage } from "./key-page";
import { landing } from "./key-page-html";
import { mcpApi } from "./mcp-api";

let provider: OAuthProvider<Env> | undefined;
function getProvider(env: Env) {
  provider ??= new OAuthProvider<Env>({
    apiRoute: "/mcp",
    apiHandler: mcpApi as never,
    defaultHandler: authHandler as never,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: { resource: `${env.PUBLIC_URL}/mcp`, authorization_servers: [env.PUBLIC_URL] },
    scopesSupported: ["memory"],
    // Spec §10b: 30 days sliding idle; tokenExchangeCallback caps the grant at 180 days from sign-in.
    refreshTokenTTL: GRANT_IDLE_SECONDS,
    refreshTokenIdleTTL: GRANT_IDLE_SECONDS,
    // DCR clients would otherwise expire after the library's default 90 days, ending connections early.
    clientRegistrationTTL: GRANT_MAX_SECONDS,
    clientRegistrationCallback: ({ clientMetadata }) => checkRegistration(clientMetadata),
    tokenExchangeCallback: (o) => tokenExchangeCallback({ grantType: o.grantType, props: o.props as Props, env: o.env as Env }),
  });
  return provider;
}

const isKeyPage = (path: string) => path === "/keys" || path.startsWith("/keys/");

/** Unauthenticated endpoints that write KV, and key page sign-in and actions, are rate-limited per client IP and path. */
function rateLimitKey(request: Request, url: URL): string | null {
  const p = url.pathname;
  const get = request.method === "GET";
  const limited = (p === "/register" && request.method === "POST") || (p === "/authorize" && get)
    || (get && (p === "/keys/login" || p === "/keys/callback"));
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  // One bucket for every key page POST, so varying the path doesn't buy more attempts.
  if (request.method === "POST" && isKeyPage(p)) return `keys-post:${ip}`;
  return limited ? `${p}:${ip}` : null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== new URL(env.PUBLIC_URL).origin) return new Response("misdirected request", { status: 421 });
    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: env.WORKER_VERSION, min_hook_version: env.MIN_HOOK_VERSION });
    }
    if (url.pathname === "/" && (request.method === "GET" || request.method === "HEAD")) return harden(landing());
    const key = rateLimitKey(request, url);
    if (key && !(await env.AUTH_RATE_LIMIT.limit({ key })).success) {
      const res = new Response("Too many sign-in requests; try again in a minute.", { status: 429, headers: { "retry-after": "60" } });
      return isKeyPage(url.pathname) ? harden(res) : res;
    }
    if (isKeyPage(url.pathname)) return keyPage.fetch(request, env, ctx);
    return getProvider(env).fetch(request, env, ctx);
  },
};
