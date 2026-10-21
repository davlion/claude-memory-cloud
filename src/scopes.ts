import { OpError } from "./errors";
import { normalizeRemote } from "./remote";

/** One user's scopes: scope name → "owner/repo". */
export type ScopeConfig = Record<string, string>;
/** GitHub login (lower-case) → that user's scopes. Being listed is the sign-in allowlist (spec §10b). */
export type ScopeMap = Record<string, ScopeConfig>;
export interface Target { scopeLabel: string; displayLabel: string; repo: string; prefix: string }

export const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function validateScopes(v: unknown, where: string): ScopeConfig {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where} must be a JSON object of scope name → "owner/repo"`);
  const out: ScopeConfig = {};
  for (const [k, repo] of Object.entries(v)) {
    if (k === "project") throw new Error(`${where}: scope name "project" is reserved`);
    if (typeof repo !== "string" || !REPO_RE.test(repo)) throw new Error(`${where}: invalid repo for scope ${k}`);
    out[k] = repo;
  }
  return out;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    throw new Error("SCOPES is not valid JSON");
  }
}

export function parseScopeMap(json: string): ScopeMap {
  const v = parseJson(json);
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new Error('SCOPES must be a JSON object: {"<github login>": {"general": "<owner>/claude-memory", …}}');
  }
  const out: ScopeMap = {};
  for (const [login, scopes] of Object.entries(v)) {
    if (!LOGIN_RE.test(login)) throw new Error(`SCOPES: invalid GitHub login ${login}`);
    if (typeof scopes !== "object" || scopes === null) throw new Error(`SCOPES: scopes for ${login} must be an object`);
    if (Object.hasOwn(out, login.toLowerCase())) throw new Error(`SCOPES: duplicate login ${login} (logins are case-insensitive)`);
    out[login.toLowerCase()] = validateScopes(scopes, `SCOPES.${login}`);
  }
  return out;
}

/** OAUTH_KV key holding the numeric GitHub ID pinned to a login at first sign-in. scripts/friends-rules.mjs has a copy (pinKey). */
export const idPinKey = (login: string) => `allowlist:github-id:${login.toLowerCase()}`;

export function scopesFor(map: ScopeMap, login: string): ScopeConfig | undefined {
  const key = login.toLowerCase();
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function resolveTarget(cfg: ScopeConfig, scope: string, project?: string): Target {
  if (scope !== "project") {
    const repo = Object.hasOwn(cfg, scope) ? cfg[scope] : undefined;
    if (!repo) throw new OpError("unknown_scope", `unknown scope "${scope}"; valid: ${[...Object.keys(cfg), "project"].join(", ")}`);
    return { scopeLabel: scope, displayLabel: scope, repo, prefix: "" };
  }
  if (!project) throw new OpError("invalid", "scope project requires `project` (the git origin remote)", "Pass the output of `git remote get-url origin`.");
  const r = normalizeRemote(project);
  if (!r) throw new OpError("unsupported_remote", `not a GitHub remote: ${project}`, "This repo's origin isn't on GitHub; project memories aren't available here.");
  // General wins for its owner; otherwise the owner must map to exactly one repo, so key order never decides where memories land.
  const repos = [...new Set(Object.values(cfg).filter((v) => v.split("/")[0]!.toLowerCase() === r.owner))];
  const general = Object.hasOwn(cfg, "general") && repos.includes(cfg.general!) ? cfg.general : undefined;
  if (!general && repos.length > 1) {
    throw new OpError("invalid", `several memory repos are configured for owner ${r.owner} (${repos.join(", ")})`,
      `Keep one memory repo per owner in SCOPES, so project memories for ${r.owner} have one home.`);
  }
  const repo = general ?? repos[0];
  if (!repo) {
    throw new OpError(
      "no_memory_repo_for_owner",
      `no memory repo configured for owner ${r.owner}`,
      `Project memories for this repo can't be saved. To enable: create ${r.owner}/claude-memory, install the app on it, and add a scope for ${r.owner}.`,
    );
  }
  return { scopeLabel: `project:${r.owner}/${r.repo}`, displayLabel: `project ${r.repo}`, repo, prefix: `projects/${r.repo}/` };
}

/**
 * Default scope set for a context (spec §10b): general, plus each client scope owned by the project's owner, plus
 * any named extras. Without a project (claude.ai chat), general only; named extras widen it, never replace it.
 */
export function contextScopes(cfg: ScopeConfig, project?: string, extra: string[] = []): { names: string[]; unknown: string[] } {
  const names: string[] = [];
  if (Object.hasOwn(cfg, "general")) names.push("general");
  const owner = project ? normalizeRemote(project)?.owner : undefined;
  if (owner) {
    for (const [name, repo] of Object.entries(cfg)) {
      if (name !== "general" && repo.split("/")[0]!.toLowerCase() === owner && !names.includes(name)) names.push(name);
    }
  }
  const unknown: string[] = [];
  for (const s of extra) {
    if (s === "project") continue;
    if (!Object.hasOwn(cfg, s)) unknown.push(s);
    else if (!names.includes(s)) names.push(s);
  }
  return { names, unknown };
}
