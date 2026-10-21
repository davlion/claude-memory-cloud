import { esc } from "./consent";
import type { EncryptionStatus } from "./store";

/** One memory repo on the key page: its encryption state, registered key (never the key itself), or why it couldn't be read. */
export interface RepoView {
  repo: string;
  status: EncryptionStatus | null;
  key: { registeredBy: string; expiresAt: number | null } | null;
  error?: string;
  /** Admin on the repo: may turn encryption on or off. */
  admin?: boolean;
}

export const doc = (title: string, body: string, head = "") => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}
<title>${esc(title)}</title>
<style>body{font:16px system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem}section{border-top:1px solid #ccc;padding:.5rem 0}form{margin:.5rem 0}input,button{font:inherit;padding:.4rem .6rem;margin-right:.5rem}.sel{background:#ffd}</style>
${body}`;

export const page = (body: string, status = 200, cookies: string[] = []) => {
  const h = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(body, { status, headers: h });
};
/** A one-paragraph page; `html` is trusted markup, never request or GitHub text. */
export const messageHtml = (title: string, html: string, status: number, cookies: string[] = []) =>
  page(doc(title, `<h1>${esc(title)}</h1><p>${html}</p>`), status, cookies);
/** A one-paragraph page with plain text, escaped. */
export const message = (title: string, text: string, status: number, cookies: string[] = []) => messageHtml(title, esc(text), status, cookies);

export const IN_PLACE_WARNING = "Turning on encryption replaces this repo's whole history with a single commit. Past changes and their log are gone. The old commits stay readable through the repo's activity log by anyone with read access until GitHub Support purges them: request that at https://support.github.com/request after this finishes. Clones and forks made before now keep the old plaintext. A rule that blocks force pushes on the branch must be lifted first. Without this key your memories can't be read: keep it in your password manager. To continue, paste the key back and type the repo name.";
export const FRESH_WARNING = "Your encrypted memories will be written to a new, empty private repo. Then you delete this repo and rename the new one to this name. Until you do, saves wait. Deleting is what removes the old plaintext; clones and forks made before now keep it. Without this key your memories can't be read: keep it in your password manager. To continue, paste the key back and type the repo name.";
/** A save made elsewhere just before the switch can take about a minute to show (KV propagation). */
const MOVE_WAIT = (repo: string) => `Wait a minute, then reload this page before deleting ${repo}: a save made just before the switch can take that long to show. Only delete ${repo} when this page says the encrypted copy is current.`;
export const adminOnly = (repo: string) => `Only an admin of ${repo} can turn encryption on or off.`;

const hidden = (name: string, value: string) => `<input type="hidden" name="${name}" value="${esc(value)}">`;
const keyInput = `<input type="password" name="key" autocomplete="off" spellcheck="false" placeholder="cmk1_…" required>`;

/** Step one of turning on: the new key (shown only here, once) or a request for the existing one, then both paths with their warnings. */
export function turnOnPage(o: { repo: string; csrf: string; key: string | null }): string {
  const r = esc(o.repo);
  const intro = o.key
    ? `<p>The new key for <strong>${r}</strong>. Save this in your password manager now; it isn't shown again.</p>\n<p><code>${esc(o.key)}</code></p>`
    : `<p>Encryption was turned off for <strong>${r}</strong>. Paste its existing key from your password manager to turn it back on.</p>`;
  const form = (path: string, extra: string, label: string) => `<form method="post" action="/keys/turn-on/confirm">
${hidden("csrf", o.csrf)}${hidden("repo", o.repo)}${hidden("path", path)}
<p><label>Key ${keyInput}</label></p>${extra}
<p><label>Type <strong>${r}</strong> to confirm <input name="confirm_repo" autocomplete="off" spellcheck="false" required></label></p>
<button>${label}</button></form>`;
  const owner = esc(o.repo.split("/")[0]!);
  // Turning back on is in place only: a fresh copy would share the old repo's ID (see confirm in key-actions.ts).
  const fresh = o.key ? `<section><h2>Move to a fresh repo (recommended)</h2>
<p>${esc(FRESH_WARNING)}</p>
${form("fresh", `<p><label>New empty private repo <input name="new_repo" autocomplete="off" spellcheck="false" placeholder="${owner}/…" required></label></p>`, "Encrypt into the new repo")}
</section>
` : "";
  return doc("Turn on encryption", `<h1>Turn on encryption for ${r}</h1>
${intro}
${fresh}<section><h2>Encrypt in place</h2>
<p>${esc(IN_PLACE_WARNING)}</p>
${form("in-place", "", "Encrypt in place")}
</section>`);
}

const link = (url: string) => `<a href="${esc(url)}">${esc(url)}</a>`;

export const inPlaceDone = (repo: string, commitUrl: string) => doc("Encryption is on", `<h1>Encryption is on for ${esc(repo)}</h1>
<p>Its history is now one commit: ${commitUrl.startsWith("https://github.com/") ? link(commitUrl) : "see the repo's commits"}.</p>
<p>Ask GitHub Support to purge the old commits: ${link("https://support.github.com/request")}. Until then anyone with read access can still find them through the repo's activity log.</p>
<p><a href="/keys">Back to the key page</a></p>`);

export const freshDone = (repo: string, newRepo: string) => doc("Finish the move", `<h1>Finish moving ${esc(repo)}</h1>
<p>The encrypted copy is in <strong>${esc(newRepo)}</strong>. Saves to ${esc(repo)} wait until you finish:</p>
<ol>
<li>Delete <strong>${esc(repo)}</strong>: ${link(`https://github.com/${repo}/settings`)} → Danger Zone → Delete this repository. GitHub keeps a deleted repo restorable by its owner for 90 days.</li>
<li>Rename <strong>${esc(newRepo)}</strong> to <strong>${esc(repo.split("/")[1]!)}</strong>: ${link(`https://github.com/${newRepo}/settings`)} → Repository name.</li>
</ol>
<p>Before step 1, wait a minute and reload the key page: delete ${esc(repo)} only when it says the encrypted copy is current. To change your mind, cancel the move there.</p>
<p><a href="/keys">Back to the key page</a></p>`);

export const notOnPage = () => doc("Encryption isn't turned on",
  "<h1>Encryption isn't turned on for this memory server</h1><p>Ask the memory server's operator to turn on encryption at rest.</p>");

/** Cross-site arrivals carry no SameSite=Strict cookie: reload from this origin so a signed-in browser sends it. */
export const reloadPage = (path: string) => doc("Key page",
  `<p><a href="${esc(path)}">Continue to the key page</a></p>`, `<meta http-equiv="refresh" content="0;url=${esc(path)}">`);

const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const expiry = (ms: number | null) => (ms === null ? "no expiry" : Number.isFinite(ms) ? `expires ${esc(when(ms))}` : "unknown expiry");

function state(v: RepoView): string {
  const st = v.status;
  if (v.error) return `<p>This repo couldn't be read right now: ${esc(v.error)}</p>`;
  if (!st || !st.encrypted) return "<p>Not encrypted.</p>";
  const lines: string[] = [];
  lines.push(st.enabled ? "<p><strong>Encrypted.</strong></p>"
    : `<p>Encryption is off; <strong>${st.sealed}</strong> ${st.sealed === 1 ? "memory is" : "memories are"} still encrypted.</p>`);
  if (st.key === "ok" && v.key) {
    lines.push(`<p>Key registered by <strong>${esc(v.key.registeredBy)}</strong>, ${expiry(v.key.expiresAt)}.</p>`);
  } else if (st.key === "mismatch") {
    lines.push("<p>The registered key doesn't match this repo. Register the repo's current key.</p>");
  } else {
    lines.push("<p>Its key isn't registered, so the memory tool can't read or save its memories.</p>");
  }
  if (st.moving) {
    lines.push(st.moveStale
      ? `<p>Moving to <strong>${esc(st.moving)}</strong>, but ${esc(`${v.repo} changed after the copy was written. Don't delete it: cancel the move and start it again.`)}</p>`
      : `<p>Moving to <strong>${esc(st.moving)}</strong>. The encrypted copy is current.</p>`);
    lines.push(`<p>${esc(MOVE_WAIT(v.repo))}</p>`);
  }
  if (st.decrypted) lines.push("<p>Decrypted outside the memory tool (memcrypt decrypt?). Encryption stays on until an admin confirms.</p>");
  if (st.markerOff) lines.push("<p>Its encryption marker says off and can't be checked without the key.</p>");
  if (st.markerProblem) lines.push("<p>Its encryption marker is missing or doesn't match. Run memory_health for details.</p>");
  return lines.join("\n");
}

/** Action forms per state. Key text only ever travels in a POST body. */
function actions(v: RepoView, csrf: string): string {
  const form = (action: string, label: string, withKey = false) => `<form method="post" action="/keys/${action}">
${hidden("csrf", csrf)}${hidden("repo", v.repo)}${withKey ? keyInput : ""}<button>${label}</button></form>`;
  const change = (f: string) => (v.admin ? f : `<p>${esc(adminOnly(v.repo))}</p>`);
  const st = v.status;
  if (v.error) return "";
  if (!st || !st.encrypted) return change(form("turn-on", "Turn on encryption"));
  const out: string[] = [];
  if (st.key === "ok") out.push(form("remove", "Remove key", true));
  else out.push(form("register", "Register key", true));
  // Non-admins get the admin-only sentence once, from the Stop/turn-on entry below.
  if (st.decrypted && v.admin) out.push(form("register", "Confirm decryption (turn encryption off)", true));
  out.push(change(st.moving ? form("cancel-move", "Cancel the move")
    : st.enabled ? form("stop", "Stop encrypting new memories", true) : form("turn-on", "Turn encryption back on")));
  return out.join("\n");
}

export const repoSection = (v: RepoView, csrf: string, selected: boolean) =>
  `<section id="${esc(v.repo)}"${selected ? ' class="sel"' : ""}>\n<h2>${esc(v.repo)}</h2>\n${state(v)}\n${actions(v, csrf)}\n</section>`;

export function keysHome(o: { login: string; csrf: string; repos: RepoView[]; selected: string | null; problem?: string }): string {
  const sel = o.selected?.toLowerCase();
  const repos = [...o.repos].sort((a, b) => Number(b.repo.toLowerCase() === sel) - Number(a.repo.toLowerCase() === sel));
  const missing = o.selected && !repos.some((r) => r.repo.toLowerCase() === sel)
    ? `<p><strong>${esc(o.selected)}</strong> isn't one of your memory repos that the memory tool can write to.</p>` : "";
  const body = repos.length ? repos.map((r) => repoSection(r, o.csrf, r.repo.toLowerCase() === sel)).join("\n")
    : "<p>No memory repos the memory tool can write to.</p>";
  return doc("Memory repo keys", `<h1>Memory repo keys</h1>
<p>Signed in to GitHub as <strong>${esc(o.login)}</strong>. Keys stay in your password manager; paste one here only to register it.</p>
${o.problem ? `<p>${esc(o.problem)}</p>` : ""}${missing}
${body}`);
}

/** GET / : nothing about this server beyond what it is, so the dashboard's Visit link lands somewhere. */
export const landing = () => page(doc("claude-memory", `<h1>claude-memory</h1>
<p>This is a claude-memory server: Claude's memory tool. Connect it in claude.ai → Settings → Connectors.</p>
<p><a href="/keys">Key page (encryption at rest)</a></p>`));
