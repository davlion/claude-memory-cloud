import { createMcpHandler } from "agents/mcp/server";
import type { Env, Props } from "./env";
import { GitHub } from "./github";
import { parseScopeMap, scopesFor } from "./scopes";
import { GitHubStore } from "./store";
import { createServer } from "./tools";

/** API handler for /mcp. OAuthProvider calls fetch(request, env, ctx) with ctx.props set (decrypted). */
export const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
    const props = ctx.props as Props;
    const cfg = scopesFor(parseScopeMap(env.SCOPES), props.login);
    if (!cfg) {
      return Response.json({ error: "access_denied", error_description: "This GitHub account is no longer on this memory server's allowlist." }, { status: 403 });
    }
    const gh = new GitHub(props.githubToken);
    const deps = { store: new GitHubStore(gh, env.CACHE_KV), gh, cfg, props, appSlug: env.GITHUB_APP_SLUG };
    // createMcpHandler's .fetch takes (request, options); call the handler itself with (request, env, ctx).
    const handler = createMcpHandler(() => createServer(deps), { route: "/mcp" });
    return handler(request, env, ctx);
  },
};
