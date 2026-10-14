import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function consentPage(details: ConsentDescription, handle: string): string {
  const name = esc(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${esc(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  return `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allow ${name} to use claude-memory?</title>
<style>body{font:16px system-ui;max-width:32rem;margin:3rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style>
<h1>Allow ${name} to use your claude-memory?</h1>
<p>${origin} Access will be sent to <strong>${esc(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>" : ""}
<p>Next you'll approve on GitHub. The server can only reach repositories where you installed the claude-memory GitHub App.</p>
<form method="post">
  <input type="hidden" name="handle" value="${esc(handle)}">
  <button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button>
</form>`;
}
