import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";

export const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

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
<p><strong>Continue only if you just started connecting claude-memory${details.redirectIsLoopback ? " from an app on your computer" : ""}.</strong> If someone sent you this link, choose Deny.</p>
${details.redirectIsLoopback ? "<p>This sends access to an app on your computer.</p>" : ""}
<p>Next you'll approve on GitHub. The server can only reach repositories where the claude-memory GitHub App is installed and you have access.</p>
<form method="post">
  <input type="hidden" name="handle" value="${esc(handle)}">
  <button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button>
</form>`;
}
