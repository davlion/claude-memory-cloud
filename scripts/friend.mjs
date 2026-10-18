#!/usr/bin/env node
// Manages friends on the production server. Usage (via `npm run friend -- …`):
//   info [login]           print the message to send a friend (server, app, links, setup command)
//   list                   list the logins in scopes.production.json
//   add <login> [--repo owner/name] [--no-invite]
//                          add login to SCOPES (general = <login>/claude-memory unless --repo), upload SCOPES,
//                          invite them as a read-only collaborator on this repo, then print the message
//   remove <login>         remove login from SCOPES, upload SCOPES, and remove their access to this repo
// add and remove also clear the login's GitHub-ID pin, so a later holder of the login can be added.
// The SCOPES upload goes through scripts/wrangler.sh; scopes.production.json is written only after it succeeds.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { addFriend, friendMessage, pinKey, productionServer, removeFriend } from "./friends-rules.mjs";

const SCOPES_FILE = "scopes.production.json";
const [cmd, ...rest] = process.argv.slice(2);

function die(msg, code = 1) {
  console.error(`friend: ${msg}`);
  process.exit(code);
}

function codeRepo() {
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
  const m = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (!m) die(`origin is not a GitHub repo: ${url}`);
  return m[1];
}

function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8" });
  if (r.error) die("needs the GitHub CLI (gh), signed in: https://cli.github.com");
  return r;
}

// GitHub's spelling of the login, or exit if there's no such account.
function canonicalLogin(login) {
  const r = gh(["api", `users/${login}`, "--jq", ".login"]);
  if (r.status !== 0) die(`no GitHub account named ${login}`);
  return r.stdout.trim();
}

async function confirm(question) {
  if (!process.stdin.isTTY) die("needs a terminal to confirm", 2);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`${question} [y/N] `);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

function uploadScopes(json) {
  const r = spawnSync("scripts/wrangler.sh", ["secret", "put", "SCOPES", "--env", "production"], {
    input: json,
    stdio: ["pipe", "inherit", "inherit"],
  });
  if (r.status !== 0) die(`uploading SCOPES failed; ${SCOPES_FILE} is unchanged`);
  writeFileSync(SCOPES_FILE, json);
}

// The pin binds a login to the GitHub account that first signed in with it; a new or removed friend starts without one.
function clearPin(login) {
  const r = spawnSync("scripts/wrangler.sh", ["kv", "key", "delete", pinKey(login), "--binding", "OAUTH_KV", "--env", "production", "--remote"],
    { stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" });
  if (r.status !== 0) {
    console.error(`friend: clearing ${login}'s sign-in pin failed (${(r.stderr ?? "").trim().split("\n").pop()}).\n` +
      `  A scoped deploy token can't edit KV; with the temporary login from docs/QUICKSTART.md Part 5, step 7, run:\n` +
      `  npx wrangler kv key delete ${pinKey(login)} --config wrangler.local.jsonc --binding OAUTH_KV --env production --remote`);
  }
}

// Whether anyone can read this repo; if gh can't tell, assume not, so the message still mentions the invitation.
function codeRepoIsPublic(name) {
  const r = gh(["api", `repos/${name}`, "--jq", ".private"]);
  return r.status === 0 && r.stdout.trim() === "false";
}

// The real server URL and app slug live in the git-ignored wrangler.local.jsonc; wrangler.jsonc is the template.
const server = () => productionServer(readFileSync(existsSync("wrangler.local.jsonc") ? "wrangler.local.jsonc" : "wrangler.jsonc", "utf8"));
const scopes = () => readFileSync(SCOPES_FILE, "utf8");

function argLogin() {
  const login = rest.find((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1] !== "--repo");
  if (!login) die(`usage: npm run friend -- ${cmd} <github login>`, 2);
  return login;
}

try {
  if (cmd === "info") {
    const repoName = codeRepo();
    console.log(friendMessage({ ...server(), codeRepo: repoName, login: rest[0], publicRepo: codeRepoIsPublic(repoName) }));
  } else if (cmd === "list") {
    for (const [login, s] of Object.entries(JSON.parse(scopes()))) console.log(`${login}  ${Object.keys(s).join(", ")}`);
  } else if (cmd === "add") {
    const login = canonicalLogin(argLogin());
    const repoAt = rest.indexOf("--repo");
    const repo = repoAt >= 0 ? rest[repoAt + 1] : undefined;
    if (repoAt >= 0 && !repo) die("--repo needs owner/name", 2);
    const invite = !rest.includes("--no-invite");
    const next = addFriend(scopes(), login, repo);
    const repoName = codeRepo();
    console.log(`Add ${login} (general = ${repo ?? `${login}/claude-memory`}) to production SCOPES` +
      (invite ? `, and invite ${login} to read ${repoName}.` : "."));
    if (!(await confirm("Go ahead?"))) die("nothing changed", 0);
    uploadScopes(next);
    clearPin(login);
    let invited = invite;
    if (invite) {
      const r = gh(["api", "-X", "PUT", `repos/${repoName}/collaborators/${login}`, "-f", "permission=pull", "--silent"]);
      if (r.status !== 0) {
        console.error(`friend: inviting ${login} failed (${r.stderr.trim()}); invite them by hand`);
        invited = false;
      }
    }
    console.log(`\nDone. Send ${login} this:\n\n` + friendMessage({ ...server(), codeRepo: repoName, login, invited, publicRepo: codeRepoIsPublic(repoName) }));
  } else if (cmd === "remove") {
    const login = argLogin();
    const next = removeFriend(scopes(), login);
    const repoName = codeRepo();
    console.log(`Remove ${login} from production SCOPES and from ${repoName}'s collaborators.`);
    if (!(await confirm("Go ahead?"))) die("nothing changed", 0);
    uploadScopes(next);
    clearPin(login);
    const r = gh(["api", "-X", "DELETE", `repos/${repoName}/collaborators/${login}`, "--silent"]);
    if (r.status !== 0) console.error(`friend: removing ${login} from ${repoName} failed; check its collaborators page`);
    console.log(`Done. ${login}'s next request gets a 403. Pending invitations: https://github.com/${repoName}/settings/access`);
  } else {
    die("usage: npm run friend -- info [login] | list | add <login> [--repo owner/name] [--no-invite] | remove <login>", 2);
  }
} catch (e) {
  die(e.message);
}
