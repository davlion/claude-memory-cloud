import OAuthProvider from "@cloudflare/workers-oauth-provider";
import type { Env, Props } from "./env";
import { authHandler, tokenExchangeCallback } from "./github-auth";
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
    tokenExchangeCallback: (o) => tokenExchangeCallback({ grantType: o.grantType, props: o.props as Props, env: o.env as Env }),
  });
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== new URL(env.PUBLIC_URL).origin) return new Response("misdirected request", { status: 421 });
    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: env.WORKER_VERSION, min_hook_version: env.MIN_HOOK_VERSION });
    }
    return getProvider(env).fetch(request, env, ctx);
  },
};
