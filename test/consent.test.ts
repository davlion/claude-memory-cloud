import { describe, expect, it } from "vitest";
import { consentPage } from "../src/consent";

describe("consentPage", () => {
  const page = (redirectIsLoopback: boolean) =>
    consentPage({ clientName: "Claude", clientDomain: "claude.ai", redirectHost: "claude.ai", redirectIsLoopback } as never, "h");
  it("warns against a link someone else sent, for every redirect", () => {
    for (const loopback of [false, true]) expect(page(loopback)).toContain("If someone sent you this link, choose Deny.");
  });
  it("keeps the loopback-specific line", () => {
    expect(page(true)).toContain("This sends access to an app on your computer.");
    expect(page(false)).not.toContain("an app on your computer");
  });
});
