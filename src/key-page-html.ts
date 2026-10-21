import { esc } from "./consent";
import type { EncryptionStatus } from "./store";

/** One memory repo on the key page: its encryption state, registered key (never the key itself), or why it couldn't be read. */
export interface RepoView {
  repo: string;
  status: EncryptionStatus | null;
  key: { registeredBy: string; expiresAt: number | null } | null;
  error?: string;
}

export const doc = (title: string, body: string, head = "") => `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${head}
<title>${esc(title)}</title>
<style>body{font:16px system-ui;max-width:40rem;margin:3rem auto;padding:0 1rem}section{border-top:1px solid #ccc;padding:.5rem 0}form{margin:.5rem 0}input,button{font:inherit;padding:.4rem .6rem;margin-right:.5rem}.sel{background:#ffd}</style>
${body}`;

export const notOnPage = () => doc("Encryption isn't turned on",
  "<h1>Encryption isn't turned on for this memory server</h1><p>Ask the memory server's operator to turn on encryption at rest.</p>");

/** Cross-site arrivals carry no SameSite=Strict cookie: reload from this origin so a signed-in browser sends it. */
export const reloadPage = (path: string) => doc("Key page",
  `<p><a href="${esc(path)}">Continue to the key page</a></p>`, `<meta http-equiv="refresh" content="0;url=${esc(path)}">`);

const when = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

function state(v: RepoView): string {
  const st = v.status;
  if (v.error) return `<p>This repo couldn't be read right now: ${esc(v.error)}</p>`;
  if (!st || !st.encrypted) return "<p>Not encrypted.</p>";
  const lines: string[] = [];
  lines.push(st.enabled ? "<p><strong>Encrypted.</strong></p>"
    : `<p>Encryption is off; <strong>${st.sealed}</strong> ${st.sealed === 1 ? "memory is" : "memories are"} still encrypted.</p>`);
  if (st.key === "ok" && v.key) {
    lines.push(`<p>Key registered by <strong>${esc(v.key.registeredBy)}</strong>, ${v.key.expiresAt ? `expires ${esc(when(v.key.expiresAt))}` : "no expiry"}.</p>`);
  } else if (st.key === "mismatch") {
    lines.push("<p>The registered key doesn't match this repo. Register the repo's current key.</p>");
  } else {
    lines.push("<p>Its key isn't registered, so the memory tool can't read or save its memories.</p>");
  }
  if (st.moving) lines.push(`<p>Moving to <strong>${esc(st.moving)}</strong>.</p>`);
  if (st.markerProblem) lines.push("<p>Its encryption marker is missing or doesn't match. Run memory_health for details.</p>");
  return lines.join("\n");
}

/** Action forms per state; Task 9 implements the POST handlers. Key text only ever travels in a POST body. */
function actions(v: RepoView, csrf: string): string {
  const form = (action: string, label: string, withKey = false) => `<form method="post" action="/keys/${action}">
<input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="repo" value="${esc(v.repo)}">${withKey
    ? `<input type="password" name="key" autocomplete="off" spellcheck="false" placeholder="cmk1_…" required>` : ""}<button>${label}</button></form>`;
  const st = v.status;
  if (v.error) return "";
  if (!st || !st.encrypted) return form("turn-on", "Turn on encryption");
  const out: string[] = [];
  if (st.key === "ok") out.push(form("remove", "Remove key"));
  else out.push(form("register", "Register key", true));
  out.push(st.enabled ? form("turn-off", "Stop encrypting new memories") : form("turn-on", "Turn encryption back on"));
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
