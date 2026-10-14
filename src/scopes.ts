import { OpError } from "./errors";
import { normalizeRemote } from "./remote";

export type ScopeConfig = Record<string, string>;
export interface Target { scopeLabel: string; displayLabel: string; repo: string; prefix: string }

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function parseScopes(json: string): ScopeConfig {
  const v = JSON.parse(json) as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("SCOPES must be a JSON object");
  const out: ScopeConfig = {};
  for (const [k, repo] of Object.entries(v)) {
    if (k === "project") throw new Error('scope name "project" is reserved');
    if (typeof repo !== "string" || !REPO_RE.test(repo)) throw new Error(`invalid repo for scope ${k}`);
    out[k] = repo;
  }
  return out;
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
