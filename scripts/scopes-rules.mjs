// The SCOPES validation rules, mirrored from parseScopeMap in src/scopes.ts (test/scopes.test.ts keeps the two in step).
// Returns an error message, or null when the JSON is acceptable. Never echoes the file's contents.
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function scopesError(json) {
  let v;
  try {
    v = JSON.parse(json);
  } catch {
    return "SCOPES is not valid JSON";
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    return 'SCOPES must be a JSON object: {"<github login>": {"general": "<owner>/claude-memory", …}}';
  }
  const seen = new Set();
  for (const [login, scopes] of Object.entries(v)) {
    if (!LOGIN_RE.test(login)) return `SCOPES: invalid GitHub login ${login}`;
    if (typeof scopes !== "object" || scopes === null) return `SCOPES: scopes for ${login} must be an object`;
    if (seen.has(login.toLowerCase())) return `SCOPES: duplicate login ${login} (logins are case-insensitive)`;
    seen.add(login.toLowerCase());
    const where = `SCOPES.${login}`;
    if (Array.isArray(scopes)) return `${where} must be a JSON object of scope name → "owner/repo"`;
    for (const [k, repo] of Object.entries(scopes)) {
      if (k === "project") return `${where}: scope name "project" is reserved`;
      if (typeof repo !== "string" || !REPO_RE.test(repo)) return `${where}: invalid repo for scope ${k}`;
    }
  }
  return null;
}
