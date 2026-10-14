import { OpError } from "./errors";

export type GitHubErrorKind =
  | "unauthorized" | "not_found" | "forbidden" | "rate_limited" | "unavailable"
  | "conflict" | "empty_repo" | "unprocessable" | "server_limit" | "other";

export class GitHubError extends Error {
  constructor(message: string, public status: number, public kind: GitHubErrorKind, public retryAfter?: number) {
    super(message);
  }
}

export interface RateLimit { limit: number; remaining: number; reset: number }

export const RECONNECT_ACTION =
  "Reconnect: claude.ai → Settings → Connectors → claude-memory → Disconnect, then Connect, and approve on GitHub.";

export const GITHUB_DOWN_ACTION = "GitHub is having problems (githubstatus.com). Saves will be queued; nothing to do.";
export const SERVER_LIMIT_ACTION =
  "The memory server hit a Cloudflare per-request limit while reading this scope. Try again in a moment; if it keeps happening, tell the server's owner (the scope may hold too many memories for Cloudflare's Free plan).";
export const WRITE_REJECTED_ACTION =
  "GitHub refused the write, usually because of a branch protection rule or ruleset on the memory repo's default branch. Ask a repo admin to let your account push directly to that branch (a ruleset that only blocks force pushes and deletion is fine).";
export const INTERNAL_ACTION =
  "This is a bug in the memory server, not a temporary problem, so retrying won't help. Report it to the server's owner.";

export class GitHub {
  lastRateLimit: RateLimit | null = null;
  constructor(private token: string) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`https://api.github.com${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
          "user-agent": "claude-memory-cloud",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Workers throws this from fetch() once a request has used up its subrequest allowance.
      if (/too many subrequests/i.test(msg)) throw new GitHubError(`server limit: ${msg}`, 0, "server_limit");
      throw new GitHubError(`network error: ${msg}`, 0, "unavailable");
    }
    const limit = res.headers.get("x-ratelimit-limit");
    if (limit) {
      this.lastRateLimit = {
        limit: Number(limit),
        remaining: Number(res.headers.get("x-ratelimit-remaining")),
        reset: Number(res.headers.get("x-ratelimit-reset")),
      };
    }
    if (res.status === 204) return null as T;
    const text = await res.text();
    let data: unknown = {};
    let parsed = true;
    try {
      if (text) data = JSON.parse(text);
    } catch {
      parsed = false;
    }
    if (!parsed) {
      // Proxies and outages answer with HTML: classify by status instead of throwing a raw SyntaxError.
      if (res.ok) throw new GitHubError(`non-JSON response (HTTP ${res.status})`, res.status, "unavailable");
      throw classify(res, `HTTP ${res.status} (non-JSON response)`);
    }
    if (res.ok) return data as T;
    throw classify(res, String((data as { message?: unknown } | null)?.message ?? res.statusText));
  }
}

function classify(res: Response, message: string): GitHubError {
  const s = res.status;
  const retryAfterHeader = res.headers.get("retry-after");
  const reset = res.headers.get("x-ratelimit-reset");
  const retryAfter = retryAfterHeader
    ? Number(retryAfterHeader)
    : reset ? Math.max(0, Number(reset) - Math.floor(Date.now() / 1000)) : undefined;
  if (s === 401) return new GitHubError(message, s, "unauthorized");
  if (s === 429 || (s === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || /rate limit/i.test(message)))) {
    return new GitHubError(message, s, "rate_limited", retryAfter);
  }
  if (s === 403) return new GitHubError(message, s, "forbidden");
  if (s === 404) return new GitHubError(message, s, "not_found");
  if (s === 409) return new GitHubError(message, s, /empty/i.test(message) ? "empty_repo" : "conflict");
  if (s === 422) return new GitHubError(message, s, /fast.forward|reference cannot be updated/i.test(message) ? "conflict" : "unprocessable");
  if (s >= 500) return new GitHubError(message, s, "unavailable");
  return new GitHubError(message, s, "other");
}

export function toOpError(e: unknown): OpError {
  if (e instanceof OpError) return e;
  if (!(e instanceof GitHubError)) {
    // Never echo the raw error: it can carry request details. Its name is enough to report the bug.
    return new OpError("internal", `unexpected server error (${e instanceof Error ? e.name : typeof e})`, INTERNAL_ACTION);
  }
  switch (e.kind) {
    case "unauthorized":
      return new OpError("reauth_required", "GitHub sign-in expired or was revoked", RECONNECT_ACTION);
    case "rate_limited":
      return new OpError("unavailable", "GitHub rate limit reached", "Saves may be queued until the limit resets; no action needed.", e.retryAfter);
    case "not_found":
    case "forbidden":
      return new OpError("not_reachable", e.message);
    case "unavailable":
      // Status-only: the raw message can carry request details from a failed fetch.
      return new OpError("unavailable", e.status > 0 ? `GitHub unavailable (HTTP ${e.status})` : "GitHub unreachable (network error)", GITHUB_DOWN_ACTION);
    case "server_limit":
      return new OpError("server_limit", "Cloudflare per-request limit reached", SERVER_LIMIT_ACTION);
    case "unprocessable":
    case "conflict":
      return new OpError("write_rejected", `GitHub rejected the write: ${e.message}`, WRITE_REJECTED_ACTION);
    default:
      return new OpError("internal", `unexpected GitHub response: ${e.message}`, INTERNAL_ACTION);
  }
}
