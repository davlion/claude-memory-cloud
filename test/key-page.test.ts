import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateKeyText, newRepoId, parseKeyText } from "../src/crypto";
import { esc } from "../src/consent";
import { MARKER_PATH, markerSignedBy, parseMarker, sealMemoryFile, serializeMarker, signMarker } from "../src/encrypted-files";
import { keyPage, mayChangeEncryption, message, messageHtml } from "../src/key-page";
import { repoSection } from "../src/key-page-html";
import { toB64Url } from "../src/crypto";
import { EncryptingStore } from "../src/encrypting-store";
import { OpError } from "../src/errors";
import { GitHubStore } from "../src/store";
import { isEncryptedFile } from "../src/encrypted-files";
import { KeyRing, KV } from "../src/keyring";
import { saveMemory } from "../src/operations";
import { idPinKey } from "../src/scopes";
import { FakeStore } from "./fake-store";
import { json, mockFetch, type Route } from "./setup";

const BASE = "https://memory.test";
const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "x-frame-options": "DENY",
  // Not no-referrer: under it browsers send "Origin: null" on this page's own form posts, which the Origin check refuses.
  "referrer-policy": "same-origin",
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

type Entry = { path: string; type: string; sha: string; mode: string };
const oid = (n: number) => n.toString(16).padStart(40, "0");
const MEM = "---\nname: a\ndescription: Alpha secret description\nmetadata:\n  type: user\n---\n\nalpha secret body\n";
const IDX = "# Memory index — general\n\n- [a](memories/a.md) — Alpha secret description\n";
interface Fake { name: string; head: string | null; tree: Entry[]; texts: Record<string, string>; meta: Record<string, unknown> }

/** A memory repo on fake GitHub: plaintext memory, index and README, plus an optional marker (or empty). */
function fake(name: string, o: { marker?: string; head?: string | null } = {}): Fake {
  const tree: Entry[] = [
    { path: "MEMORY.md", type: "blob", sha: oid(1), mode: "100644" },
    { path: "memories/a.md", type: "blob", sha: oid(2), mode: "100644" },
    { path: "README.md", type: "blob", sha: oid(3), mode: "100644" },
  ];
  const texts: Record<string, string> = { [oid(1)]: IDX, [oid(2)]: MEM, [oid(3)]: "readme\n" };
  if (o.marker) { tree.push({ path: MARKER_PATH, type: "blob", sha: oid(7), mode: "100644" }); texts[oid(7)] = o.marker; }
  return { name, head: o.head === undefined ? `c-${crypto.randomUUID()}` : o.head, tree, texts, meta: { default_branch: "main", visibility: "private", permissions: { push: true } } };
}

function repoRoutes(repos: Fake[]) {
  const texts = Object.assign({}, ...repos.map((r) => r.texts)) as Record<string, string>;
  const API = "https://api.github.com/repos/";
  return [
    ...repos.flatMap((r) => {
      const B = API + r.name;
      return [
        { method: "GET", url: B, respond: () => json(r.meta) },
        { method: "GET", url: `${B}/git/ref/heads/main`, respond: () => r.head === null ? json({ message: "Git Repository is empty." }, 409) : json({ object: { sha: r.head } }) },
        { method: "GET", url: `${B}/git/commits/`, respond: (req: Request) => {
          const sha = req.url.split("/").pop()!;
          return json({ sha, message: "m", author: { name: "Dav", date: "d" }, html_url: `https://github.com/${r.name}/commit/${sha}`, tree: { sha: `t-${sha}` } });
        } },
        { method: "GET", url: `${B}/git/trees/`, respond: () => json({ truncated: false, tree: r.tree }) },
        { method: "GET", url: `${B}/branches`, respond: () => json([{ name: "main" }]) },
        { method: "GET", url: `${B}/tags`, respond: () => json([]) },
        { method: "GET", url: `${B}/git/matching-refs/pull/`, respond: () => json([]) },
        { method: "GET", url: `${B}/git/matching-refs/`, respond: () => json([]) },
        { method: "GET", url: `${B}/git/blobs/`, respond: (req: Request) => json({ content: btoa(texts[req.url.split("/").pop()!] ?? "x"), encoding: "base64" }) },
        { method: "POST", url: `${B}/git/blobs`, respond: () => json({ sha: "copied" }, 201) },
        { method: "POST", url: `${B}/git/trees`, respond: () => json({ sha: "t-new" }) },
        { method: "POST", url: `${B}/git/commits`, respond: () => json({ sha: "c-new", html_url: `https://github.com/${r.name}/commit/c-new` }) },
        { method: "PATCH", url: `${B}/git/refs/heads/main`, respond: () => { r.head = "c-new"; return json({ object: { sha: "c-new" } }); } },
        { method: "PUT", url: `${B}/contents/README.md`, respond: () => { r.head = "p1"; return json({ commit: { sha: "p1" } }, 201); } },
      ];
    }),
    { method: "POST", url: "https://api.github.com/graphql", respond: async (req: Request) => {
      const { query } = (await req.json()) as { query: string };
      const repository: Record<string, { text: string } | null> = {};
      for (const m of query.matchAll(/(b\d+): object\(oid: "([0-9a-f]{40})"\)/g)) repository[m[1]!] = texts[m[2]!] === undefined ? null : { text: texts[m[2]!]! };
      return json({ data: { repository } });
    } },
  ];
}

function github(o: { login?: string; id?: number; push?: boolean; admin?: boolean } = {}, repos?: Fake[]) {
  const commit = `c-${crypto.randomUUID()}`;
  const R = `https://api.github.com/repos/${REPO}`;
  const exchanged: FormData[] = [];
  const own = repos ? repoRoutes(repos) : [
    { method: "GET", url: R, respond: () => json({ default_branch: "main", visibility: "private", permissions: { push: true } }) },
    { method: "GET", url: `${R}/git/ref/heads/main`, respond: () => json({ object: { sha: commit } }) },
    { method: "GET", url: `${R}/git/commits/${commit}`, respond: () => json({ sha: commit, message: "m", author: { name: "Dav", date: "" }, html_url: "u", tree: { sha: `t-${commit}` } }) },
    { method: "GET", url: `${R}/git/trees/t-${commit}?recursive=1`, respond: () => json({ truncated: false, tree: [{ path: "README.md", type: "blob", sha: "0".repeat(40) }] }) },
  ];
  const inst = (repos ?? []).filter((r) => r.name !== REPO).map((r) => ({ full_name: r.name, private: true, visibility: "private", permissions: { push: true, admin: true } }));
  const sent: { method: string; url: string; body: string }[] = [];
  const record = (rs: Route[]) => rs.map((r) => ({ ...r, respond: async (req: Request) => {
    if (req.method !== "GET") sent.push({ method: req.method, url: req.url, body: await req.clone().text() });
    return r.respond(req);
  } }));
  const { calls } = mockFetch(record([
    { method: "POST", url: "https://github.com/login/oauth/access_token", respond: async (req) => {
      exchanged.push(await req.formData());
      return json({ access_token: "ghu_live", refresh_token: "ghr_live", expires_in: 28800 });
    } },
    { url: "https://api.github.com/user/installations?", respond: () => json({ installations: [{ id: 1, account: { login: "davlion" } }, { id: 2, account: { login: "acme-org" } }] }) },
    { url: /\/user\/installations\/(\d+)\/repositories/, respond: (req) => json({ repositories: /installations\/1\//.test(req.url)
      ? [{ full_name: REPO, private: true, visibility: "private", permissions: { push: o.push ?? true, admin: o.admin ?? false } }, ...inst]
      : [{ full_name: "acme-org/claude-memory", private: true, visibility: "private", permissions: { push: false } }] }) },
    { url: "https://api.github.com/user", respond: () => json({ login: o.login ?? "dav", id: o.id ?? 42 }) },
    ...own,
  ]));
  return { exchanged, calls, sent };
}

async function signIn(repo?: string) {
  const login = await go(`/keys/login${repo ? `?repo=${encodeURIComponent(repo)}` : ""}`);
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  return go(`/keys/callback?code=GHCODE&state=${state}`);
}

const NEW = `${REPO}-enc`;
beforeEach(async () => {
  jar = new Map();
  for (const p of Object.values(KV)) await env.OAUTH_KV.delete(p + NEW);
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

  it("a POST from another origin, or with Origin: null, → 403 even with a valid csrf", async () => {
    github();
    await signIn();
    const csrf = JSON.parse((await sessionRecord())!).csrf as string;
    for (const origin of ["https://evil.example", "null"]) {
      const res = await go("/keys/register", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin },
        body: new URLSearchParams({ csrf, repo: REPO }) });
      expect(res.status).toBe(403);
      expect(await res.text()).toMatch(/another site/);
    }
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

  it("/ is a small landing page with the key page's headers; other unknown paths stay 404", async () => {
    for (const method of ["GET", "HEAD"]) {
      const res = await go("/", { method });
      expect(res.status, method).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/^text\/html/);
      expectHardened(res);
      if (method === "GET") {
        const html = await res.text();
        expect(html).toContain("<title>claude-memory</title>");
        expect(html).toContain("This is a claude-memory server: Claude's memory tool. Connect it in claude.ai → Settings → Connectors.");
        expect(html).toContain('<a href="/keys">Key page (encryption at rest)</a>');
        expect(html).not.toContain("<script");
      }
    }
    expect((await go("/", { method: "POST" })).status).not.toBe(200);
    expect((await go("/nope")).status).toBe(404);
    expect((await go("/health")).status).toBe(200);
  });

  it("unknown /keys paths are 404 with the headers", async () => {
    const res = await go("/keys/nope");
    expect(res.status).toBe(404);
    expectHardened(res);
  });
});

const IN_PLACE_WARNING = "Turning on encryption replaces this repo's whole history with a single commit. Past changes and their log are gone. The old commits stay readable through the repo's activity log by anyone with read access until GitHub Support purges them: request that at https://support.github.com/request after this finishes. Clones and forks made before now keep the old plaintext. A rule that blocks force pushes on the branch must be lifted first. Without this key your memories can't be read: keep it in your password manager. To continue, paste the key back and type the repo name.";
const FRESH_WARNING = "Your encrypted memories will be written to a new, empty private repo. Then you delete this repo and rename the new one to this name. Until you do, saves wait. Deleting is what removes the old plaintext; clones and forks made before now keep it. Without this key your memories can't be read: keep it in your password manager. To continue, paste the key back and type the repo name.";
const ADMIN_ONLY = `Only an admin of ${REPO} can turn encryption on or off.`;
const KEY_RE = /cmk1_[A-Za-z0-9_-]{43}/;

/** Reads a streamed response chunk by chunk: the first chunk, its size in bytes, and the whole body. */
async function readStream(res: Response) {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  const parts: string[] = [];
  let firstBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!parts.length) firstBytes = value.byteLength;
    parts.push(dec.decode(value, { stream: true }));
  }
  return { first: parts[0] ?? "", firstBytes, text: parts.join("") + dec.decode() };
}
/** Each of `want` appears in `text`, in this order. */
const expectInOrder = (text: string, want: string[]) => {
  let at = 0;
  for (const w of want) {
    const i = text.indexOf(w, at);
    expect(i, `${w} after offset ${at}`).toBeGreaterThanOrEqual(0);
    at = i + w.length;
  }
};
const expectStreamed = async (res: Response) => {
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
  expect(res.headers.get("content-length")).toBeNull();
  expectHardened(res);
  const out = await readStream(res);
  expect(out.firstBytes).toBeGreaterThanOrEqual(1024);
  expect(out.first).toContain(`<h1>Turning on encryption for ${REPO}</h1>`);
  expect(out.first).toContain("<p>This can take a minute. Keep this page open.</p>");
  expect(out.text.startsWith("<!doctype html>")).toBe(true);
  expect(out.text.trimEnd().endsWith("</html>")).toBe(true);
  return out;
};

describe("key page actions", () => {
  const ring = async () => (await KeyRing.fromEnv(env))!;
  const act = async (path: string, fields: Record<string, string>) => {
    const csrf = JSON.parse((await sessionRecord())!).csrf as string;
    return go(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin: BASE },
      body: new URLSearchParams({ csrf, ...fields }) });
  };
  type Sent = { method: string; url: string; body: string };
  const writes = (sent: Sent[]) => sent.filter((c) => c.url.startsWith("https://api.github.com/repos/"));
  const bodyOf = async (sent: Sent[], method: string, suffix: string) =>
    JSON.parse(sent.find((c) => c.method === method && c.url.endsWith(suffix))!.body) as Record<string, unknown>;
  /** An encrypted repo: marker signed by `text`, record to match. */
  const encrypted = async (text: string, enabled = true, repoId = newRepoId()) => {
    const key = await parseKeyText(text);
    const marker = await signMarker(key, { enabled, repoId, keyId: key.id });
    await (await ring()).putRecord(REPO, { repoId, keyId: key.id, enabled, confirmed: true });
    return { key, marker, repo: fake(REPO, { marker: serializeMarker(marker) }) };
  };
  const turnOn = async () => {
    const res = await act("/keys/turn-on", { repo: REPO });
    expect(res.status).toBe(200);
    const body = await res.text();
    return { res, body, key: KEY_RE.exec(body)![0] };
  };

  it("mayChangeEncryption needs admin", () => {
    expect(mayChangeEncryption({ push: true })).toBe(false);
    expect(mayChangeEncryption({ push: true, admin: true })).toBe(true);
  });

  it("turn on in place: the key is shown once, only in the body; confirm seals the tree, force-pushes and stores key and record", async () => {
    const { calls, sent } = github({ admin: true }, [fake(REPO)]);
    await signIn();
    const { res, body, key } = await turnOn();
    expect(body).toMatch(/save this in your password manager now/i);
    expectHardened(res);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain(esc(IN_PLACE_WARNING));
    expect(body).toContain(esc(FRESH_WARNING));
    expect(body.match(new RegExp(key, "g"))).toHaveLength(1);
    for (const [, v] of res.headers) expect(v).not.toContain(key);
    expect(writes(sent)).toEqual([]);
    const hash = await hashed(jar.get("__Host-keys")!);
    const pending = (await env.OAUTH_KV.get(`keypending:${hash}:${REPO}`))!;
    expect(pending).not.toContain(key);
    expect(await (await ring()).unwrapText(pending, `keypending-v1\n${hash}\n${REPO}`)).toBe(key);

    const conf = await act("/keys/turn-on/confirm", { repo: REPO, key, confirm_repo: REPO.toUpperCase(), path: "in-place" });
    const { text } = await expectStreamed(conf);
    expectInOrder(text, [`<h1>Turning on encryption for ${REPO}</h1>`, "<ol>", `<li>Read ${REPO}: 1 memory</li>`, "<li>Encrypted 1 memory</li>",
      "<li>Wrote the new history (one commit)</li>", "<li>Stored the key</li>", "</ol>", `<h2>Encryption is on for ${REPO}</h2>`,
      `https://github.com/${REPO}/commit/c-new`, '<a href="/keys">Back to the key page</a>']);
    for (const [, v] of conf.headers) expect(v).not.toContain(key);
    expect(text).toContain(`https://github.com/${REPO}/commit/c-new`);
    expect(text).toContain("https://support.github.com/request");
    expect(text).not.toContain(key);
    for (const c of calls) expect(c.url).not.toContain(key);
    for (const c of sent) expect(c.body).not.toContain(key);
    const tree = (await bodyOf(sent, "POST", "/git/trees")) as { base_tree?: string; tree: { path: string; content?: string }[] };
    expect(tree.base_tree).toBeUndefined();
    expect(JSON.stringify(tree)).not.toContain("alpha secret body");
    const parsed = await parseKeyText(key);
    const marker = parseMarker(tree.tree.find((f) => f.path === MARKER_PATH)!.content!);
    expect(marker).toMatchObject({ enabled: true, keyId: parsed.id });
    expect(await markerSignedBy(parsed, marker)).toBe(true);
    expect(await bodyOf(sent, "PATCH", "/git/refs/heads/main")).toEqual({ sha: "c-new", force: true });
    const r = await ring();
    expect((await r.get(REPO))!.key.id).toBe(parsed.id);
    expect(await r.getRecord(REPO)).toEqual({ repoId: marker.repoId, keyId: parsed.id, enabled: true, confirmed: true });
    expect(await env.OAUTH_KV.get(`keypending:${hash}:${REPO}`)).toBeNull();
  });

  it("a failure after the force push says the repo IS encrypted and to register the key", async () => {
    github({ admin: true }, [fake(REPO)]);
    await signIn();
    const { key } = await turnOn();
    vi.spyOn(KeyRing.prototype, "putRecord").mockRejectedValueOnce(new Error("KV write failed"));
    const res = await act("/keys/turn-on/confirm", { repo: REPO, key, confirm_repo: REPO, path: "in-place" });
    const { text } = await expectStreamed(res);
    expectInOrder(text, ["<li>Wrote the new history (one commit)</li>", "</ol>", "<h2>Encryption is on, but didn&#39;t finish</h2>", `${REPO} IS encrypted now`]);
    expect(text).not.toContain("<li>Stored the key</li>");
    expect(text).toMatch(/register the key on this page/);
    expect(text).not.toContain(key);
  });

  it("fresh: a failure after the copy was written clears the move flag and says so", async () => {
    github({ admin: true }, [fake(REPO), fake(NEW, { head: null })]);
    await signIn();
    const { key } = await turnOn();
    vi.spyOn(KeyRing.prototype, "putRecord").mockRejectedValueOnce(new Error("KV write failed"));
    const res = await act("/keys/turn-on/confirm", { repo: REPO, key, confirm_repo: REPO, path: "fresh", new_repo: NEW });
    const { text } = await expectStreamed(res);
    expectInOrder(text, [`<li>Checked ${REPO} didn&#39;t change during the copy</li>`, "</ol>", "<h2>Encryption wasn&#39;t turned on</h2>",
      `The encrypted copy was written to ${NEW}, but the switch didn&#39;t finish`]);
    expect(text).toContain(`${REPO} is unchanged and saves to it continue`);
    expect(await (await ring()).getMove(REPO)).toBeNull();
    expect(text).not.toContain(key);
  });

  it("GitHub rejecting the commit: the error is streamed, the page is complete, and the same key works on retry", async () => {
    github({ admin: true }, [fake(REPO)]);
    await signIn();
    const { key } = await turnOn();
    vi.spyOn(GitHubStore.prototype, "replaceHistory").mockRejectedValueOnce(
      new OpError("write_rejected", "GitHub rejected the commit.", "Lift the rule that blocks force pushes, then try again."));
    const res = await act("/keys/turn-on/confirm", { repo: REPO, key, confirm_repo: REPO, path: "in-place" });
    const { text } = await expectStreamed(res);
    expectInOrder(text, [`<li>Read ${REPO}: 1 memory</li>`, "<li>Encrypted 1 memory</li>", "</ol>",
      "<h2>Encryption wasn&#39;t turned on</h2>", "<p>GitHub rejected the commit. Lift the rule that blocks force pushes, then try again.</p>"]);
    expect(text).not.toContain("<li>Wrote");
    expect(text).not.toContain(key);
    expect(await (await ring()).get(REPO)).toBeNull();
    const hash = await hashed(jar.get("__Host-keys")!);
    expect(await env.OAUTH_KV.get(`keypending:${hash}:${REPO}`)).not.toBeNull();
    const again = await act("/keys/turn-on/confirm", { repo: REPO, key, confirm_repo: REPO, path: "in-place" });
    expect((await expectStreamed(again)).text).toContain(`Encryption is on for ${REPO}`);
  });

  it("turn on fresh: writes only to new_repo, sets the move and lists the rename steps", async () => {
    const { calls, sent } = github({ admin: true }, [fake(REPO), fake(NEW, { head: null })]);
    await signIn();
    const { key } = await turnOn();
    const conf = await act("/keys/turn-on/confirm", { repo: REPO, key, confirm_repo: REPO, path: "fresh", new_repo: NEW });
    const { text } = await expectStreamed(conf);
    expectInOrder(text, [`<h1>Turning on encryption for ${REPO}</h1>`, "<ol>", `<li>Read ${REPO}: 1 memory</li>`, "<li>Encrypted 1 memory</li>",
      `<li>Wrote the encrypted copy to ${NEW}</li>`, `<li>Checked ${REPO} didn&#39;t change during the copy</li>`, "<li>Stored the key</li>",
      "</ol>", `<h2>Finish moving ${REPO}</h2>`, `The encrypted copy is in <strong>${NEW}</strong>`, '<a href="/keys">Back to the key page</a>']);
    expect(text).not.toContain(key);
    for (const c of calls) expect(c.url).not.toContain(key);
    for (const c of sent) expect(c.body).not.toContain(key);
    const w = writes(sent);
    expect(w.length).toBeGreaterThan(0);
    for (const c of w) expect(c.url.startsWith(`https://api.github.com/repos/${NEW}/`)).toBe(true);
    expect(await (await ring()).getMove(REPO)).toMatchObject({ to: NEW });
    expect(text).toContain(`https://github.com/${REPO}/settings`);
    expect(text).toContain(`https://github.com/${NEW}/settings`);
    expect(text).toMatch(/Delete <strong>davlion\/claude-memory-test<\/strong>/);
    expect(text).toMatch(/90 days/);
  });

  it("a wrong key, wrong confirm_repo, expired pending key or non-empty new_repo → an error and no GitHub writes", async () => {
    const { calls, sent } = github({ admin: true }, [fake(REPO), fake(NEW, { head: "c9" })]);
    await signIn();
    const { key } = await turnOn();
    const cases: [Record<string, string>, RegExp][] = [
      [{ key: generateKeyText(), confirm_repo: REPO, path: "in-place" }, /the key shown when you started/],
      [{ key, confirm_repo: "davlion/other", path: "in-place" }, /doesn&#39;t match/],
      [{ key, confirm_repo: REPO, path: "fresh", new_repo: NEW }, /isn&#39;t empty/],
      [{ key, confirm_repo: REPO, path: "sideways" }, /Choose/],
    ];
    for (const [fields, want] of cases) {
      const res = await act("/keys/turn-on/confirm", { repo: REPO, ...fields });
      const text = await res.text();
      expect(res.status, text).toBe(400);
      expect(text).not.toContain("Turning on encryption");
      expect(text).toMatch(want);
      expect(text).not.toContain(key);
    }
    await env.OAUTH_KV.delete(`keypending:${await hashed(jar.get("__Host-keys")!)}:${REPO}`);
    const expired = await act("/keys/turn-on/confirm", { repo: REPO, key, confirm_repo: REPO, path: "in-place" });
    expect(expired.status).toBe(400);
    expect(await expired.text()).toMatch(/expired/);
    expect(writes(sent)).toEqual([]);
    expect(await (await ring()).get(REPO)).toBeNull();
  });

  it("turning back on asks for the existing key instead of generating one, and keeps the repo ID", async () => {
    const text = generateKeyText();
    const { marker, repo } = await encrypted(text, false);
    const { calls, sent } = github({ admin: true }, [repo]);
    await signIn();
    const res = await act("/keys/turn-on", { repo: REPO });
    const body = await res.text();
    expect(res.status).toBe(200);
    expect(body).not.toMatch(KEY_RE);
    expect(body).toMatch(/existing key/i);
    // Only in place: a fresh copy would share the old repo's ID, and its "off" marker would end the move early.
    expect(body).not.toContain('value="fresh"');
    expect(body).toContain('value="in-place"');
    const fresh = await act("/keys/turn-on/confirm", { repo: REPO, key: text, confirm_repo: REPO, path: "fresh", new_repo: `${REPO}-enc` });
    expect(fresh.status).toBe(400);
    expect(await fresh.text()).toMatch(/in place/i);
    expect(writes(sent)).toEqual([]);
    expect(await (await ring()).getMove(REPO)).toBeNull();
    const wrong =await act("/keys/turn-on/confirm", { repo: REPO, key: generateKeyText(), confirm_repo: REPO, path: "in-place" });
    expect(await wrong.text()).toContain(`This isn&#39;t the key for ${REPO}.`);
    expect(writes(sent)).toEqual([]);
    const ok = await act("/keys/turn-on/confirm", { repo: REPO, key: text, confirm_repo: REPO, path: "in-place" });
    expect((await expectStreamed(ok)).text).toContain(`Encryption is on for ${REPO}`);
    const tree = (await bodyOf(sent, "POST", "/git/trees")) as { tree: { path: string; content?: string }[] };
    expect(parseMarker(tree.tree.find((f) => f.path === MARKER_PATH)!.content!)).toMatchObject({ enabled: true, repoId: marker.repoId });
    expect(await (await ring()).getRecord(REPO)).toMatchObject({ enabled: true, repoId: marker.repoId });
  });

  it("turning back on lists the memories flagged as added outside the memory tool, names only", async () => {
    const text = generateKeyText();
    const key = await parseKeyText(text);
    const repoId = newRepoId();
    // Decrypted outside (the key verifies an off marker, the record is on): the plaintext memories are flagged.
    await (await ring()).put(REPO, text, "dav", Date.now());
    await (await ring()).putRecord(REPO, { repoId, keyId: key.id, enabled: true });
    const repo = fake(REPO, { marker: serializeMarker(await signMarker(key, { enabled: false, repoId, keyId: key.id })) });
    github({ admin: true }, [repo]);
    await signIn();
    let body = await (await act("/keys/turn-on", { repo: REPO })).text();
    expect(body).toContain("This file was added outside the memory tool and will be encrypted too. Review it first:");
    expect(body).toContain("<li>memories/a.md</li>");
    expect(body).not.toContain("alpha secret");
    repo.tree.push({ path: "projects/x/memories/b.md", type: "blob", sha: oid(9), mode: "100644" });
    repo.texts[oid(9)] = MEM.replace("name: a", "name: b");
    github({ admin: true }, [repo]);
    body = await (await act("/keys/turn-on", { repo: REPO })).text();
    expect(body).toContain("These 2 files were added outside the memory tool and will be encrypted too. Review them first:");
    expectInOrder(body, ["<li>memories/a.md</li>", "<li>projects/x/memories/b.md</li>"]);
    // After Stop the record is off: plaintext saves are the memory tool's own, nothing is flagged.
    await (await ring()).putRecord(REPO, { repoId, keyId: key.id, enabled: false });
    github({ admin: true }, [repo]);
    body = await (await act("/keys/turn-on", { repo: REPO })).text();
    expect(body).not.toContain("added outside the memory tool");
  });

  it("an already encrypted repo can't be turned on again", async () => {
    const { repo } = await encrypted(generateKeyText());
    const { calls, sent } = github({ admin: true }, [repo]);
    await signIn();
    const res = await act("/keys/turn-on", { repo: REPO });
    expect(res.status).toBe(409);
    expect(writes(sent)).toEqual([]);
  });

  it("register and remove need the repo's key", async () => {
    const text = generateKeyText();
    const { key, repo } = await encrypted(text);
    github({ admin: true }, [repo]);
    await signIn();
    const bad = await act("/keys/register", { repo: REPO, key: generateKeyText() });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain(`This isn&#39;t the key for ${REPO}.`);
    expect(await (await ring()).get(REPO)).toBeNull();
    const notAKey = await act("/keys/register", { repo: REPO, key: "nope" });
    expect(notAKey.status).toBe(400);
    const ok = await act("/keys/register", { repo: REPO, key: text });
    expect(ok.status, await ok.clone().text()).toBe(200);
    expect((await (await ring()).get(REPO))!.key.id).toBe(key.id);
    const badRemove = await act("/keys/remove", { repo: REPO, key: generateKeyText() });
    expect(badRemove.status).toBe(400);
    expect(await (await ring()).get(REPO)).not.toBeNull();
    expect((await act("/keys/remove", { repo: REPO, key: text })).status).toBe(200);
    expect(await (await ring()).get(REPO)).toBeNull();
  });

  it("register updates the record's key to a marker signed by the pasted key (rotate), but never turns encryption off", async () => {
    const text = generateKeyText();
    const key = await parseKeyText(text);
    const repoId = newRepoId();
    // memcrypt decrypt, or an old signed off marker put back: the record says enabled, the signed marker says off.
    // Even an admin's plain register keeps it on; turning it off is Confirm decryption's job.
    const off = await signMarker(key, { enabled: false, repoId, keyId: key.id });
    await (await ring()).putRecord(REPO, { repoId, keyId: key.id, enabled: true });
    github({ admin: true }, [fake(REPO, { marker: serializeMarker(off) })]);
    await signIn();
    const reg = await act("/keys/register", { repo: REPO, key: text });
    expect(reg.status).toBe(200);
    const said = await reg.text();
    expect(said).not.toContain("Encryption is off");
    expect(said).toContain(`Encryption stays on for ${REPO}`);
    expect(await (await ring()).getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: true, confirmed: true });
    expect((await (await ring()).get(REPO))!.key.id).toBe(key.id);

    // memcrypt rotate: the record names the old key, the marker is signed by the new one.
    const next = generateKeyText();
    const nk = await parseKeyText(next);
    const rotated = await signMarker(nk, { enabled: true, repoId, keyId: nk.id });
    github({ admin: true }, [fake(REPO, { marker: serializeMarker(rotated) })]);
    expect((await act("/keys/register", { repo: REPO, key: next })).status).toBe(200);
    expect(await (await ring()).getRecord(REPO)).toEqual({ repoId, keyId: nk.id, enabled: true, confirmed: true });
  });

  it("confirming a decryption with the key already registered turns the record off, and saves go plaintext", async () => {
    const text = generateKeyText();
    const key = await parseKeyText(text);
    const repoId = newRepoId();
    const off = await signMarker(key, { enabled: false, repoId, keyId: key.id });
    await (await ring()).put(REPO, text, "dav", Date.now());
    await (await ring()).putRecord(REPO, { repoId, keyId: key.id, enabled: true });
    const gh = fake(REPO, { marker: serializeMarker(off) });
    github({ admin: true }, [gh]);
    await signIn();
    const page = await (await go(`/keys?repo=${encodeURIComponent(REPO)}`)).text();
    expect(page).toMatch(/action="\/keys\/confirm-decryption"[\s\S]*Confirm decryption \(turn encryption off\)/);
    const done = await act("/keys/confirm-decryption", { repo: REPO, key: text });
    expect(done.status).toBe(200);
    expect(await done.text()).toContain(`Encryption is off for ${REPO}: new memories are saved unencrypted.`);
    expect(await (await ring()).getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: false, confirmed: true });
    const inner = new FakeStore();
    inner.put(REPO, MARKER_PATH, serializeMarker(off));
    const enc = new EncryptingStore(inner, await ring(), "https://memory.test/keys");
    await saveMemory(enc, { scopeLabel: "general", displayLabel: "general", repo: REPO, prefix: "" },
      { name: "a", description: "plain thing", type: "project", body: "x\n", source: "t", force: true }, new Date(), { kind: "general", others: [] });
    expect(isEncryptedFile(inner.repo(REPO).get("memories/a.md")!)).toBe(false);
  });

  it("confirm decryption without the key registered first: the pasted key verifies the off marker", async () => {
    const text = generateKeyText();
    const key = await parseKeyText(text);
    const repoId = newRepoId();
    const off = await signMarker(key, { enabled: false, repoId, keyId: key.id });
    await (await ring()).putRecord(REPO, { repoId, keyId: key.id, enabled: true });
    github({ admin: true }, [fake(REPO, { marker: serializeMarker(off) })]);
    await signIn();
    const page = await (await go(`/keys?repo=${encodeURIComponent(REPO)}`)).text();
    expect(page).toContain("can't be checked without the key");
    expect(page).toMatch(/action="\/keys\/confirm-decryption"/);
    const res = await act("/keys/confirm-decryption", { repo: REPO, key: text });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await res.text()).toContain(`Encryption is off for ${REPO}: new memories are saved unencrypted.`);
    expect(await (await ring()).getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: false, confirmed: true });
    expect((await (await ring()).get(REPO))!.key.id).toBe(key.id);
  });

  it("confirm decryption refuses while memories are still encrypted (an old off marker put back, not a decryption)", async () => {
    const text = generateKeyText();
    const key = await parseKeyText(text);
    const repoId = newRepoId();
    await (await ring()).putRecord(REPO, { repoId, keyId: key.id, enabled: true, confirmed: true });
    const repo = fake(REPO, { marker: serializeMarker(await signMarker(key, { enabled: false, repoId, keyId: key.id })) });
    repo.tree.push({ path: "projects/x/memories/b.md", type: "blob", sha: oid(9), mode: "100644" });
    repo.texts[oid(9)] = await sealMemoryFile(key, repoId, "projects/x/memories/b.md", MEM.replace("name: a", "name: b"));
    github({ admin: true }, [repo]);
    await signIn();
    const res = await act("/keys/confirm-decryption", { repo: REPO, key: text });
    const body = await res.text();
    expect(res.status, body).toBe(409);
    expect(body).toContain(`${REPO} still has 1 encrypted memory file, so it wasn&#39;t decrypted`);
    expect(await (await ring()).getRecord(REPO)).toMatchObject({ enabled: true });
  });

  it("confirm decryption: admin only", async () => {
    const text = generateKeyText();
    const key = await parseKeyText(text);
    const repoId = newRepoId();
    const off = await signMarker(key, { enabled: false, repoId, keyId: key.id });
    await (await ring()).putRecord(REPO, { repoId, keyId: key.id, enabled: true });
    const { sent } = github({ push: true, admin: false }, [fake(REPO, { marker: serializeMarker(off) })]);
    await signIn();
    const res = await act("/keys/confirm-decryption", { repo: REPO, key: text });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(esc(ADMIN_ONLY));
    expect(await (await ring()).getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: true });
    expect(await (await ring()).get(REPO)).toBeNull();
    expect(writes(sent)).toEqual([]);
    const page = await (await go(`/keys?repo=${encodeURIComponent(REPO)}`)).text();
    expect(page).not.toContain("/keys/confirm-decryption");
  });

  it("confirm decryption refuses unless this key signed a marker that says off, and the record is on", async () => {
    const text = generateKeyText();
    const key = await parseKeyText(text);
    const repoId = newRepoId();
    const r = await ring();
    // The marker says on.
    const { repo } = await encrypted(text, true, repoId);
    github({ admin: true }, [repo]);
    await signIn();
    let res = await act("/keys/confirm-decryption", { repo: REPO, key: text });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(`The encryption marker of ${REPO} doesn&#39;t say off`);
    expect(await r.getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: true, confirmed: true });
    // An off marker this key didn't sign (another key, or forged).
    const other = await parseKeyText(generateKeyText());
    github({ admin: true }, [fake(REPO, { marker: serializeMarker(await signMarker(other, { enabled: false, repoId, keyId: other.id })) })]);
    res = await act("/keys/confirm-decryption", { repo: REPO, key: text });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain(`This isn&#39;t the key for ${REPO}.`);
    const forged = { enabled: false, repoId, keyId: key.id, mac: "0".repeat(64) };
    github({ admin: true }, [fake(REPO, { marker: serializeMarker(forged) })]);
    res = await act("/keys/confirm-decryption", { repo: REPO, key: text });
    expect(res.status).toBe(400);
    expect(await r.getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: true, confirmed: true });
    // No marker at all: the record's key matches, but nothing says the repo was decrypted.
    github({ admin: true }, [fake(REPO)]);
    res = await act("/keys/confirm-decryption", { repo: REPO, key: text });
    expect(res.status).toBe(409);
    expect(await r.getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: true, confirmed: true });
    // The record is already off (after Stop).
    await r.putRecord(REPO, { repoId, keyId: key.id, enabled: false });
    github({ admin: true }, [fake(REPO, { marker: serializeMarker(await signMarker(key, { enabled: false, repoId, keyId: key.id })) })]);
    res = await act("/keys/confirm-decryption", { repo: REPO, key: text });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain(`${REPO} isn&#39;t encrypting new saves.`);
    expect(await r.get(REPO)).toBeNull();
  });

  it("without admin, register keeps encryption on but updates the key ID and turns it back on", async () => {
    const text = generateKeyText();
    const key = await parseKeyText(text);
    const repoId = newRepoId();
    const off = await signMarker(key, { enabled: false, repoId, keyId: key.id });
    await (await ring()).putRecord(REPO, { repoId, keyId: key.id, enabled: true, confirmed: true });
    github({ push: true, admin: false }, [fake(REPO, { marker: serializeMarker(off) })]);
    await signIn();
    const res = await act("/keys/register", { repo: REPO, key: text });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`Key registered. Encryption stays on for ${REPO}; an admin can turn it off with Stop.`);
    expect(await (await ring()).getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: true, confirmed: true });
    expect((await (await ring()).get(REPO))!.key.id).toBe(key.id);

    // Disabled → enabled with the same IDs stays allowed for write users.
    await (await ring()).putRecord(REPO, { repoId, keyId: key.id, enabled: false, confirmed: true });
    github({ push: true, admin: false }, [fake(REPO, { marker: serializeMarker(await signMarker(key, { enabled: true, repoId, keyId: key.id })) })]);
    expect((await act("/keys/register", { repo: REPO, key: text })).status).toBe(200);
    expect(await (await ring()).getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: true, confirmed: true });

    // A new key ID (rotate) needs admin: nothing is written.
    const next = generateKeyText();
    const nk = await parseKeyText(next);
    github({ push: true, admin: false }, [fake(REPO, { marker: serializeMarker(await signMarker(nk, { enabled: true, repoId, keyId: nk.id })) })]);
    const res2 = await act("/keys/register", { repo: REPO, key: next });
    expect(res2.status).toBe(403);
    expect(await res2.text()).toContain(esc(`Only an admin of ${REPO} can register a new key for it (the key was changed, e.g. with memcrypt rotate).`));
    expect(await (await ring()).getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: true, confirmed: true });
    expect((await (await ring()).get(REPO))!.key.id).toBe(key.id);
  });

  const UNCONFIRMED = `Only an admin of ${REPO} can register this key: the memory tool hasn&#39;t seen an admin confirm this repo&#39;s encryption key.`;

  it("a write user can't take over a never-encrypted repo: a planted marker teaches an unconfirmed record, and register needs admin", async () => {
    const r = await ring();
    const mine = generateKeyText();
    const mk = await parseKeyText(mine);
    const planted = await signMarker(mk, { enabled: true, repoId: newRepoId(), keyId: mk.id });
    const { sent } = github({ login: "dav", push: true, admin: false }, [fake(REPO, { marker: serializeMarker(planted) })]);
    await signIn();
    // Before any read: no record at all.
    let res = await act("/keys/register", { repo: REPO, key: mine });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(UNCONFIRMED);
    // Opening the key page learns a record from the planted marker; it isn't confirmed.
    const page = await (await go(`/keys?repo=${encodeURIComponent(REPO)}`)).text();
    expect(page).toContain("An admin of");
    const learned = await r.getRecord(REPO);
    expect(learned).toMatchObject({ keyId: mk.id, enabled: true });
    expect(learned!.confirmed).toBeUndefined();
    res = await act("/keys/register", { repo: REPO, key: mine });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(UNCONFIRMED);
    expect(await r.get(REPO)).toBeNull();
    expect(await r.getRecord(REPO)).toEqual(learned);
    expect(writes(sent)).toEqual([]);
  });

  it("an admin's register confirms a learned record; a write user can then register that key", async () => {
    const r = await ring();
    const text = generateKeyText();
    const key = await parseKeyText(text);
    const repoId = newRepoId();
    const marker = await signMarker(key, { enabled: true, repoId, keyId: key.id });
    await r.putRecord(REPO, { repoId, keyId: key.id, enabled: true }); // learned (memcrypt encrypt, then a read)
    github({ admin: true }, [fake(REPO, { marker: serializeMarker(marker) })]);
    await signIn();
    const page = await (await go(`/keys?repo=${encodeURIComponent(REPO)}`)).text();
    expect(page).toContain("Registering the key here confirms it");
    expect((await act("/keys/register", { repo: REPO, key: text })).status).toBe(200);
    expect(await r.getRecord(REPO)).toEqual({ repoId, keyId: key.id, enabled: true, confirmed: true });
    await r.remove(REPO);
    github({ push: true, admin: false }, [fake(REPO, { marker: serializeMarker(marker) })]);
    expect((await act("/keys/register", { repo: REPO, key: text })).status).toBe(200);
    expect((await r.get(REPO))!.key.id).toBe(key.id);
  });

  it("a write user can't take a repo over with a planted marker signed by their own key", async () => {
    const real = generateKeyText();
    const rk = await parseKeyText(real);
    const repoId = newRepoId();
    const r = await ring();
    await r.putRecord(REPO, { repoId, keyId: rk.id, enabled: true, confirmed: true });
    await r.put(REPO, real, "dav", Date.now());
    const mine = generateKeyText();
    const mk = await parseKeyText(mine);
    for (const plantedId of [repoId, newRepoId()]) {
      const planted = await signMarker(mk, { enabled: true, repoId: plantedId, keyId: mk.id });
      const { sent } = github({ login: "dav", push: true, admin: false }, [fake(REPO, { marker: serializeMarker(planted) })]);
      if (!jar.has("__Host-keys")) await signIn();
      const res = await act("/keys/register", { repo: REPO, key: mine });
      expect(res.status, plantedId).toBe(403);
      expect(await res.text()).toContain(esc(`Only an admin of ${REPO} can register a new key for it (the key was changed, e.g. with memcrypt rotate).`));
      expect(await r.getRecord(REPO)).toEqual({ repoId, keyId: rk.id, enabled: true, confirmed: true });
      expect((await (await ring()).get(REPO))!.key.id).toBe(rk.id);
      expect(writes(sent)).toEqual([]);
    }
  });

  it("after a rotate, the old key is refused even though the record still names it", async () => {
    const old = generateKeyText();
    const ok = await parseKeyText(old);
    const nk = await parseKeyText(generateKeyText());
    const repoId = newRepoId();
    await (await ring()).putRecord(REPO, { repoId, keyId: ok.id, enabled: true });
    const { sent } = github({ admin: true }, [fake(REPO, { marker: serializeMarker(await signMarker(nk, { enabled: true, repoId, keyId: nk.id })) })]);
    await signIn();
    for (const path of ["register", "remove", "stop"]) {
      const res = await act(`/keys/${path}`, { repo: REPO, key: old });
      expect(res.status, path).toBe(400);
      expect(await res.text()).toContain(`This isn&#39;t the key for ${REPO}.`);
    }
    expect(await (await ring()).get(REPO)).toBeNull();
    expect(writes(sent)).toEqual([]);
  });

  it("stop: refused without the key; with it, a signed enabled: false marker is committed and the record updated", async () => {
    const text = generateKeyText();
    const { key, marker, repo } = await encrypted(text);
    const head = repo.head;
    const { sent } = github({ admin: true }, [repo]);
    await signIn();
    for (const k of ["", generateKeyText()]) {
      const res = await act("/keys/stop", { repo: REPO, key: k });
      expect(res.status).toBe(400);
    }
    expect(writes(sent)).toEqual([]);
    const res = await act("/keys/stop", { repo: REPO, key: text });
    const body = await res.text();
    expect(res.status, body).toBe(200);
    expect(body).toContain("memcrypt decrypt");
    const tree = (await bodyOf(sent, "POST", "/git/trees")) as { base_tree: string; tree: { path: string; content: string }[] };
    expect(tree.base_tree).toBe(`t-${head}`);
    expect(tree.tree).toHaveLength(1);
    const m = parseMarker(tree.tree[0]!.content);
    expect(tree.tree[0]!.path).toBe(MARKER_PATH);
    expect(m).toMatchObject({ enabled: false, repoId: marker.repoId, keyId: key.id });
    expect(await markerSignedBy(key, m)).toBe(true);
    expect((await bodyOf(sent, "POST", "/git/commits")).message).toBe("encrypt: stop encrypting new saves\n\nMemory-Source: key page (dav)\nMemory-Scope: *\n");
    expect(await bodyOf(sent, "PATCH", "/git/refs/heads/main")).toEqual({ sha: "c-new", force: false });
    expect(await (await ring()).getRecord(REPO)).toEqual({ repoId: marker.repoId, keyId: key.id, enabled: false, confirmed: true });
  });

  it("a repo not in SCOPES → 403 on every action", async () => {
    const { calls, sent } = github({ admin: true }, [fake(REPO)]);
    await signIn();
    for (const path of ["turn-on", "turn-on/confirm", "register", "remove", "stop", "cancel-move", "confirm-decryption", "forget"]) {
      const res = await act(`/keys/${path}`, { repo: "someone/else", key: generateKeyText(), confirm_repo: "someone/else", path: "in-place" });
      expect(res.status, path).toBe(403);
    }
    expect(writes(sent)).toEqual([]);
  });

  it("write without admin: turn-on, confirm and stop → 403; register and remove still work", async () => {
    const text = generateKeyText();
    const { repo } = await encrypted(text);
    const { calls, sent } = github({ push: true, admin: false }, [repo]);
    await signIn();
    for (const path of ["turn-on", "turn-on/confirm", "stop"]) {
      const res = await act(`/keys/${path}`, { repo: REPO, key: text, confirm_repo: REPO, path: "in-place" });
      expect(res.status, path).toBe(403);
      expect(await res.text()).toContain(esc(ADMIN_ONLY));
    }
    expect((await act("/keys/register", { repo: REPO, key: text })).status).toBe(200);
    expect((await act("/keys/remove", { repo: REPO, key: text })).status).toBe(200);
    expect(writes(sent)).toEqual([]);
  });

  /** A record the memory tool learned from files a write user planted (and has since removed): no marker, nothing sealed. */
  const learned = async () => {
    const rec = { repoId: "", keyId: "0123456789abcdef", enabled: true };
    await (await ring()).putRecord(REPO, rec);
    return rec;
  };
  const SEALED = "---\nencrypted: claude-memory-v1\nname: b\nkey_id: 0123456789abcdef\n---\nAAAA\n";
  const FORGET = "Forget encryption for this repo";

  it("forget: an admin drops a record when nothing in the repo is encrypted or marked", async () => {
    await learned();
    const r = await ring();
    await r.put(REPO, generateKeyText(), "dav", Date.now());
    github({ admin: true }, [fake(REPO)]);
    await signIn();
    const page = await (await go(`/keys?repo=${encodeURIComponent(REPO)}`)).text();
    expect(page).toMatch(new RegExp(`action="/keys/forget"[\\s\\S]*${FORGET}`));
    // The form shows only when nothing is moving (cancel the move there instead), but forgetting also drops a move flag.
    await r.setMove(REPO, { to: NEW, repoId: "x", head: null, prevRecord: null });
    await env.CACHE_KV.put(`snap:v3:${REPO}:c1:`, "{}");
    const res = await act("/keys/forget", { repo: REPO });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).toContain(`${REPO} isn&#39;t treated as encrypted any more.`);
    expect(await r.getRecord(REPO)).toBeNull();
    expect(await (await ring()).get(REPO)).toBeNull();
    expect(await r.getMove(REPO)).toBeNull();
    expect(await env.CACHE_KV.get(`snap:v3:${REPO}:c1:`)).toBeNull();
    const after = await (await go(`/keys?repo=${encodeURIComponent(REPO)}`)).text();
    expect(after).toContain("Not encrypted.");
    expect(after).not.toContain(FORGET);
  });

  it("forget: refused while any memory file in the repo is encrypted, in any set", async () => {
    const rec = await learned();
    const repo = fake(REPO);
    repo.tree.push({ path: "projects/x/memories/b.md", type: "blob", sha: oid(9), mode: "100644" });
    repo.texts[oid(9)] = SEALED;
    const { sent } = github({ admin: true }, [repo]);
    await signIn();
    const res = await act("/keys/forget", { repo: REPO });
    const text = await res.text();
    expect(res.status, text).toBe(409);
    expect(text).toContain(`${REPO} still has 1 encrypted memory file (projects/x/memories/b.md)`);
    expect(await (await ring()).getRecord(REPO)).toEqual(rec);
    expect(writes(sent)).toEqual([]);
  });

  it("forget: refused while the repo has an encryption marker, signed or not", async () => {
    const rec = await learned();
    const unsigned = JSON.stringify({ format: 1, enabled: true, repo_id: "A".repeat(22), key_id: "0123456789abcdef", mac: "0".repeat(64) });
    for (const marker of [unsigned, "not json"]) {
      github({ admin: true }, [fake(REPO, { marker })]);
      if (!jar.has("__Host-keys")) await signIn();
      const page = await (await go(`/keys?repo=${encodeURIComponent(REPO)}`)).text();
      expect(page).not.toContain(FORGET);
      const res = await act("/keys/forget", { repo: REPO });
      const text = await res.text();
      expect(res.status, text).toBe(409);
      expect(text).toContain(`${REPO} still has an encryption marker (.claude-memory/encryption.json)`);
      expect(await (await ring()).getRecord(REPO)).toEqual(rec);
    }
  });

  it("forget: admin only, and only for a repo the memory tool treats as encrypted", async () => {
    const rec = await learned();
    github({ push: true, admin: false }, [fake(REPO)]);
    await signIn();
    const page = await (await go(`/keys?repo=${encodeURIComponent(REPO)}`)).text();
    expect(page).not.toContain(FORGET);
    const res = await act("/keys/forget", { repo: REPO });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(esc(ADMIN_ONLY));
    expect(await (await ring()).getRecord(REPO)).toEqual(rec);
    await (await ring()).deleteRecord(REPO);
    github({ admin: true }, [fake(REPO)]);
    const none = await act("/keys/forget", { repo: REPO });
    expect(none.status).toBe(409);
  });

  /** A fresh move in progress for REPO: key registered, record for the new repo, move flag naming the previous record. */
  const moving = async (prevRecord: { repoId: string; keyId: string; enabled: boolean } | null) => {
    const text = generateKeyText();
    const key = await parseKeyText(text);
    const repoId = newRepoId();
    const r = await ring();
    await r.put(REPO, text, "dav", Date.now());
    await r.putRecord(REPO, { repoId, keyId: key.id, enabled: true, confirmed: true });
    await r.setMove(REPO, { to: NEW, repoId, head: "c-old", prevRecord });
    return { text, key, repoId };
  };

  it("cancel-move: clears the move and drops the record when there was none; saves go through again", async () => {
    await moving(null);
    github({ admin: true }, [fake(REPO)]);
    await signIn();
    const res = await act("/keys/cancel-move", { repo: REPO });
    const text = await res.text();
    expect(res.status, text).toBe(200);
    expect(text).toContain(`You can delete ${NEW}`);
    expect(await (await ring()).getMove(REPO)).toBeNull();
    expect(await (await ring()).getRecord(REPO)).toBeNull();
    const inner = new FakeStore();
    inner.put(REPO, "README.md", "r");
    const s = new EncryptingStore(inner, await ring(), `${BASE}/keys`);
    const T = { scopeLabel: "general", displayLabel: "general", repo: REPO, prefix: "" };
    expect(await saveMemory(s, T, { name: "a", description: "d", type: "user", body: "b\n", force: true }, new Date(), { kind: "general", others: [] }))
      .toMatchObject({ status: "created" });
    expect(isEncryptedFile(inner.repo(REPO).get("memories/a.md")!)).toBe(false);
  });

  it("cancel-move: puts the previous record back", async () => {
    const prev = { repoId: newRepoId(), keyId: "0123456789abcdef", enabled: false };
    await moving(prev);
    github({ admin: true }, [fake(REPO)]);
    await signIn();
    expect((await act("/keys/cancel-move", { repo: REPO })).status).toBe(200);
    expect(await (await ring()).getRecord(REPO)).toEqual(prev);
    expect(await (await ring()).getMove(REPO)).toBeNull();
  });

  it("cancel-move: needs admin, and a move in progress", async () => {
    await moving(null);
    github({ push: true, admin: false }, [fake(REPO)]);
    await signIn();
    const res = await act("/keys/cancel-move", { repo: REPO });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain(esc(ADMIN_ONLY));
    expect(await (await ring()).getMove(REPO)).not.toBeNull();
    await (await ring()).clearMove(REPO);
    github({ admin: true }, [fake(REPO)]);
    expect((await act("/keys/cancel-move", { repo: REPO })).status).toBe(409);
  });

  it("register after the rename (the new repo's signed marker) clears the move", async () => {
    const { text, key, repoId } = await moving(null);
    await (await ring()).remove(REPO); // the key expired before the rename
    const marker = await signMarker(key, { enabled: true, repoId, keyId: key.id });
    github({ push: true, admin: false }, [fake(REPO, { marker: serializeMarker(marker) })]);
    await signIn();
    await env.CACHE_KV.put(`snap:v3:${REPO}:c-old:`, "{}");
    expect((await act("/keys/register", { repo: REPO, key: text })).status).toBe(200);
    expect(await (await ring()).getMove(REPO)).toBeNull();
    expect(await env.CACHE_KV.get(`snap:v3:${REPO}:c-old:`)).toBeNull();
  });

  it("a moving repo: cancel form for admins, the wait-and-reload advice, and the stale warning", () => {
    const status = { encrypted: true, enabled: true, key: "ok" as const, markerProblem: false, sealed: 0, outside: 0, moving: NEW };
    const html = repoSection({ repo: REPO, key: { registeredBy: "dav", expiresAt: null }, admin: true, status }, "c", false);
    expect(html).toMatch(/action="\/keys\/cancel-move"[\s\S]*Cancel the move/);
    expect(html).not.toContain("/keys/stop");
    expect(html).toContain("The encrypted copy is current.");
    expect(html).toMatch(/Wait a minute, then reload this page/);
    expect(html).not.toMatch(/changed after the copy/);
    const stale = repoSection({ repo: REPO, key: null, admin: true, status: { ...status, moveStale: true } }, "c", false);
    expect(stale).toContain(`${esc(REPO)} changed after the copy was written. Don&#39;t delete it: cancel the move and start it again.`);
    expect(stale).not.toContain("The encrypted copy is current.");
    const viewer = repoSection({ repo: REPO, key: null, admin: false, status }, "c", false);
    expect(viewer).not.toContain("/keys/cancel-move");
  });

  it("decrypted outside: the state line and, for admins, the confirm form; viewers get the admin-only text", () => {
    const status = { encrypted: true, enabled: true, key: "ok" as const, markerProblem: false, sealed: 0, outside: 0, decrypted: true };
    const admin = repoSection({ repo: REPO, key: { registeredBy: "dav", expiresAt: null }, admin: true, status }, "c", false);
    expect(admin).toContain("Decrypted outside the memory tool (memcrypt decrypt?). Encryption stays on until an admin confirms.");
    expect(admin).toMatch(/action="\/keys\/confirm-decryption"[\s\S]*name="key"[\s\S]*Confirm decryption \(turn encryption off\)/);
    expect(admin).toContain("/keys/remove");
    expect(admin).not.toContain("marker is missing");
    const viewer = repoSection({ repo: REPO, key: { registeredBy: "dav", expiresAt: null }, admin: false, status }, "c", false);
    expect(viewer).toContain("Decrypted outside the memory tool");
    expect(viewer).not.toContain("Confirm decryption");
    expect(viewer.split(esc(ADMIN_ONLY)).length - 1).toBe(1);
    expect(viewer).toContain("/keys/remove");
    const off = repoSection({ repo: REPO, key: null, admin: true, status: { ...status, key: "missing", decrypted: undefined, markerOff: true } }, "c", false);
    expect(off).toContain("Its encryption marker says off and can't be checked without the key.");
    expect(off).toMatch(/action="\/keys\/confirm-decryption"[\s\S]*name="key"[\s\S]*Confirm decryption \(turn encryption off\)/);
    expect(repoSection({ repo: REPO, key: null, admin: false, status: { ...status, key: "missing", decrypted: undefined, markerOff: true } }, "c", false))
      .not.toContain("Confirm decryption");
  });

  it("the page's forms post to the action routes, with the key for remove and stop", () => {
    const html = repoSection({ repo: REPO, key: { registeredBy: "dav", expiresAt: null }, admin: true,
      status: { encrypted: true, enabled: true, key: "ok", markerProblem: false, sealed: 1, outside: 0 } }, "c", false);
    expect(html).toMatch(/action="\/keys\/remove"[\s\S]*name="key"/);
    expect(html).toMatch(/action="\/keys\/stop"[\s\S]*name="key"/);
    const viewer = repoSection({ repo: REPO, key: null, admin: false, status: null }, "c", false);
    expect(viewer).not.toContain("/keys/turn-on");
    expect(viewer).toContain(esc(ADMIN_ONLY));
  });
});
