import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../src/secrets";

const POSITIVE: [string, string][] = [
  ["github-token", "token is ghp_" + "a".repeat(36)],
  ["github-token", "ghu_" + "B".repeat(36)],
  ["github-pat", "github_pat_" + "1".repeat(22) + "_" + "x".repeat(59)],
  ["aws-access-key", "AKIA" + "ABCDEFGHIJKLMNOP"],
  ["private-key", "-----BEGIN OPENSSH PRIVATE KEY-----\nabc"],
  ["slack-token", "xoxb-1234567890-abcdefghij"],
  ["anthropic-key", "sk-ant-api03-" + "z".repeat(40)],
  ["openai-key", "sk-" + "Q".repeat(40)],
  ["google-api-key", "AIza" + "S".repeat(35)],
  ["jwt", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJlLXZhbHVlLWhlcmU"],
  ["generic-assignment", "password = hunter2hunter2hunter2"],
  ["generic-assignment", "API_TOKEN: 'abcdEFGH1234abcdEFGH'"],
];

const NEGATIVE = [
  "Use the GitHub token from the connector, never paste it",
  "The password policy requires 12 characters",
  "sk-learn is a python library",
  "AKIA prefix identifies AWS keys",
  "token: <redacted>",
  "secret = short",
  "We store JWTs in cookies",
  "See https://github.com/acme-org/billing",
];

describe("scanForSecrets", () => {
  it.each(POSITIVE)("detects %s", (rule, text) => expect(scanForSecrets(text)).toBe(rule));
  it.each(NEGATIVE)("allows: %s", (text) => expect(scanForSecrets(text)).toBeNull());
});
