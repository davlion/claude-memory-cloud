import type { Props } from "./env";
import { OpError } from "./errors";
import { GitHub, GitHubError, RECONNECT_ACTION, toOpError } from "./github";
import { resolveTarget, type ScopeConfig } from "./scopes";
import type { HeadCommit } from "./store";

export interface Check { check: string; status: "ok" | "warn" | "fail"; detail: string; action?: string }
export interface ScopeReach { scope: string; repo: string; reachable: boolean; writable: boolean; private?: boolean; reason?: "app_not_installed" | "not_reachable" | "repo_public" }

type Installation = { id: number; account: { login: string } };
type InstRepo = { full_name: string; private?: boolean; permissions?: { push?: boolean } };

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

export async function scopeReachability(gh: GitHub, cfg: ScopeConfig, _appSlug: string): Promise<ScopeReach[]> {
  const installs = await listAll<Installation>(gh, "/user/installations", "installations");
  const reposByInstall = new Map<number, InstRepo[]>();
  const out: ScopeReach[] = [];
  for (const [scope, repo] of Object.entries(cfg)) {
    const owner = repo.split("/")[0]!.toLowerCase();
    const inst = installs.find((i) => i.account.login.toLowerCase() === owner);
    if (!inst) { out.push({ scope, repo, reachable: false, writable: false, reason: "app_not_installed" }); continue; }
    if (!reposByInstall.has(inst.id)) {
      reposByInstall.set(inst.id, await listAll<InstRepo>(gh, `/user/installations/${inst.id}/repositories`, "repositories"));
    }
    const r = reposByInstall.get(inst.id)!.find((x) => x.full_name.toLowerCase() === repo.toLowerCase());
    if (!r) { out.push({ scope, repo, reachable: false, writable: false, reason: "not_reachable" }); continue; }
    const isPrivate = r.private === true;
    if (!isPrivate) { out.push({ scope, repo, reachable: true, writable: false, private: false, reason: "repo_public" }); continue; }
    out.push({ scope, repo, reachable: true, writable: Boolean(r.permissions?.push), private: true });
  }
  return out;
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
    for (const r of await scopeReachability(o.gh, scopeCfg, o.appSlug)) {
      const [owner] = r.repo.split("/");
      const name = `scope:${r.scope}`;
      if (r.reason === "repo_public") checks.push({ check: name, status: "fail", detail: `repo_public ${r.repo}`, action:
        `${r.repo} is public, so anyone can read these memories. Make it private: repo Settings → General → Danger Zone → Change visibility. Saves to this scope are blocked until then.` });
      else if (r.reachable && r.writable) checks.push({ check: name, status: "ok", detail: `ok ${r.repo}` });
      else if (r.reachable) checks.push({ check: name, status: "warn", detail: `read-only ${r.repo}`, action: `Ask an owner of ${owner} for write access to ${r.repo}.` });
      else if (r.reason === "app_not_installed") {
        const own = owner!.toLowerCase() === o.props.login.toLowerCase();
        checks.push({ check: name, status: "fail", detail: `app_not_installed ${r.repo}`, action: own
          ? `Install the GitHub App on ${r.repo}: ${install} → Only select repositories → ${r.repo.split("/")[1]}.`
          : `Ask an owner of ${owner} to install the app on ${r.repo}: ${install}` });
      } else {
        checks.push({ check: name, status: "fail", detail: `not_reachable ${r.repo}`, action:
          `The app is installed on ${owner} but can't see ${r.repo}. Likely fixes, in order: add claude-memory to the app's repositories (${owner} → Settings → GitHub Apps → ${o.appSlug} → Configure); create the private repo ${r.repo} if it doesn't exist; ask an owner of ${owner} to add your account (${o.props.login}) to it.` });
      }
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
