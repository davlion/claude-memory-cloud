import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./env";
import { errorPayload } from "./errors";
import { GitHub, toOpError } from "./github";
import { formatHealth, runHealth, scopeReachability, type Check } from "./health";
import { INSTRUCTIONS } from "./instructions";
import {
  deleteMemory, getIndex, getIndexVersioned, readMemories, saveMemory, scopeFailure, searchMemories, type ScopeFailure,
} from "./operations";
import { resolveTarget, type ScopeConfig, type Target } from "./scopes";
import type { Store } from "./store";

export interface ToolDeps { store: Store; gh: GitHub; cfg: ScopeConfig; props: Props; appSlug: string; now?: () => Date }
export interface ToolResult { text: string; isError: boolean; notes?: string }

/** At most this many `since` keys are checked per call (each costs a snapshot). */
export const MAX_SINCE_KEYS = 10;

const ok = (v: unknown): ToolResult => ({ text: typeof v === "string" ? v : JSON.stringify(v, null, 2), isError: false });

async function reachableTargets(d: ToolDeps, scopes?: string[]): Promise<{ targets: Target[]; failure?: unknown }> {
  try {
    const reach = await scopeReachability(d.gh, d.cfg, d.appSlug);
    const wanted = scopes ?? Object.keys(d.cfg);
    return { targets: reach.filter((r) => r.reachable && wanted.includes(r.scope)).map((r) => resolveTarget(d.cfg, r.scope)) };
  } catch (e) {
    return { targets: [], failure: e };
  }
}

const sinceBlock = (m: Record<string, string>) =>
  `## Since\nPass this as since on later memory tool calls:\n\`\`\`json\n${JSON.stringify(m)}\n\`\`\``;

function targetForKey(cfg: ScopeConfig, key: string): Target {
  return key.startsWith("project:") ? resolveTarget(cfg, "project", key.slice("project:".length)) : resolveTarget(cfg, key);
}

function indexFailCheck(t: Target, e: unknown): Check {
  const err = toOpError(e);
  return { check: `index:${t.scopeLabel}`, status: "fail", detail: `${err.code}: ${err.message}`,
    action: err.action ?? "Check memory_health for this scope; if it keeps failing, tell the server's owner." };
}

// Best effort, per key: a key whose check fails keeps its old version and never hides another key's change.
async function changesSince(d: ToolDeps, since: Record<string, string>): Promise<string | undefined> {
  try {
    const next = { ...since };
    const parts: string[] = [];
    for (const [key, version] of Object.entries(since).slice(0, MAX_SINCE_KEYS)) {
      let t: Target;
      try { t = targetForKey(d.cfg, key); } catch { delete next[key]; continue; }
      try {
        const cur = await getIndexVersioned(d.store, t);
        if (cur.version !== version) { parts.push(cur.text); next[key] = cur.version; }
      } catch { /* keep this key's old version */ }
    }
    if (!parts.length) return undefined;
    return [`## Memory changed since your index\nThese indexes replace your copies:`, ...parts, sinceBlock(next)].join("\n\n");
  } catch {
    return undefined;
  }
}

export async function callTool(d: ToolDeps, name: string, a: Record<string, unknown>): Promise<ToolResult> {
  const r = await dispatch(d, name, a);
  const since = a.since as Record<string, string> | undefined;
  if (name === "memory_index" || !since || typeof since !== "object") return r;
  const notes = await changesSince(d, since);
  return notes ? { ...r, notes } : r;
}

async function memoryIndex(d: ToolDeps, a: Record<string, unknown>): Promise<string> {
  const project = a.project as string | undefined;
  const health = await runHealth({ gh: d.gh, cfg: d.cfg, props: d.props, appSlug: d.appSlug, project });
  const tokenBad = health.some((c) => (c.check === "github_token" && c.status === "fail") || c.check === "github_api");
  if (tokenBad) return `## Health\n${formatHealth(health)}`;
  const { targets, failure } = await reachableTargets(d, a.scopes as string[] | undefined);
  if (failure) {
    // Health passed a moment ago but this second look failed: say so rather than return an index with scopes missing.
    const err = toOpError(failure);
    health.push({ check: "github_api", status: "fail", detail: `${err.code}: ${err.message}`, action: err.action });
  }
  if (project && health.some((c) => c.check === "project" && c.status === "ok")) targets.push(resolveTarget(d.cfg, "project", project));
  const sections: string[] = [];
  const since: Record<string, string> = {};
  for (const t of targets) {
    try {
      const idx = await getIndexVersioned(d.store, t);
      sections.push(idx.text);
      since[t.scopeLabel] = idx.version;
    } catch (e) {
      health.push(indexFailCheck(t, e));
    }
  }
  return [`## Health\n${formatHealth(health)}`, ...sections, sinceBlock(since)].join("\n\n");
}

async function memorySearch(d: ToolDeps, a: Record<string, unknown>) {
  const { targets, failure } = await reachableTargets(d, a.scopes as string[] | undefined);
  const failures: ScopeFailure[] = failure ? [scopeFailure("all", failure)] : [];
  const project = a.project as string | undefined;
  if (project) {
    try { targets.push(resolveTarget(d.cfg, "project", project)); } catch (e) { failures.push(scopeFailure("project", e)); }
  }
  const r = await searchMemories(d.store, targets, String(a.query ?? ""));
  return { results: r.results, failed_scopes: [...failures, ...r.failures] };
}

async function dispatch(d: ToolDeps, name: string, a: Record<string, unknown>): Promise<ToolResult> {
  const now = d.now?.() ?? new Date();
  const scope = (a.scope as string | undefined) ?? "general";
  const project = a.project as string | undefined;
  try {
    switch (name) {
      case "memory_scopes":
        return ok(await scopeReachability(d.gh, d.cfg, d.appSlug));
      case "memory_health":
        return ok(formatHealth(await runHealth({ gh: d.gh, cfg: d.cfg, props: d.props, appSlug: d.appSlug, project })));
      case "memory_index":
        return ok(await memoryIndex(d, a));
      case "memory_read":
        return ok(await readMemories(d.store, resolveTarget(d.cfg, scope, project), (a.names as string[]).slice(0, 20)));
      case "memory_search":
        return ok(await memorySearch(d, a));
      case "memory_save":
        return ok(await saveMemory(d.store, resolveTarget(d.cfg, scope, project), {
          name: String(a.name ?? ""), description: String(a.description ?? ""), type: String(a.type ?? ""), body: String(a.body ?? ""),
          version: a.version as string | undefined, force: Boolean(a.force), source: a.source as string | undefined,
        }, now));
      case "memory_delete":
        return ok(await deleteMemory(d.store, resolveTarget(d.cfg, scope, project), String(a.name ?? ""), a.version as string | undefined, a.source as string | undefined, now));
      default:
        return { text: JSON.stringify({ error: "invalid", message: `unknown tool ${name}` }), isError: true };
    }
  } catch (e) {
    return { text: JSON.stringify(errorPayload(toOpError(e)), null, 2), isError: true };
  }
}

const scopeArg = z.string().optional().describe('"general", a client scope name, or "project". Default "general".');
const projectArg = z.string().optional().describe("Git origin remote URL or owner/repo. Required when scope is \"project\".");
const sourceArg = z.string().optional().describe('Where you are running, e.g. "claude-code on earsvm", "claude.ai chat".');
const sinceArg = z.record(z.string(), z.string()).optional().describe("The Since map from memory_index (or from the latest change notice).");

export function createServer(d: ToolDeps): McpServer {
  const server = new McpServer({ name: "claude-memory", version: "0.1.0" }, { instructions: INSTRUCTIONS });
  const reg = (name: string, description: string, shape: Record<string, z.ZodType>) =>
    server.registerTool(name, { description, inputSchema: z.object(shape) }, async (args: Record<string, unknown>) => {
      const r = await callTool(d, name, args);
      const content = [{ type: "text" as const, text: r.text }];
      if (r.notes) content.push({ type: "text" as const, text: r.notes });
      return { content, isError: r.isError };
    });

  reg("memory_scopes", "List memory scopes and whether you can reach and write them.", {});
  reg("memory_health", "Check memory health: sign-in, scopes, project, rate limit. Each problem includes an action for the user.", { project: projectArg });
  reg("memory_index", "Call at conversation start. Health, then the MEMORY.md index of each reachable scope and the project.", {
    scopes: z.array(z.string()).optional(), project: projectArg });
  reg("memory_read", "Read memories in full. Returns each memory's version for safe updates.", {
    scope: scopeArg, project: projectArg, names: z.array(z.string()).min(1).max(20), since: sinceArg });
  reg("memory_search", "Search memories (all terms must match) across reachable scopes and the project.", {
    query: z.string().min(1), scopes: z.array(z.string()).optional(), project: projectArg, since: sinceArg });
  reg("memory_save", "Create a memory (no version) or update one (pass version from memory_read).", {
    scope: scopeArg, project: projectArg, name: z.string(), description: z.string(),
    type: z.enum(["user", "feedback", "project", "reference"]), body: z.string(),
    version: z.string().optional(), force: z.boolean().optional(), source: sourceArg, since: sinceArg });
  reg("memory_delete", "Delete a memory or a conflict copy (name = filename without .md). Pass version to avoid deleting a changed memory.", {
    scope: scopeArg, project: projectArg, name: z.string(), version: z.string().optional(), source: sourceArg, since: sinceArg });

  server.registerResource("scope-index", new ResourceTemplate("memory://{scope}/index", { list: undefined }),
    { description: "MEMORY.md index for a scope", mimeType: "text/markdown" },
    async (uri: URL, vars: Record<string, string | string[]>) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: await getIndex(d.store, resolveTarget(d.cfg, String(vars.scope))) }],
    }));
  server.registerResource("project-index", new ResourceTemplate("memory://project/{owner}/{repo}/index", { list: undefined }),
    { description: "MEMORY.md index for a project", mimeType: "text/markdown" },
    async (uri: URL, vars: Record<string, string | string[]>) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: await getIndex(d.store, resolveTarget(d.cfg, "project", `${vars.owner}/${vars.repo}`)) }],
    }));
  return server;
}
