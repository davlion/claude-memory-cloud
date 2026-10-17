#!/usr/bin/env node
// Manages friends on the production server. Usage (via `npm run friend -- …`):
//   info [login]           print the message to send a friend (server, app, links, setup command)
//   list                   list the logins in scopes.production.json
//   add <login> [--repo owner/name] [--no-invite]
//                          add login to SCOPES (general = <login>/claude-memory unless --repo), upload SCOPES,
//                          invite them to read this repo (for the local kit), then print the message
//   remove <login>         remove login from SCOPES, upload SCOPES, and remove their access to this repo
// The SCOPES upload goes through scripts/wrangler.sh; scopes.production.json is written only after it succeeds.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { addFriend, friendMessage, productionServer, removeFriend } from "./friends-rules.mjs";

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

const server = () => productionServer(readFileSync("wrangler.jsonc", "utf8"));
const scopes = () => readFileSync(SCOPES_FILE, "utf8");

function argLogin() {
  const login = rest.find((a) => !a.startsWith("--") && rest[rest.indexOf(a) - 1] !== "--repo");
  if (!login) die(`usage: npm run friend -- ${cmd} <github login>`, 2);
  return login;
}

try {
  if (cmd === "info") {
    console.log(friendMessage({ ...server(), codeRepo: codeRepo(), login: rest[0] }));
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
    if (invite) {
      const r = gh(["api", "-X", "PUT", `repos/${repoName}/collaborators/${login}`, "-f", "permission=pull", "--silent"]);
      if (r.status !== 0) console.error(`friend: inviting ${login} failed (${r.stderr.trim()}); invite them by hand`);
    }
    console.log(`\nDone. Send ${login} this:\n\n` + friendMessage({ ...server(), codeRepo: repoName, login }));
  } else if (cmd === "remove") {
    const login = argLogin();
    const next = removeFriend(scopes(), login);
    const repoName = codeRepo();
    console.log(`Remove ${login} from production SCOPES and from ${repoName}'s collaborators.`);
    if (!(await confirm("Go ahead?"))) die("nothing changed", 0);
    uploadScopes(next);
    const r = gh(["api", "-X", "DELETE", `repos/${repoName}/collaborators/${login}`, "--silent"]);
    if (r.status !== 0) console.error(`friend: removing ${login} from ${repoName} failed; check its collaborators page`);
    console.log(`Done. ${login}'s next request gets a 403. Pending invitations: https://github.com/${repoName}/settings/access`);
  } else {
    die("usage: npm run friend -- info [login] | list | add <login> [--repo owner/name] [--no-invite] | remove <login>", 2);
  }
} catch (e) {
  die(e.message);
}
