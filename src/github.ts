import { OpError } from "./errors";

export type GitHubErrorKind =
  | "unauthorized" | "not_found" | "forbidden" | "rate_limited" | "unavailable"
  | "conflict" | "empty_repo" | "unprocessable" | "other";

export class GitHubError extends Error {
  constructor(message: string, public status: number, public kind: GitHubErrorKind, public retryAfter?: number) {
    super(message);
  }
}

export interface RateLimit { limit: number; remaining: number; reset: number }

export const RECONNECT_ACTION =
  "Reconnect: claude.ai → Settings → Connectors → claude-memory → Disconnect, then Connect, and approve on GitHub.";

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
      throw new GitHubError(`network error: ${(e as Error).message}`, 0, "unavailable");
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
    const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    if (res.ok) return data as T;
    throw classify(res, String(data.message ?? res.statusText));
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
  if (!(e instanceof GitHubError)) return new OpError("unavailable", String(e));
  switch (e.kind) {
    case "unauthorized":
      return new OpError("reauth_required", "GitHub sign-in expired or was revoked", RECONNECT_ACTION);
    case "rate_limited":
      return new OpError("unavailable", "GitHub rate limit reached", "Saves may be queued until the limit resets; no action needed.", e.retryAfter);
    case "not_found":
    case "forbidden":
      return new OpError("not_reachable", e.message);
    default:
      return new OpError("unavailable", `GitHub error: ${e.message}`, "GitHub is having problems (githubstatus.com). Saves will be queued; nothing to do.");
  }
}
