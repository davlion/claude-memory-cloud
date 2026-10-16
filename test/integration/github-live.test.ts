import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { GitHub } from "../../src/github";
import { type GuardContext, deleteMemory, getIndex, readMemories, saveMemory, searchMemories } from "../../src/operations";
import type { Target } from "../../src/scopes";
import { GitHubStore } from "../../src/store";

const token = (env as unknown as Record<string, string>).GITHUB_TEST_TOKEN as string;
const repo = (env as unknown as Record<string, string>).GITHUB_TEST_REPO as string;
const run = token && repo ? describe : describe.skip;
const G: GuardContext = { kind: "general", others: [] };

run("live GitHub", () => {
  const stamp = Date.now().toString(36);
  const T: Target = { scopeLabel: "general", displayLabel: "general", repo, prefix: "" };
  const P: Target = { scopeLabel: `project:dav/it-${stamp}`, displayLabel: `project it-${stamp}`, repo, prefix: `projects/it-${stamp}/` };
  const store = () => new GitHubStore(new GitHub(token), env.CACHE_KV);
  const mem = (name: string, body = "live test\n") =>
    // force: the generated descriptions are similar to each other by design; similarity is unit-tested elsewhere
    ({ name, description: `integration ${name} ${stamp}`, type: "reference", body, source: "integration-test", force: true });

  it("create → read → stale update conflicts → delete, index consistent", { timeout: 60_000 }, async () => {
    const name = `it-${stamp}`;
    expect((await saveMemory(store(), T, mem(name), new Date(), G)).status).toBe("created");
    const [r] = await readMemories(store(), T, [name]);
    const version = (r as { version: string }).version;
    expect((await saveMemory(store(), T, { ...mem(name, "v2\n"), version }, new Date(), G)).status).toBe("updated");
    const stale = await saveMemory(store(), T, { ...mem(name, "v3\n"), version }, new Date(), G);
    expect(stale.status).toBe("conflict");
    expect(await getIndex(store(), T)).toContain("## Conflicts");
    const cname = stale.conflict_file!.replace(/^memories\//, "").replace(/\.md$/, "");
    expect((await deleteMemory(store(), T, cname, undefined, "integration-test")).status).toBe("deleted");
    const [cur] = await readMemories(store(), T, [name]);
    expect((await deleteMemory(store(), T, name, (cur as { version: string }).version, "integration-test")).status).toBe("deleted");
    expect(await getIndex(store(), T)).not.toContain(name);
  });

  it("concurrent updates with the same version → exactly one updated, one conflict", { timeout: 60_000 }, async () => {
    const name = `race-${stamp}`;
    await saveMemory(store(), T, mem(name), new Date(), G);
    const [r] = await readMemories(store(), T, [name]);
    const version = (r as { version: string }).version;
    const results = await Promise.all([
      saveMemory(store(), T, { ...mem(name, "A\n"), version }, new Date(), G),
      saveMemory(store(), T, { ...mem(name, "B\n"), version }, new Date(), G),
    ]);
    expect(results.map((x) => x.status).sort()).toEqual(["conflict", "updated"]);
  });

  it("concurrent creates of different names → both land in the index", { timeout: 60_000 }, async () => {
    const [a, b] = [`pa-${stamp}`, `pb-${stamp}`];
    const res = await Promise.all([saveMemory(store(), P, mem(a, "alpha unique\n"), new Date(), G), saveMemory(store(), P, mem(b, "beta unique\n"), new Date(), G)]);
    expect(res.map((x) => x.status)).toEqual(["created", "created"]);
    const idx = await getIndex(store(), P);
    expect(idx).toContain(`[${a}]`);
    expect(idx).toContain(`[${b}]`);
    expect((await searchMemories(store(), [P], "beta unique")).results.map((x) => x.name)).toEqual([b]);
  });

  it("commits carry trailers", { timeout: 30_000 }, async () => {
    const gh = new GitHub(token);
    const commits = await gh.request<{ commit: { message: string } }[]>("GET", `/repos/${repo}/commits?per_page=5`);
    expect(commits.some((c) => c.commit.message.includes("Memory-Source: integration-test"))).toBe(true);
  });
});
