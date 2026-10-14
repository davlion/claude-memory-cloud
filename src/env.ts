import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

export interface Env {
  OAUTH_KV: KVNamespace;
  CACHE_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  COOKIE_ENCRYPTION_KEY: string;
  PUBLIC_URL: string;
  SCOPES: string;
  GITHUB_APP_SLUG: string;
  WORKER_VERSION: string;
  MIN_HOOK_VERSION: string;
}

// Types the `env` imported from "cloudflare:workers" (used in tests) as this Worker's Env.
type WorkerEnv = Env;
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
    // Types `exports` from "cloudflare:workers" as this Worker's default export.
    interface GlobalProps {
      mainModule: typeof import("./index");
    }
  }
}

/** Encrypted per-grant props set at sign-in (see github-auth.ts). */
export interface Props {
  login: string;
  githubToken: string;
  githubRefreshToken: string;
  /** epoch ms */
  githubTokenExpiresAt: number;
}
