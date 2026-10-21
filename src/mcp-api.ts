import { createMcpHandler } from "agents/mcp/server";
import type { Env, Props } from "./env";
import { EncryptingStore } from "./encrypting-store";
import { errorPayload, MASTER_KEY_MISCONFIGURED, OpError, SCOPES_MISCONFIGURED } from "./errors";
import { GitHub } from "./github";
import { KeyRing } from "./keyring";
import { idPinKey, parseScopeMap, scopesFor } from "./scopes";
import { GitHubStore, type Store } from "./store";
import { createServer } from "./tools";

const denied = () => Response.json(
  errorPayload(new OpError("access_denied", "This GitHub account is no longer on this memory server's allowlist.")), { status: 403 });

/** The memory store for a request: GitHub, sealed and opened per repo by EncryptingStore. Throws if MEMORY_MASTER_KEY is malformed. */
export async function buildStore(gh: GitHub, env: Env): Promise<Store> {
  return new EncryptingStore(new GitHubStore(gh, env.CACHE_KV), await KeyRing.fromEnv(env), `${env.PUBLIC_URL}/keys`, env.CACHE_KV);
}

/** API handler for /mcp. OAuthProvider calls fetch(request, env, ctx) with ctx.props set (decrypted). */
export const mcpApi = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: Props }): Promise<Response> {
    const props = ctx.props as Props;
    let cfg;
    try {
      cfg = scopesFor(parseScopeMap(env.SCOPES), props.login);
    } catch {
      return Response.json(errorPayload(SCOPES_MISCONFIGURED), { status: 503 });
    }
    if (!cfg) return denied();
    // Grants made before githubId existed lack it; they age out within the grant lifetime, and the login check above still applies.
    if (props.githubId !== undefined) {
      let pinned: string | null;
      try {
        pinned = await env.OAUTH_KV.get(idPinKey(props.login));
      } catch {
        // KV is down or rate-limited: fail closed, but retryable.
        const e = new OpError("unavailable", "The memory server could not check your sign-in right now.", "Try again in a moment.", 30);
        return Response.json(errorPayload(e), { status: 503, headers: { "retry-after": "30" } });
      }
      if (pinned !== null && pinned !== String(props.githubId)) {
        return denied();
      }
      // The pin write at sign-in can fail; record it now so a later rename-and-reregister is still refused.
      if (pinned === null) {
        try { await env.OAUTH_KV.put(idPinKey(props.login), String(props.githubId)); } catch { /* retried on the next request */ }
      }
    }
    const gh = new GitHub(props.githubToken);
    let store: Store;
    try {
      store = await buildStore(gh, env);
    } catch {
      return Response.json(errorPayload(MASTER_KEY_MISCONFIGURED), { status: 503 });
    }
    const deps = { store, gh, cfg, props, appSlug: env.GITHUB_APP_SLUG, keysUrl: `${env.PUBLIC_URL}/keys` };
    // createMcpHandler's .fetch takes (request, options); call the handler itself with (request, env, ctx).
    const handler = createMcpHandler(() => createServer(deps), { route: "/mcp" });
    return handler(request, env, ctx);
  },
};
