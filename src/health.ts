import type { Props } from "./env";
import { OpError } from "./errors";
import { GitHub, GitHubError, RECONNECT_ACTION, toOpError } from "./github";
import { resolveTarget, type ScopeConfig, type Target } from "./scopes";
import type { EncryptionStatus, HeadCommit } from "./store";

export interface Check { check: string; status: "ok" | "warn" | "fail"; detail: string; action?: string }
export interface ScopeReach {
  scope: string; repo: string; reachable: boolean; writable: boolean;
  /** Admin on the repo (from the installation repository list): needed to turn encryption on or off. */
  admin: boolean; private?: boolean;
  reason?: "app_not_installed" | "not_reachable" | "repo_public" | "installation_suspended" | "error";
  /** Only on reason "error": why this scope's installation could not be checked (status-only, never raw text). */
  error?: { code: string; message: string; action?: string };
  /** Only on repo_public entries: what GitHub reported ("public", "internal", or "unknown" when missing). */
  visibility?: string;
}

type Installation = { id: number; account: { login: string }; repository_selection?: "all" | "selected"; suspended_at?: string | null };
type InstRepo = { full_name: string; private?: boolean; visibility?: string; permissions?: { push?: boolean; admin?: boolean } };

async function listAll<T>(gh: GitHub, path: string, key: string): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = await gh.cachedGet<Record<string, T[]>>(`${path}${sep}per_page=100&page=${page}`);
    const items = res[key] ?? [];
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

const installations = (gh: GitHub) => listAll<Installation>(gh, "/user/installations", "installations");

const errorInfo = (e: unknown) => {
  const err = toOpError(e);
  return { code: err.code, message: err.message, action: err.action };
};

/**
 * Reachability per scope. A failure is contained: if one installation's repository list can't be read, only that
 * installation's scopes are marked (reason "error"); if the installation list itself fails, `listingError` is set
 * and every scope is marked.
 */
export async function scopeReachabilityDetailed(gh: GitHub, cfg: ScopeConfig, _appSlug: string): Promise<{ reach: ScopeReach[]; listingError?: unknown }> {
  const out: ScopeReach[] = [];
  let installs: Installation[];
  try {
    installs = await installations(gh);
  } catch (e) {
    for (const [scope, repo] of Object.entries(cfg)) out.push({ scope, repo, reachable: false, writable: false, admin: false, reason: "error", error: errorInfo(e) });
    return { reach: out, listingError: e };
  }
  const reposByInstall = new Map<number, InstRepo[] | { error: unknown }>();
  for (const [scope, repo] of Object.entries(cfg)) {
    const owner = repo.split("/")[0]!.toLowerCase();
    const inst = installs.find((i) => i.account.login.toLowerCase() === owner);
    if (!inst) { out.push({ scope, repo, reachable: false, writable: false, admin: false, reason: "app_not_installed" }); continue; }
    if (inst.suspended_at) { out.push({ scope, repo, reachable: false, writable: false, admin: false, reason: "installation_suspended" }); continue; }
    if (!reposByInstall.has(inst.id)) {
      try {
        reposByInstall.set(inst.id, await listAll<InstRepo>(gh, `/user/installations/${inst.id}/repositories`, "repositories"));
      } catch (e) {
        reposByInstall.set(inst.id, { error: e });
      }
    }
    const listed = reposByInstall.get(inst.id)!;
    if (!Array.isArray(listed)) { out.push({ scope, repo, reachable: false, writable: false, admin: false, reason: "error", error: errorInfo(listed.error) }); continue; }
    const r = listed.find((x) => x.full_name.toLowerCase() === repo.toLowerCase());
    if (!r) { out.push({ scope, repo, reachable: false, writable: false, admin: false, reason: "not_reachable" }); continue; }
    if (r.visibility !== "private") {
      out.push({ scope, repo, reachable: true, writable: false, admin: false, private: false, reason: "repo_public", visibility: r.visibility ?? "unknown" });
      continue;
    }
    out.push({ scope, repo, reachable: true, writable: Boolean(r.permissions?.push), admin: r.permissions?.admin === true, private: true });
  }
  return { reach: out };
}

export async function scopeReachability(gh: GitHub, cfg: ScopeConfig, appSlug: string): Promise<ScopeReach[]> {
  return (await scopeReachabilityDetailed(gh, cfg, appSlug)).reach;
}

export function notReachableAction(owner: string, repo: string, appSlug: string, login: string): string {
  return `The app is installed on ${owner} but can't see ${repo}. Likely fixes, in order: add claude-memory to the app's repositories (${owner} → Settings → GitHub Apps → ${appSlug} → Configure); create the private repo ${repo} if it doesn't exist; ask an owner of ${owner} to add your account (${login}) to it.`;
}

export function suspendedAction(owner: string, appSlug: string, login: string): string {
  return owner.toLowerCase() === login.toLowerCase()
    ? `Unsuspend the GitHub App on ${owner}: Settings → Applications → Installed GitHub Apps → ${appSlug} → Unsuspend.`
    : `Ask an owner of ${owner} to unsuspend the ${appSlug} app (organization Settings → GitHub Apps).`;
}

/** Installations covering a memory repo's owner that grant access to all of that account's repositories (spec §10b). */
export async function allRepoInstallations(gh: GitHub, cfg: ScopeConfig): Promise<{ id: number; account: string }[]> {
  const owners = new Set(Object.values(cfg).map((r) => r.split("/")[0]!.toLowerCase()));
  return (await installations(gh))
    .filter((i) => owners.has(i.account.login.toLowerCase()) && i.repository_selection === "all")
    .map((i) => ({ id: i.id, account: i.account.login }));
}

// Classified through toOpError so a server bug or limit is never labelled a GitHub outage.
// The detail never carries raw exception text (it can hold request details or tokens).
function githubApiFail(e: unknown): Check {
  const err = toOpError(e);
  if (err.code === "unavailable") {
    const how = e instanceof GitHubError && e.status > 0 ? `HTTP ${e.status}` : "network error";
    return { check: "github_api", status: "fail", detail: `unavailable (${how})`, action: err.action };
  }
  return { check: "github_api", status: "fail", detail: `${err.code}: ${err.message}`, action: err.action };
}

function fmtDuration(ms: number) {
  const m = Math.max(0, Math.round(ms / 60_000));
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export async function runHealth(o: { gh: GitHub; cfg: ScopeConfig; props: Props; appSlug: string; project?: string; now?: number; scopes?: string[] }): Promise<Check[]> {
  const now = o.now ?? Date.now();
  const install = `https://github.com/apps/${o.appSlug}/installations/select_target`;
  const checks: Check[] = [];
  const scopeCfg: ScopeConfig = o.scopes ? Object.fromEntries(Object.entries(o.cfg).filter(([k]) => o.scopes!.includes(k))) : o.cfg;
  try {
    await o.gh.request("GET", "/user");
    const left = o.props.githubTokenExpiresAt - now;
    if (left < 15 * 60_000 && !o.props.githubRefreshToken) {
      checks.push({ check: "github_token", status: "warn", detail: `expires in ${fmtDuration(left)}, no refresh token`,
        action: "Memory sign-in expires soon; reconnect the claude-memory connector in claude.ai Settings → Connectors." });
    } else {
      checks.push({ check: "github_token", status: "ok", detail: `ok (expires in ${fmtDuration(left)})` });
    }
  } catch (e) {
    if (e instanceof GitHubError && e.kind === "unauthorized") {
      checks.push({ check: "github_token", status: "fail", detail: "reauth_required", action: RECONNECT_ACTION });
      return checks;
    }
    checks.push(githubApiFail(e));
    return checks;
  }

  try {
    const { reach, listingError } = await scopeReachabilityDetailed(o.gh, scopeCfg, o.appSlug);
    if (listingError) throw listingError;
    for (const r of reach) {
      const [owner] = r.repo.split("/");
      const name = `scope:${r.scope}`;
      if (r.reason === "repo_public") {
        const tail = "Saves to this scope are blocked until then.";
        // Encryption doesn't make a public repo safe: names, history and the ciphertext itself were out.
        const exposed = "If it holds encrypted memories, their ciphertext, memory names and commit history were exposed while it wasn't private: after making it private, rotate the key and move to a fresh private repo (docs/ENCRYPTION.md).";
        const fix = "repo Settings → General → Danger Zone → Change visibility";
        const action = r.visibility === "internal"
          ? `${r.repo} is internal, so every member of its enterprise can read these memories. Make it private: ${fix}. ${tail} ${exposed}`
          : r.visibility === "public"
            ? `${r.repo} is public, so anyone can read these memories. Make it private: ${fix}. ${tail} ${exposed}`
            : `Couldn't confirm ${r.repo} is private (GitHub didn't report its visibility); make sure it is private (Settings → General → Danger Zone → Change visibility). ${tail}`;
        checks.push({ check: name, status: "fail", detail: `repo_public ${r.repo}`, action });
      } else if (r.reachable && r.writable) checks.push({ check: name, status: "ok", detail: `ok ${r.repo}` });
      else if (r.reachable) checks.push({ check: name, status: "warn", detail: `read-only ${r.repo}`, action: `Ask an owner of ${owner} for write access to ${r.repo}.` });
      else if (r.reason === "error") {
        checks.push({ check: name, status: "fail", detail: `${r.error!.code}: ${r.error!.message}`, action: r.error!.action });
      } else if (r.reason === "installation_suspended") {
        checks.push({ check: name, status: "fail", detail: `installation_suspended ${r.repo}`, action: suspendedAction(owner!, o.appSlug, o.props.login) });
      } else if (r.reason === "app_not_installed") {
        const own = owner!.toLowerCase() === o.props.login.toLowerCase();
        checks.push({ check: name, status: "fail", detail: `app_not_installed ${r.repo}`, action: own
          ? `Install the GitHub App on ${r.repo}: ${install} → Only select repositories → ${r.repo.split("/")[1]}.`
          : `Ask an owner of ${owner} to install the app on ${r.repo}: ${install}` });
      } else {
        checks.push({ check: name, status: "fail", detail: `not_reachable ${r.repo}`, action: notReachableAction(owner!, r.repo, o.appSlug, o.props.login) });
      }
    }
    for (const inst of await allRepoInstallations(o.gh, scopeCfg)) {
      const own = inst.account.toLowerCase() === o.props.login.toLowerCase();
      checks.push({ check: `installation:${inst.account}`, status: "fail", detail: "repository_selection: all", action: own
        ? `The claude-memory app can read and write every repository in ${inst.account}. Restrict it: https://github.com/settings/installations/${inst.id} → Repository access → Only select repositories → the memory repo.`
        : `The claude-memory app can read and write every repository in ${inst.account}. Ask an owner of ${inst.account} to restrict it to the memory repo only: https://github.com/organizations/${inst.account}/settings/installations/${inst.id} → Only select repositories.` });
    }
  } catch (e) {
    checks.push(githubApiFail(e));
  }

  if (o.project) {
    try {
      const t = resolveTarget(o.cfg, "project", o.project);
      checks.push({ check: "project", status: "ok", detail: `${t.scopeLabel.slice(8)} → ${t.repo}/${t.prefix}` });
    } catch (e) {
      const err = e as OpError;
      checks.push({ check: "project", status: "fail", detail: err.code, action: err.action });
    }
  }

  const rl = o.gh.lastRateLimit;
  if (rl) {
    const low = rl.remaining < rl.limit * 0.1;
    const resets = new Date(rl.reset * 1000).toISOString().slice(11, 16);
    checks.push(low
      ? { check: "rate_limit", status: "warn", detail: `${rl.remaining} / ${rl.limit} remaining`,
          action: `GitHub rate limit low (${rl.remaining} left, resets ${resets} UTC). Saves may be queued until then; no action needed.` }
      : { check: "rate_limit", status: "ok", detail: `${rl.remaining} / ${rl.limit} remaining` });
  }
  return checks;
}

export function formatHealth(checks: Check[]): string {
  const icon = { ok: "✓", warn: "⚠", fail: "✗" } as const;
  return checks.map((c) => `${icon[c.status]} ${c.check} — ${c.detail}${c.action ? ` → ${c.action}` : ""}`).join("\n");
}

/** A commit the server made: it carries the Memory-Source trailer, or it's the server's README init commit. */
export const isServerCommit = (message: string) => /^Memory-Source: /m.test(message) || message.trim() === "init: claude-memory";

export const KV_WRITE_CHECK: Check = {
  check: "kv_writes", status: "warn", detail: "Cloudflare KV writes are failing",
  action: "The memory server's Cloudflare KV writes failed (on the Free plan: 1,000 writes/day, resets 00:00 UTC). Reads still work; signing in and token refresh may fail until then. Server owner: check the Cloudflare dashboard.",
};

/**
 * One warning per memory repo whose latest commit was made outside the server (spec §10b provenance check).
 * Only trusted values are printed: the author name, message and GitHub-supplied URL are attacker-controlled
 * free text, so the review link is built from the configured repo and the commit SHA. A hint, not a control.
 */
export function provenanceChecks(heads: Map<string, HeadCommit>): Check[] {
  const out: Check[] = [];
  for (const [repo, h] of heads) {
    if (isServerCommit(h.message)) continue;
    const day = /^\d{4}-\d{2}-\d{2}/.exec(h.date)?.[0];
    out.push({
      check: `provenance:${repo}`, status: "warn",
      detail: `latest commit ${h.sha.slice(0, 7)}${day ? ` on ${day}` : ""} was made outside the memory server`,
      action: `${repo} was changed outside claude-memory. Review that change before relying on these memories: https://github.com/${repo}/commit/${encodeURIComponent(h.sha)}`,
    });
  }
  return out;
}

/** Encryption lines for one scope's repo; several can apply. `ok` only when nothing else does. */
export function encryptionChecks(t: Target, repo: string, s: EncryptionStatus, keysUrl: string): Check[] {
  const check = `encryption:${t.scopeLabel}`;
  const page = `${keysUrl}?repo=${repo}`;
  const register = `Register the key from your password manager: ${page}. Saves are queued until then.`;
  const out: Check[] = [];
  if (s.moving && s.moveStale) {
    out.push({ check, status: "warn", detail: `encrypted copy written to ${s.moving}, but ${repo} changed after the copy`,
      action: `Don't delete ${repo}. Cancel the move on the key page and start it again: ${page}` });
  } else if (s.moving) {
    out.push({ check, status: "warn", detail: `encrypted copy written to ${s.moving}; finish the move`,
      action: `Delete ${repo}, then rename ${s.moving} to ${repo}. Saves wait until then. ${page}` });
  } else if (s.decrypted) {
    out.push({ check, status: "fail", detail: "encrypted, but the repo was decrypted outside the memory tool (the signed marker says off)",
      action: `If you ran memcrypt decrypt, an admin confirms it on the key page to turn encryption off: ${page}. If not, review recent commits: https://github.com/${repo}/commits. Saves stay encrypted until then.` });
  } else if (s.markerOff) {
    out.push({ check, status: "fail", detail: "encrypted, but the encryption marker says off and can't be checked without the key",
      action: `Register the key on the key page to check it: ${page}. If nobody decrypted this repo, review recent commits: https://github.com/${repo}/commits. Saves stay encrypted.` });
  } else if (s.markerProblem) {
    out.push({ check, status: "fail", detail: "encrypted, but the encryption marker is missing or not signed",
      action: s.enabled
        ? `Someone may have tried to turn encryption off. Saves stay encrypted. Review recent commits: https://github.com/${repo}/commits`
        : `Someone may have tried to tamper with the encryption marker. New saves are NOT encrypted (encryption is off for this repo). Review recent commits: https://github.com/${repo}/commits` });
  } else if (s.rotated) {
    // One line covers the key too: the registered key (if any) is the old one.
    out.push({ check, status: "warn", detail: "encrypted, the key was changed (memcrypt rotate?)", action: `Register the repo's new key: ${page}. Saves are queued until then.` });
  }
  if (s.key === "unsupported") {
    out.push({ check, status: "fail", detail: "encrypted repo, but this memory server doesn't support encryption", action: "Ask the memory server's operator to turn on encryption." });
  } else if (s.rotated) {
    // Covered by the rotated line above.
  } else if (s.markerOff) {
    // The marker line already says to register the key.
  } else if (s.key === "missing") {
    out.push({ check, status: "warn", detail: "encrypted, key not registered", action: register });
  } else if (s.key === "mismatch") {
    out.push({ check, status: "warn", detail: "encrypted, the registered key doesn't match (rotated?)", action: register });
  }
  if (s.outside > 0 && (s.decrypted || s.markerOff)) {
    out.push({ check, status: "warn", detail: `encrypted, ${s.outside} memories unencrypted`, action: "The encryption marker says encryption is off: see the line above." });
  } else if (s.outside > 0) {
    out.push({ check, status: "warn", detail: `encrypted, ${s.outside} memories unencrypted, added outside the memory tool`, action: "Review them; saving one through Claude encrypts it." });
  }
  if (!s.enabled && s.sealed > 0) {
    out.push({ check, status: "warn", detail: `encryption off, ${s.sealed} memories still encrypted`,
      action: `Turn it back on at ${page}, or decrypt the repo with memcrypt (docs/ENCRYPTION.md).` });
  }
  if (!out.length && s.enabled) out.push({ check, status: "ok", detail: "encrypted" });
  return out;
}
