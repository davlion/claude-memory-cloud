const RULES: [string, RegExp][] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["github-pat", /\bgithub_pat_[A-Za-z0-9_]{50,}\b/],
  ["github-token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ["openai-key", /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}\b/],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}\b/],
  // user:password@ in any URL scheme (postgres://, https://, amqp://…); a bare user@ or host:port isn't flagged.
  ["credentialed-url", /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]{3,}@/i],
  ["stripe-key", /\b[sr]k_(?:live|test)_[A-Za-z0-9]{20,}/],
  ["npm-token", /\bnpm_[A-Za-z0-9]{36}\b/],
  ["azure-key", /\b(?:AccountKey|SharedAccessKey)=[A-Za-z0-9+/]{30,}={0,2}/],
  [
    "generic-assignment",
    // Values that are code, env refs, templates or URLs are not secrets: $, <, [, process./os./env. prefixes,
    // http(s):// URLs, and any token containing "(" (a function call).
    /\b[A-Za-z_]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_]*["']?\s*[:=]\s*['"]?(?![<\[$])(?!(?:process|os|env)\.)(?!https?:\/\/)(?![^\s'"]*\()[^\s'"]{16,}/i,
  ],
];

export function scanForSecrets(text: string): string | null {
  for (const [rule, re] of RULES) if (re.test(text)) return rule;
  return null;
}
