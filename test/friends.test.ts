import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { addFriend, friendMessage, pinKey, productionServer, removeFriend, stripJsonc } from "../scripts/friends-rules.mjs";
import { idPinKey } from "../src/scopes";

const scopes = '{"dav":{"general":"dav/claude-memory"}}';

describe("scripts/friends-rules.mjs", () => {
  it("strips comments but keeps URLs inside strings", () => {
    const text = '{\n  // a comment\n  "u": "https://x.dev/a", /* block */ "v": "a\\"//b"\n}';
    expect(JSON.parse(stripJsonc(text))).toEqual({ u: "https://x.dev/a", v: 'a"//b' });
  });

  it("reads the production server from wrangler.jsonc", () => {
    const jsonc = `{
      // staging
      "vars": { "PUBLIC_URL": "https://staging.dev" },
      "env": { "production": { "vars": { "PUBLIC_URL": "https://prod.dev/", "GITHUB_APP_SLUG": "dav-claude-memory" } } }
    }`;
    expect(productionServer(jsonc)).toEqual({ url: "https://prod.dev", slug: "dav-claude-memory" });
    expect(() => productionServer('{"env":{}}')).toThrow(/PUBLIC_URL and GITHUB_APP_SLUG/);
  });

  it("adds a friend with their own general repo, or a given one", () => {
    expect(JSON.parse(addFriend(scopes, "Pat"))).toEqual({
      dav: { general: "dav/claude-memory" }, Pat: { general: "Pat/claude-memory" },
    });
    expect(JSON.parse(addFriend(scopes, "pat", "pat/notes")).pat).toEqual({ general: "pat/notes" });
  });

  it("refuses duplicates (case-insensitive) and invalid input", () => {
    expect(() => addFriend(scopes, "DAV")).toThrow("dav is already in SCOPES");
    expect(() => addFriend(scopes, "-bad")).toThrow(/invalid GitHub login/);
    expect(() => addFriend(scopes, "pat", "nope")).toThrow(/invalid repo/);
  });

  it("names the GitHub-ID pin the same way the server does", () => {
    expect(pinKey("Erin")).toBe(idPinKey("Erin"));
    expect(idPinKey("Erin")).toBe("allowlist:github-id:erin");
  });

  it("removes a friend whatever the case", () => {
    const two = addFriend(scopes, "Pat");
    expect(JSON.parse(removeFriend(two, "pat"))).toEqual({ dav: { general: "dav/claude-memory" } });
    expect(() => removeFriend(scopes, "pat")).toThrow("pat is not in SCOPES");
  });

  it("fills the friend's message with the server, app and login", () => {
    const msg = friendMessage({ url: "https://prod.dev", slug: "dav-claude-memory", codeRepo: "dav/claude-memory-cloud", login: "pat" });
    expect(msg).toContain("I've added pat");
    expect(msg).toContain("URL: https://prod.dev/mcp");
    expect(msg).toContain("https://github.com/apps/dav-claude-memory/installations/select_target");
    expect(msg).toContain("--login pat --scope general=pat/claude-memory");
    expect(msg).toContain("https://github.com/dav/claude-memory-cloud/blob/main/docs/QUICKSTART-FRIEND.md");
    expect(msg).toContain("Accept the GitHub invitation to dav/claude-memory-cloud");
    expect(msg).toContain("git clone https://github.com/dav/claude-memory-cloud");
  });

  it("before they're added, says the invitation is coming and to wait before connecting", () => {
    const msg = friendMessage({ url: "u", slug: "s", codeRepo: "r/r" });
    expect(msg).toContain("send me your GitHub username");
    expect(msg).toContain("GitHub will email you an\ninvitation to r/r");
    expect(msg).toContain("Wait until I tell you you're added before step 3");
    expect(msg).not.toContain("Accept the GitHub invitation");
  });

  it("without an invitation, points at the code sent separately", () => {
    const msg = friendMessage({ url: "u", slug: "s", codeRepo: "r/r", login: "pat", invited: false });
    expect(msg).not.toContain("invitation");
    expect(msg).not.toContain("git clone");
    expect(msg).toContain("put the code I sent you in ~/src/claude-memory-cloud");
  });
});
