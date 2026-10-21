import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { generateKeyText, parseKeyText } from "../src/crypto";
import { keyPage, message, messageHtml } from "../src/key-page";
import { repoSection } from "../src/key-page-html";
import { toB64Url } from "../src/crypto";
import { KeyRing, KV } from "../src/keyring";
import { idPinKey } from "../src/scopes";
import { json, mockFetch } from "./setup";

const BASE = "https://memory.test";
const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const hashed = async (sid: string) => toB64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sid))));
const sessionRecord = async () => env.OAUTH_KV.get(`keysession:${await hashed(jar.get("__Host-keys")!)}`);
const REPO = "davlion/claude-memory-test";

let jar: Map<string, string>;
const store = (res: Response) => {
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const i = kv!.indexOf("=");
    const [k, v] = [kv!.slice(0, i), kv!.slice(i + 1)];
    if (v) jar.set(k, v); else jar.delete(k);
  }
};
const go = async (path: string, init: RequestInit = {}) => {
  const res = await exports.default.fetch(BASE + path, { redirect: "manual", ...init,
    headers: { cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "), "cf-connecting-ip": crypto.randomUUID(), ...(init.headers ?? {}) } });
  store(res);
  return res;
};
const expectHardened = (res: Response) => { for (const [k, v] of Object.entries(HEADERS)) expect(res.headers.get(k), k).toBe(v); };

function github(o: { login?: string; id?: number; push?: boolean } = {}) {
  const commit = `c-${crypto.randomUUID()}`;
  const R = `https://api.github.com/repos/${REPO}`;
  const exchanged: FormData[] = [];
  mockFetch([
    { method: "POST", url: "https://github.com/login/oauth/access_token", respond: async (req) => {
      exchanged.push(await req.formData());
      return json({ access_token: "ghu_live", refresh_token: "ghr_live", expires_in: 28800 });
    } },
    { url: "https://api.github.com/user/installations?", respond: () => json({ installations: [{ id: 1, account: { login: "davlion" } }, { id: 2, account: { login: "acme-org" } }] }) },
    { url: /\/user\/installations\/(\d+)\/repositories/, respond: (req) => json({ repositories: /installations\/1\//.test(req.url)
      ? [{ full_name: REPO, private: true, visibility: "private", permissions: { push: o.push ?? true } }]
      : [{ full_name: "acme-org/claude-memory", private: true, visibility: "private", permissions: { push: false } }] }) },
    { url: "https://api.github.com/user", respond: () => json({ login: o.login ?? "dav", id: o.id ?? 42 }) },
    { method: "GET", url: R, respond: () => json({ default_branch: "main", visibility: "private", permissions: { push: true } }) },
    { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ object: { sha: commit } }) },
    { method: "GET", url: `${R}/git/commits/${commit}`, respond: () => json({ sha: commit, message: "m", author: { name: "Dav", date: "" }, html_url: "u", tree: { sha: `t-${commit}` } }) },
    { method: "GET", url: `${R}/git/trees/t-${commit}?recursive=1`, respond: () => json({ truncated: false, tree: [{ path: "README.md", type: "blob", sha: "0".repeat(40) }] }) },
  ]);
  return { exchanged };
}

async function signIn(repo?: string) {
  const login = await go(`/keys/login${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`);
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  return go(`/keys/callback?code=GHCODE&state=${state}`);
}

beforeEach(async () => {
  jar = new Map();
  await env.OAUTH_KV.delete(idPinKey("dav"));
  for (const p of Object.values(KV)) await env.OAUTH_KV.delete(p + REPO);
});

describe("key page", () => {
  it("without MEMORY_MASTER_KEY every route says encryption isn't turned on", async () => {
    const off = { ...env, MEMORY_MASTER_KEY: undefined };
    for (const [path, method] of [["/keys", "GET"], ["/keys/login", "GET"], ["/keys/callback?code=x&state=y", "GET"], ["/keys/register", "POST"]] as const) {
      const res = await keyPage.fetch(new Request(BASE + path, { method }), off);
      expect(await res.text()).toMatch(/encryption isn't turned on for this memory server/i);
      expectHardened(res);
    }
  });

  it("no session → 302 to /keys/login, keeping a valid repo", async () => {
    const res = await go(`/keys?repo=${REPO}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/keys/login?repo=${encodeURIComponent(REPO)}`);
    expectHardened(res);
  });

  it("a cross-site arrival without a session gets a same-site reload instead of a login loop", async () => {
    const res = await go("/keys", { headers: { "sec-fetch-site": "cross-site" } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('content="0;url=/keys"');
    expectHardened(res);
  });

  it("the login redirect uses S256, the /keys/callback redirect_uri and a pre-login cookie", async () => {
    const res = await go(`/keys/login?repo=${REPO}`);
    expect(res.status).toBe(302);
    expectHardened(res);
    const gh = new URL(res.headers.get("location")!);
    expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(gh.searchParams.get("code_challenge_method")).toBe("S256");
    expect(gh.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(gh.searchParams.get("redirect_uri")).toBe(`${BASE}/keys/callback`);
    const state = gh.searchParams.get("state")!;
    expect(res.headers.getSetCookie()).toContain(`__Host-keys-login=${state}; Path=/; Secure; HttpOnly; SameSite=Lax`);
    expect(JSON.parse((await env.OAUTH_KV.get(`keystate:${state}`))!)).toMatchObject({ repo: REPO });
  });

  it("a callback without the matching pre-login cookie → 400", async () => {
    const login = await go("/keys/login");
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    jar.delete("__Host-keys-login");
    const res = await go(`/keys/callback?code=GHCODE&state=${state}`);
    expect(res.status).toBe(400);
    expectHardened(res);
    jar.set("__Host-keys-login", "other");
    expect((await go(`/keys/callback?code=GHCODE&state=${state}`)).status).toBe(400);
  });

  it("a replayed state → 400", async () => {
    github();
    const login = await go("/keys/login");
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    expect((await go(`/keys/callback?code=GHCODE&state=${state}`)).status).toBe(200);
    jar.set("__Host-keys-login", state);
    const replay = await go(`/keys/callback?code=GHCODE&state=${state}`);
    expect(replay.status).toBe(400);
    expectHardened(replay);
  });

  it("a login not on the allowlist → 403", async () => {
    github({ login: "mallory", id: 7 });
    const res = await signIn();
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("isn't on this memory server");
    expectHardened(res);
    expect(jar.has("__Host-keys")).toBe(false);
  });

  it("success sets a Strict __Host- session cookie and reloads /keys from this origin; the stored token is wrapped", async () => {
    const { exchanged } = github();
    const res = await signIn(REPO);
    expect(res.status).toBe(200);
    expectHardened(res);
    expect(res.headers.get("location")).toBeNull();
    expect(await res.text()).toContain(`content="0;url=/keys?repo=${encodeURIComponent(REPO)}"`);
    const cookies = res.headers.getSetCookie();
    const session = cookies.find((c) => c.startsWith("__Host-keys="))!;
    expect(session).toMatch(/^__Host-keys=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict$/);
    expect(cookies.some((c) => c.startsWith("__Host-keys-login=;") && /Max-Age=0/.test(c))).toBe(true);
    const sid = jar.get("__Host-keys")!;
    expect(await env.OAUTH_KV.get(`keysession:${sid}`)).toBeNull();
    const raw = (await env.OAUTH_KV.get(`keysession:${await hashed(sid)}`))!;
    expect(raw).not.toContain("ghu_live");
    const s = JSON.parse(raw) as { login: string; id: number; csrf: string; token: string };
    expect(s).toMatchObject({ login: "dav", id: 42 });
    expect(s.csrf).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const ring = (await KeyRing.fromEnv(env))!;
    expect(await ring.unwrapText(s.token, `keysession-v1\n${sid}`)).toBe("ghu_live");
    expect(await ring.unwrapText(s.token, "keysession-v1\nother")).toBeNull();
    expect(exchanged[0]!.get("redirect_uri")).toBe(`${BASE}/keys/callback`);
    expect((await go("/keys")).status).toBe(200);
  });

  it("the KV key isn't a working cookie: a cookie set to the hashed key is no session", async () => {
    github();
    await signIn();
    jar.set("__Host-keys", await hashed(jar.get("__Host-keys")!));
    expect((await go("/keys")).status).toBe(302);
  });

  it("?repo=<script> is dropped at login and on the page", async () => {
    const login = await go(`/keys/login?repo=${encodeURIComponent("<script>alert(1)</script>")}`);
    const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
    expect(JSON.parse((await env.OAUTH_KV.get(`keystate:${state}`))!).repo).toBeNull();
    github();
    const cb = await go(`/keys/callback?code=GHCODE&state=${state}`);
    expect(await cb.text()).toContain('content="0;url=/keys"');
    const page = await go(`/keys?repo=${encodeURIComponent("<script>alert(1)</script>")}`);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain("<script>");
  });

  it("lists dav's reachable, writable memory repos with their state", async () => {
    const ring = (await KeyRing.fromEnv(env))!;
    const text = generateKeyText();
    await ring.put(REPO, text, "dav", Date.now());
    await ring.putRecord(REPO, { repoId: "r1", keyId: (await parseKeyText(text)).id, enabled: true });
    github();
    await signIn();
    const res = await go("/keys");
    expect(res.status).toBe(200);
    expectHardened(res);
    const body = await res.text();
    expect(body).toContain(REPO);
    expect(body).not.toContain("acme-org/claude-memory"); // reachable but not writable
    expect(body).toMatch(/Encrypted/);
    expect(body).toMatch(/registered by <strong>dav<\/strong>/);
    expect(body).toMatch(/no expiry/);
    expect(body).not.toContain(text);
    const csrf = JSON.parse((await sessionRecord())!).csrf as string;
    expect(body).toContain(`name="csrf" value="${csrf}"`);
  });

  it("an unencrypted repo is shown as not encrypted, with a key input that has autocomplete off", async () => {
    github();
    await signIn();
    const body = await (await go("/keys")).text();
    expect(body).toMatch(/Not encrypted/);
    for (const m of body.matchAll(/<input[^>]*name="key"[^>]*>/g)) expect(m[0]).toContain('autocomplete="off"');
  });

  it("a POST with a bad or missing csrf → 403", async () => {
    github();
    await signIn();
    const post = (body: Record<string, string>) => go("/keys/register", { method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) });
    const bad = await post({ csrf: "nope", repo: REPO });
    expect(bad.status).toBe(403);
    expectHardened(bad);
    expect((await post({ repo: REPO })).status).toBe(403);
  });

  it("a POST without a session → 403", async () => {
    const res = await go("/keys/register", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "csrf=x" });
    expect(res.status).toBe(403);
    expectHardened(res);
  });

  it("a tampered session token is no session", async () => {
    github();
    await signIn();
    const k = `keysession:${await hashed(jar.get("__Host-keys")!)}`;
    const s = JSON.parse((await env.OAUTH_KV.get(k))!);
    await env.OAUTH_KV.put(k, JSON.stringify({ ...s, token: s.token.slice(0, -4) + "AAAA" }));
    expect((await go("/keys")).status).toBe(302);
  });

  it("sign-in is rate-limited, and the 429 carries the headers", async () => {
    const ip = crypto.randomUUID();
    let res: Response | undefined;
    for (let i = 0; i < 12; i++) res = await go("/keys/login", { headers: { "cf-connecting-ip": ip } });
    expect(res!.status).toBe(429);
    expectHardened(res!);
  });

  it("every /keys POST shares one rate-limit bucket per IP", async () => {
    const ip = crypto.randomUUID();
    let res: Response | undefined;
    for (let i = 0; i < 12; i++) res = await go(`/keys/x${i}`, { method: "POST", headers: { "cf-connecting-ip": ip }, body: "csrf=x" });
    expect(res!.status).toBe(429);
  });

  it("message escapes its title and text; messageHtml is the trusted-HTML variant", async () => {
    const plain = await message("<b>t</b>", "<i>x</i>", 400).text();
    expect(plain).not.toMatch(/<b>|<i>/);
    expect(plain).toContain("&#60;i&#62;x&#60;/i&#62;");
    const trusted = await messageHtml("<b>t</b>", '<a href="/keys">k</a>', 400).text();
    expect(trusted).not.toContain("<b>");
    expect(trusted).toContain('<a href="/keys">k</a>');
  });

  it("a non-finite expiry renders as unknown expiry", () => {
    const html = repoSection({ repo: REPO, key: { registeredBy: "dav", expiresAt: NaN },
      status: { encrypted: true, enabled: true, key: "ok", markerProblem: false, sealed: 1, outside: 0 } }, "c", false);
    expect(html).toContain("unknown expiry");
  });

  it("unknown /keys paths are 404 with the headers", async () => {
    const res = await go("/keys/nope");
    expect(res.status).toBe(404);
    expectHardened(res);
  });
});
