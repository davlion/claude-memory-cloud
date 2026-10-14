#!/usr/bin/env node
// Seeds (or removes) load-test memory sets projects/load-{1,50,200}/ in a test memory repo, in one commit.
// Usage: GITHUB_TOKEN=$(gh auth token) node scripts/seed-load.mjs <owner/repo> [--clean]
const [repo, flag] = process.argv.slice(2);
const token = process.env.GITHUB_TOKEN;
if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !token || (flag && flag !== "--clean")) {
  console.error("usage: GITHUB_TOKEN=... node scripts/seed-load.mjs <owner/repo> [--clean]");
  process.exit(2);
}
const SIZES = [1, 50, 200];
const api = async (method, path, body) => {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "claude-memory-seed",
      ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status}`);
  return res.json();
};
const memory = (n, i) => `---\nname: load-${i}\ndescription: Load-test memory ${i} of ${n}; deploy windows, conventions and the word fox\nmetadata:\n  type: reference\n---\n\nLoad-test body ${i}. ${"The quick brown fox jumps over the lazy dog. ".repeat(10)}\n`;

const { default_branch: branch } = await api("GET", `/repos/${repo}`);
const head = (await api("GET", `/repos/${repo}/git/ref/heads/${branch}`)).object.sha;
const baseTree = (await api("GET", `/repos/${repo}/git/commits/${head}`)).tree.sha;
let entries;
if (flag === "--clean") {
  const tree = await api("GET", `/repos/${repo}/git/trees/${baseTree}?recursive=1`);
  entries = tree.tree.filter((t) => t.type === "blob" && /^projects\/load-\d+\//.test(t.path))
    .map((t) => ({ path: t.path, mode: "100644", type: "blob", sha: null }));
} else {
  entries = SIZES.flatMap((n) => Array.from({ length: n }, (_, i) =>
    ({ path: `projects/load-${n}/memories/load-${i}.md`, mode: "100644", type: "blob", content: memory(n, i) })));
}
if (entries.length === 0) {
  console.log("nothing to do");
  process.exit(0);
}
const tree = await api("POST", `/repos/${repo}/git/trees`, { base_tree: baseTree, tree: entries });
// Trailers make the server treat this as a server-made commit (no provenance warning during measurement).
const message = `${flag === "--clean" ? "clean" : "seed"}: load-test memories\n\nMemory-Source: load-seed\nMemory-Scope: project:load\n`;
const commit = await api("POST", `/repos/${repo}/git/commits`, { message, tree: tree.sha, parents: [head] });
await api("PATCH", `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
console.log(`${flag === "--clean" ? "removed" : "seeded"} ${entries.length} files in ${repo} at ${commit.sha.slice(0, 7)}`);
