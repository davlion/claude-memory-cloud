import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Props } from "./env";
import { OpError } from "./errors";
import { GitHub, toOpError } from "./github";
import { formatHealth, runHealth, scopeReachability } from "./health";
import { INSTRUCTIONS } from "./instructions";
import { deleteMemory, getIndex, getIndexVersioned, readMemories, saveMemory, searchMemories } from "./operations";
import { resolveTarget, type ScopeConfig, type Target } from "./scopes";
import type { Store } from "./store";

export interface ToolDeps { store: Store; gh: GitHub; cfg: ScopeConfig; props: Props; appSlug: string; now?: () => Date }

const RETRYABLE = new Set(["reauth_required", "unavailable"]);
const ok = (v: unknown) => ({ text: typeof v === "string" ? v : JSON.stringify(v, null, 2), isError: false });

async function reachableTargets(d: ToolDeps, scopes?: string[]): Promise<{ targets: Target[] }> {
  const reach = await scopeReachability(d.gh, d.cfg, d.appSlug);
  const wanted = scopes ?? Object.keys(d.cfg);
  return { targets: reach.filter((r) => r.reachable && wanted.includes(r.scope)).map((r) => resolveTarget(d.cfg, r.scope)) };
}

const sinceBlock = (m: Record<string, string>) =>
  `## Since\nPass this as since on later memory tool calls:\n\`\`\`json\n${JSON.stringify(m)}\n\`\`\``;

function targetForKey(cfg: ScopeConfig, key: string): Target {
  return key.startsWith("project:") ? resolveTarget(cfg, "project", key.slice("project:".length)) : resolveTarget(cfg, key);
}

// Best effort: returns undefined when nothing changed or the check itself fails.
async function changesSince(d: ToolDeps, since: Record<string, string>): Promise<string | undefined> {
  try {
    const next = { ...since };
    const parts: string[] = [];
    for (const [key, version] of Object.entries(since)) {
      let t: Target;
      try { t = targetForKey(d.cfg, key); } catch { delete next[key]; continue; }
      const cur = await getIndexVersioned(d.store, t);
      if (cur.version !== version) { parts.push(cur.text); next[key] = cur.version; }
    }
    if (!parts.length) return undefined;
    return [`## Memory changed since your index\nThese indexes replace your copies:`, ...parts, sinceBlock(next)].join("\n\n");
  } catch {
    return undefined;
  }
}

export async function callTool(d: ToolDeps, name: string, a: Record<string, unknown>): Promise<{ text: string; isError: boolean; notes?: string }> {
  const r = await dispatch(d, name, a);
  const since = a.since as Record<string, string> | undefined;
  if (name === "memory_index" || !since || typeof since !== "object") return r;
  const notes = await changesSince(d, since);
  return notes ? { ...r, notes } : r;
}

async function dispatch(d: ToolDeps, name: string, a: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const now = d.now?.() ?? new Date();
  const scope = (a.scope as string | undefined) ?? "general";
  const project = a.project as string | undefined;
  try {
    switch (name) {
      case "memory_scopes":
        return ok(await scopeReachability(d.gh, d.cfg, d.appSlug));
      case "memory_health":
        return ok(formatHealth(await runHealth({ gh: d.gh, cfg: d.cfg, props: d.props, appSlug: d.appSlug, project })));
      case "memory_index": {
        const health = await runHealth({ gh: d.gh, cfg: d.cfg, props: d.props, appSlug: d.appSlug, project });
        const parts = [`## Health\n${formatHealth(health)}`];
        const since: Record<string, string> = {};
        const tokenBad = health.some((c) => c.check === "github_token" && c.status === "fail") || health.some((c) => c.check === "github_api");
        if (!tokenBad) {
          const { targets } = await reachableTargets(d, a.scopes as string[] | undefined);
          if (project && health.some((c) => c.check === "project" && c.status === "ok")) {
            targets.push(resolveTarget(d.cfg, "project", project));
          }
          for (const t of targets) {
            const idx = await getIndexVersioned(d.store, t);
            parts.push(idx.text);
            since[t.scopeLabel] = idx.version;
          }
          parts.push(sinceBlock(since));
        }
        return ok(parts.join("\n\n"));
      }
      case "memory_read":
        return ok(await readMemories(d.store, resolveTarget(d.cfg, scope, project), (a.names as string[]).slice(0, 20)));
      case "memory_search": {
        const { targets } = await reachableTargets(d, a.scopes as string[] | undefined);
        if (project) targets.push(resolveTarget(d.cfg, "project", project));
        return ok(await searchMemories(d.store, targets, String(a.query ?? "")));
      }
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
    const err = e instanceof OpError ? e : toOpError(e);
    return {
      text: JSON.stringify({ error: err.code, message: err.message, action: err.action, retryable: RETRYABLE.has(err.code), retry_after: err.retryAfter }, null, 2),
      isError: true,
    };
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
