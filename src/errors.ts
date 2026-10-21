export type ErrorCode =
  | "invalid" | "unknown_scope" | "no_memory_repo_for_owner" | "unsupported_remote"
  | "not_reachable" | "repo_public" | "reauth_required" | "unavailable"
  | "write_rejected" | "internal" | "server_limit" | "access_denied" | "key_required";

/** The only codes a client may retry later (local Claude Code queues the save in its outbox). Every other code is final. */
export const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["reauth_required", "unavailable", "server_limit", "key_required"]);

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

/** The JSON body of an isError tool result. */
export function errorPayload(e: OpError) {
  return { error: e.code, message: e.message, action: e.action, retryable: RETRYABLE.has(e.code), retry_after: e.retryAfter };
}

/** Shown when SCOPES can't be parsed; never echoes the secret's contents. */
export const SCOPES_MISCONFIGURED = new OpError(
  "internal", "memory server misconfigured: SCOPES is invalid",
  "The server owner must fix the SCOPES secret (see SELF-HOSTING/QUICKSTART)",
);

/** Shown when MEMORY_MASTER_KEY can't be parsed; never echoes the secret. */
export const MASTER_KEY_MISCONFIGURED = new OpError(
  "internal", "memory server misconfigured: MEMORY_MASTER_KEY is invalid",
  "The server owner must fix the MEMORY_MASTER_KEY secret: standard base64 of 32 bytes (openssl rand -base64 32), or remove it to turn encryption off",
);
