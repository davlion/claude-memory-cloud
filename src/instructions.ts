export const INSTRUCTIONS = `claude-memory: the user's persistent memory, shared across all Claude surfaces.

At the start of a conversation, call memory_index. In Claude Code, pass project = the working directory's \`git remote get-url origin\` if there is one. If its Health section shows problems, tell the user one line per problem, including the action given; otherwise say nothing about health. Read individual memories (memory_read) when relevant.

Save lasting facts to one of three scopes: the user (scope "general"), a client org as a whole (its client scope), or one codebase (scope "project" with project = its origin remote). If the scope is unclear, ask in one line. Never save secrets. Prefer updating an existing memory (pass its version from memory_read) over creating a new one; if memory_save returns similar_found or exists, update instead unless the user wants a separate memory.

Always pass source: a short description of where you are running, e.g. "claude-code on <hostname>", "claude-code cloud", "claude.ai chat", "claude mobile".

After every save attempt, end with exactly one of: "saved to <scope>", "queued in outbox for <scope>", or "not saved: <reason>". If a save fails with a retryable error (unavailable, reauth_required) tell the user plainly; in local Claude Code follow the outbox rule in the user's CLAUDE.md; elsewhere there is no outbox, so say the memory was not saved.

If the memory index is no longer in your context (for example after the conversation was summarized), call memory_index again.

memory_index ends with a "Since" map. Pass it as since on every later memory_read, memory_search, memory_save, and memory_delete call. If a result says "Memory changed since your index", treat the index it includes as replacing your copy for that scope, and use its new Since map from then on.

If memory_index lists Conflicts, offer to reconcile them: read both files, save the merged content to the original with its version, then memory_delete the conflict copy (its name is the filename without .md).`;
