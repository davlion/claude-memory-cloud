import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./env";
import { authHandler, checkRegistration, GRANT_IDLE_SECONDS, GRANT_MAX_SECONDS, tokenExchangeCallback } from "./github-auth";
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

/** Unauthenticated endpoints that write KV are rate-limited per client IP and path. */
function rateLimitKey(request: Request, url: URL): string | null {
  const limited = (url.pathname === "/register" && request.method === "POST") || (url.pathname === "/authorize" && request.method === "GET");
  return limited ? `${url.pathname}:${request.headers.get("cf-connecting-ip") ?? "unknown"}` : null;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== new URL(env.PUBLIC_URL).origin) return new Response("misdirected request", { status: 421 });
    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: env.WORKER_VERSION, min_hook_version: env.MIN_HOOK_VERSION });
    }
    const key = rateLimitKey(request, url);
    if (key && !(await env.AUTH_RATE_LIMIT.limit({ key })).success) {
      return new Response("Too many sign-in requests; try again in a minute.", { status: 429, headers: { "retry-after": "60" } });
    }
    return getProvider(env).fetch(request, env, ctx);
  },
};
