export type ErrorCode =
  | "invalid" | "unknown_scope" | "no_memory_repo_for_owner" | "unsupported_remote"
  | "not_reachable" | "repo_public" | "reauth_required" | "unavailable";

export class OpError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public action?: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
