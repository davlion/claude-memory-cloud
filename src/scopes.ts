import { OpError } from "./errors";
import { normalizeRemote } from "./remote";

/** One user's scopes: scope name → "owner/repo". */
export type ScopeConfig = Record<string, string>;
/** GitHub login (lower-case) → that user's scopes. Being listed is the sign-in allowlist (spec §10b). */
export type ScopeMap = Record<string, ScopeConfig>;
export interface Target { scopeLabel: string; displayLabel: string; repo: string; prefix: string }

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
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
    out[login.toLowerCase()] = validateScopes(scopes, `SCOPES.${login}`);
  }
  return out;
}

export function scopesFor(map: ScopeMap, login: string): ScopeConfig | undefined {
  const key = login.toLowerCase();
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

export function resolveTarget(cfg: ScopeConfig, scope: string, project?: string): Target {
  if (scope !== "project") {
    const repo = cfg[scope];
    if (!repo) throw new OpError("unknown_scope", `unknown scope "${scope}"; valid: ${[...Object.keys(cfg), "project"].join(", ")}`);
    return { scopeLabel: scope, displayLabel: scope, repo, prefix: "" };
  }
  if (!project) throw new OpError("invalid", "scope project requires `project` (the git origin remote)", "Pass the output of `git remote get-url origin`.");
  const r = normalizeRemote(project);
  if (!r) throw new OpError("unsupported_remote", `not a GitHub remote: ${project}`, "This repo's origin isn't on GitHub; project memories aren't available here.");
  const repo = Object.values(cfg).find((v) => v.split("/")[0]!.toLowerCase() === r.owner);
  if (!repo) {
    throw new OpError(
      "no_memory_repo_for_owner",
      `no memory repo configured for owner ${r.owner}`,
      `Project memories for this repo can't be saved. To enable: create ${r.owner}/claude-memory, install the app on it, and add a scope for ${r.owner}.`,
    );
  }
  return { scopeLabel: `project:${r.owner}/${r.repo}`, displayLabel: `project ${r.repo}`, repo, prefix: `projects/${r.repo}/` };
}
