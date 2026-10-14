import { describe, expect, it } from "vitest";
import { scanForSecrets } from "../src/secrets";

const POSITIVE: [string, string][] = [
  ["credentialed-url", "DATABASE_URL=postgres://admin:S3cr3tPassw0rd!x@db.acme.internal:5432/prod"],
  ["credentialed-url", "https://deploy:abc123token@github.com/acme/app.git"],
  ["stripe-key", "sk_live_" + "a1B2c3D4e5F6g7H8i9J0k1L2"],
  ["stripe-key", "rk_live_" + "Z".repeat(24)],
  ["npm-token", "npm_" + "a".repeat(36)],
  ["azure-key", "DefaultEndpointsProtocol=https;AccountName=acme;AccountKey=" + "A".repeat(86) + "=="],
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
  ["openai-key", "sk-proj-" + "Ab3_dE-fG7h".repeat(12)],
  ["generic-assignment", '"password": "hunter2hunter2hunter2"'],
  ["generic-assignment", "api_key: 'abcd1234efgh5678ijkl'"],
  ["generic-assignment", 'client_secret_v2 = "Zq8xW2vB9nM4kL7pR3tY"'],
];

const NEGATIVE = [
  "postgres://localhost:5432/app",
  "ssh://git@github.com/acme/app.git",
  "https://user@github.com/acme/app",
  "sk_live_ keys are Stripe's live keys",
  "npm_config_cache is an npm env var",
  "AccountKey=<from the vault>",
  "Use the GitHub token from the connector, never paste it",
  "The password policy requires 12 characters",
  "sk-learn is a python library",
  "AKIA prefix identifies AWS keys",
  "token: <redacted>",
  "secret = short",
  "We store JWTs in cookies",
  "See https://github.com/acme-org/billing",
  "token = getAuthTokenFromStore(context)",
  "password: ${DB_PASSWORD}",
  "secret: process.env.SECRET_VALUE",
  "token_endpoint: https://example.com/oauth/token",
];

describe("scanForSecrets", () => {
  it.each(POSITIVE)("detects %s", (rule, text) => expect(scanForSecrets(text)).toBe(rule));
  it.each(NEGATIVE)("allows: %s", (text) => expect(scanForSecrets(text)).toBeNull());
});
