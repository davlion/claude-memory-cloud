// Pure helpers for scripts/friend.mjs (no Node imports, so test/friends.test.ts can run them in the Workers pool).
import { scopesError } from "./scopes-rules.mjs";

/** Strips // and /* *\/ comments from JSONC, leaving string contents (URLs) alone. */
export function stripJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2);
      if (i < 0) break;
      i++;
    } else out += c;
  }
  return out;
}

/** The production server URL and GitHub App slug, from wrangler.jsonc's env.production vars. */
export function productionServer(wranglerJsonc) {
  const vars = JSON.parse(stripJsonc(wranglerJsonc))?.env?.production?.vars ?? {};
  const url = vars.PUBLIC_URL, slug = vars.GITHUB_APP_SLUG;
  if (typeof url !== "string" || typeof slug !== "string") {
    throw new Error("wrangler.jsonc: env.production.vars needs PUBLIC_URL and GITHUB_APP_SLUG");
  }
  return { url: url.replace(/\/+$/, ""), slug };
}

const findLogin = (map, login) => Object.keys(map).find((k) => k.toLowerCase() === login.toLowerCase());

/** Returns the new SCOPES JSON with `login` added (general = repo), or throws with a message to show. */
export function addFriend(scopesJson, login, repo = `${login}/claude-memory`) {
  const map = JSON.parse(scopesJson);
  const existing = findLogin(map, login);
  if (existing) throw new Error(`${existing} is already in SCOPES`);
  map[login] = { general: repo };
  const next = JSON.stringify(map, null, 2) + "\n";
  const err = scopesError(next);
  if (err) throw new Error(err);
  return next;
}

/** Returns the new SCOPES JSON without `login`, or throws if it isn't there. */
export function removeFriend(scopesJson, login) {
  const map = JSON.parse(scopesJson);
  const existing = findLogin(map, login);
  if (!existing) throw new Error(`${login} is not in SCOPES`);
  delete map[existing];
  return JSON.stringify(map, null, 2) + "\n";
}

/**
 * The message to send a friend. `codeRepo` is the owner/name of this repo. Without `login` it's the message for
 * before they're added; with it, their commands are filled in and `invited` says whether a repo invitation went out.
 */
export function friendMessage({ url, slug, codeRepo, login, invited = true }) {
  const you = login ?? "<your GitHub username>";
  const guide = `https://github.com/${codeRepo}/blob/main/docs/QUICKSTART-FRIEND.md`;
  const opening = !login
    ? `To use my claude-memory server, send me your GitHub username. I'll add you, and GitHub will email you an
invitation to ${codeRepo}: accept it to read the full guide (until then the link 404s):
${guide}
Do steps 1 and 2 now. Wait until I tell you you're added before step 3.`
    : invited
      ? `I've added ${login} to my claude-memory server. Accept the GitHub invitation to ${codeRepo}
(in your email, or https://github.com/${codeRepo}/invitations), then read the full guide:
${guide}`
      : `I've added ${login} to my claude-memory server. The full guide is docs/QUICKSTART-FRIEND.md in the
claude-memory-cloud code I'm sending you.`;
  return `${opening}

Server:    ${url}
App name:  ${slug}

1. Create a private, empty repo named claude-memory: https://github.com/new
2. Install my app on that repo only ("Only select repositories" → claude-memory):
   https://github.com/apps/${slug}/installations/select_target
3. claude.ai → Settings → Connectors → Add custom connector
   Name: claude-memory    URL: ${url}/mcp
4. On each machine where you use Claude Code:
   ${invited ? `git clone https://github.com/${codeRepo} ~/src/claude-memory-cloud` : "put the code I sent you in ~/src/claude-memory-cloud"}
   cd ~/src/claude-memory-cloud
   ./setup.sh --worker-url ${url} --login ${you} --scope general=${you}/claude-memory

Read "What your host can see" in the guide before you start.
`;
}
