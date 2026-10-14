import { describe, expect, it } from "vitest";
import { normalizeRemote } from "../src/remote";

describe("normalizeRemote", () => {
  it.each([
    ["git@github.com:Acme-Org/Billing.git", "acme-org", "billing"],
    ["https://github.com/acme-org/billing", "acme-org", "billing"],
    ["https://github.com/acme-org/billing.git/", "acme-org", "billing"],
    ["ssh://git@github.com/acme-org/billing.git", "acme-org", "billing"],
    ["https://user@github.com/acme-org/billing.git", "acme-org", "billing"],
    ["acme-org/billing", "acme-org", "billing"],
    ["  acme-org/billing  ", "acme-org", "billing"],
  ])("%s", (input, owner, repo) => {
    expect(normalizeRemote(input)).toEqual({ owner, repo });
  });

  it.each(["git@gitlab.com:a/b.git", "https://bitbucket.org/a/b", "not a remote", "", "a/b/c"])(
    "rejects %s",
    (input) => expect(normalizeRemote(input)).toBeNull(),
  );

  it.each(["../..", "./x", "owner/..", "owner/.", "a.b/c"])(
    "rejects bare %s",
    (input) => expect(normalizeRemote(input)).toBeNull(),
  );
});
