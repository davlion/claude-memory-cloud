import { describe, expect, it } from "vitest";
import { scanCrossClient, scanPersonal, type PersonalHit } from "../src/guard";

const restricted = (category: string): PersonalHit => ({ tier: "restricted", category } as PersonalHit);

const POSITIVE: Record<string, string[]> = {
  sexuality: [
    "I'm gay and out to my team",
    "my sexual orientation is private",
    "I came out as bisexual last year",
    "my sex life is not for the repo",
    "I am transgender",
  ],
  health: [
    "I have a cardiology appointment Thursday",
    "my doctor changed my medication",
    "I was diagnosed with diabetes",
    "I'm seeing a therapist on Fridays",
    "my migraines get worse in winter",
    "I have a dentist appointment on Monday",
    "I have cancer",
    "I'm in hospital this week",
    "I have an illness that flares up",
    "my ADHD diagnosis came late",
  ],
  finances: [
    "I'm moving my IRA",
    "my mortgage rate went up",
    "I owe about $12k on my credit card",
    "my savings are in a brokerage account",
    "I earn $90k a year",
    "our mortgage payment is due on the 1st",
    "my crypto is on Coinbase",
    "my cryptocurrency wallet",
    "my student debt",
  ],
  family: [
    "my kids' school pickup",
    "my wife is travelling next week",
    "I'm getting married in June",
    "my mother needs help moving",
    "my daughter has a recital",
  ],
  location: [
    "my home is on Elm Street",
    "I live in a small town near the coast",
    "my home address is 12 Oak Lane",
    "I moved to a new apartment last month",
    "my neighborhood floods every spring",
    "my address is 12 Oak Lane",
    "My address is 12 Oak Lane, Springfield",
    "I'm moving to Lisbon",
    "we're relocating to Denver",
    "We live in Portland",
    "i'm moving to lisbon",
    "we're relocating to denver",
    "we live in portland",
    "we live in a small town",
    "I'm moving to Postgres, Tennessee",
    "It's just down the road from Paris, Texas",
    "we relocated to Springfield, IL",
  ],
  schedule: [
    "I'll be away from 3 to 20 November",
    "I'm on vacation until the 14th",
    "my morning routine starts with the gym",
    "I'll be out of the office all of August",
    "I wake up at 5 and go to the gym",
    "my flight leaves on the 2nd",
    "I'm in Paris 3-10 Dec",
    "I'll be on parental leave in March",
    "I can't wait to travel to Postgres, Tennessee",
    "I'm flying to Kubernetes next week",
    "my trip to Docker, Ontario",
    "i'm heading to berlin on friday",
    "we travel to client sites every month",
  ],
  business_terms: [
    "my rate for this client is $150/hour",
    "I raised my day rate last quarter",
    "my invoice is 60 days overdue",
    "they owe me for March",
    "I'm negotiating my retainer",
    "I charge double for weekend work",
    "there is a payment dispute over the last milestone",
    "my contract with them ends in May",
    "I'm in a payment dispute with Acme",
    "I invoiced them twice for March",
  ],
  beliefs: [
    "I vote for the green party",
    "my political views lean left",
    "I go to church on Sundays",
    "I'm a registered republican",
    "my religion forbids working on Saturdays",
  ],
  legal: [
    "my lawsuit against my landlord",
    "my lawyer says to wait",
    "my visa renewal is pending",
    "I was arrested once",
    "I'm suing the previous employer",
  ],
};

const CANDID: Record<string, string[]> = {
  candid: [
    "I think their business plan is weak",
    "I feel the founders are clueless about hiring",
    "I can't stand the client's CEO",
    "I don't trust my manager",
    "I find his management style toxic",
  ],
  about_others: [
    "Bob is going through a divorce",
    "Alice was recently diagnosed with cancer",
    "Priya's salary is higher than mine",
    "my colleague is in rehab",
    "Dan earns $140k",
    "Maria is pregnant",
  ],
};

const WORK_FACTS = [
  "the finance team's API rate limit",
  "the health check endpoint",
  "a family of worker processes",
  "contract tests run in CI",
  "the address field in the user model",
  "travel booking service",
  "Alice owns the billing service",
  "Acme invoices go through Coupa",
  "the SOW caps the project at 20 hours a week",
  "I work with Acme on Mondays",
  // extra precision checks
  "Priya prefers squash merges",
  "ask Bob before touching infra",
  "my home directory holds the dotfiles",
  "my email address is on the config page",
  "I think the retry logic is flawed",
  "I prefer small commits and short branches",
  "Bob owns the deploy pipeline and reviews all infra changes",
  "I live-stream the weekly demo",
  "I diagnosed the bug",
  "I diagnosed a memory leak",
  "I added a diagnostics page",
  "my diagnostics script",
  "the I/O diagnostics endpoint",
  "I fixed the injury-report form",
  "I built the sick-leave API",
  "I wrote the disease-model service",
  "I fixed the hospital-api client",
  "the server is going through a migration",
  "alice owns the billing service",
  "priya prefers squash merges",
  "bob owns the deploy pipeline",
  "the api earns revenue",
  "it was diagnosed as a race condition",
  "I'm moving to Postgres",
  "I moved to Kubernetes",
  "we're moving to the new API",
  "I'm moving to v2",
  "we live in Docker",
  "we live in a monorepo",
  "we moved to postgres last year",
  "i'm moving to typescript",
  "I'm moving to Postgres",
  "the Paris, Texas office handles billing",
  "Postgres, or MySQL, backs the billing service",
  "I wrote the travel booking service",
  "my travel plans module needs tests",
  // "our"/"we" is the team or the client in work text (owner's line: how the client runs billing is a work fact)
  "Our tech debt list lives in Linear",
  "Track our technical debt in DEBT.md",
  "my tech debt list is in Linear",
  "our cryptography helpers live in src/crypto",
  "We use our crypto module for signing",
  "my crypto module wraps WebCrypto",
  "Stripe opens a payment dispute for each chargeback",
  "our loans service is written in Go",
  "our income column is nullable",
  "Our stocks ticker feed comes from IEX",
  "our v1 retirement plan",
  "We invoice customers through Coupa",
  "We bill monthly via Stripe",
  "The payment disputes webhook is flaky",
  "Stripe fee disputes are handled by the billing service",
];

describe("scanPersonal: restricted tiers", () => {
  for (const [category, sentences] of Object.entries(POSITIVE)) {
    describe(category, () => {
      for (const s of sentences) {
        it(`refuses: ${s}`, () => {
          expect(scanPersonal(s)).toEqual(restricted(category));
        });
      }
    });
  }
});

describe("scanPersonal: candid tier", () => {
  for (const [category, sentences] of Object.entries(CANDID)) {
    describe(category, () => {
      for (const s of sentences) {
        it(`flags: ${s}`, () => {
          expect(scanPersonal(s)).toEqual({ tier: "candid", category });
        });
      }
    });
  }
});

describe("scanPersonal: names need no capital letters", () => {
  for (const s of (CANDID.about_others ?? []).map((x) => x.toLowerCase())) {
    it(`flags: ${s}`, () => expect(scanPersonal(s)).toEqual({ tier: "candid", category: "about_others" }));
  }
  for (const s of ["bob is going through a divorce", "alice was recently diagnosed with cancer", "dan earns $140k", "maria is pregnant"]) {
    it(`flags: ${s}`, () => expect(scanPersonal(s)).toEqual({ tier: "candid", category: "about_others" }));
  }
});

describe("scanPersonal: ordinary work facts", () => {
  for (const s of WORK_FACTS) it(`passes: ${s}`, () => expect(scanPersonal(s)).toBeNull());
});

describe("scanPersonal: precedence and lookalikes", () => {
  it("the stricter tier wins when a text fits both", () => {
    expect(scanPersonal("I think their business plan is weak, and my lawyer agrees")).toEqual(restricted("legal"));
  });
  it("catches fullwidth lookalike letters", () => {
    expect(scanPersonal("my ｃａｒｄｉｏｌｏｇｙ appointment")).toEqual(restricted("health"));
  });
  it("catches a zero-width character inside a word", () => {
    expect(scanPersonal("my card​iology appointment")).toEqual(restricted("health"));
    expect(scanPersonal("my mort⁠gage")).toEqual(restricted("finances"));
  });
  it("treats a typographic apostrophe like a straight one", () => {
    expect(scanPersonal("I’ll be away from 3 to 20 November")).toEqual(restricted("schedule"));
  });
  it("is stable across repeated calls", () => {
    for (let i = 0; i < 3; i++) expect(scanPersonal("my lawsuit")).toEqual(restricted("legal"));
  });
});

describe("scanCrossClient", () => {
  const others = [
    { scope: "io", owner: "io-org" },
    { scope: "acme", owner: "acme-org" },
  ];
  it("ignores a client name that is a substring of another word", () => {
    expect(scanCrossClient("ratio and acmeish", others)).toBeNull();
  });
  it("matches the owner login", () => {
    expect(scanCrossClient("acme-org's billing uses Kafka", others)).toBe("acme");
  });
  it("matches the scope name case-insensitively", () => {
    expect(scanCrossClient("Their ACME contract", others)).toBe("acme");
  });
  it("returns null with no other clients or no mention", () => {
    expect(scanCrossClient("acme billing", [])).toBeNull();
    expect(scanCrossClient("plain text", others)).toBeNull();
  });
  it("sees through lookalike and zero-width tricks", () => {
    expect(scanCrossClient("ａｃｍｅ billing", others)).toBe("acme");
    expect(scanCrossClient("ac​me billing", others)).toBe("acme");
  });
  it("treats regex metacharacters in names literally", () => {
    expect(scanCrossClient("abc", [{ scope: "a.c", owner: "a.c-org" }])).toBeNull();
  });
});
