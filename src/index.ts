import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import type { Env, Props } from "./env";
import { GitHub } from "./github";
import { authHandler, tokenExchangeCallback } from "./github-auth";
import { parseScopes } from "./scopes";
import { GitHubStore } from "./store";
import { createServer } from "./tools";

/** API handler for /mcp. OAuthProvider calls fetch(request, env, ctx) with ctx.props set (decrypted). */
const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
    const props = ctx.props as Props;
    const gh = new GitHub(props.githubToken);
    const deps = { store: new GitHubStore(gh, env.CACHE_KV), gh, cfg: parseScopes(env.SCOPES), props, appSlug: env.GITHUB_APP_SLUG };
    // createMcpHandler's .fetch takes (request, options); call the handler itself with (request, env, ctx).
    const handler = createMcpHandler(() => createServer(deps), { route: "/mcp" });
    return handler(request, env, ctx);
  },
};

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
    if (url.host !== new URL(env.PUBLIC_URL).host) return new Response("misdirected request", { status: 421 });
    if (url.pathname === "/health") {
      return Response.json({ ok: true, version: env.WORKER_VERSION, min_hook_version: env.MIN_HOOK_VERSION });
    }
    return getProvider(env).fetch(request, env, ctx);
  },
};
