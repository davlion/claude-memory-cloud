import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";
import { s256 } from "../src/github-auth";
import { json, mockFetch } from "./setup";

const BASE = "https://memory.test";
const CB = "https://claude.ai/api/mcp/auth_callback";
const cookieJar = new Map<string, string>();
const storeCookies = (res: Response) => {
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const i = kv!.indexOf("=");
    const [k, v] = [kv!.slice(0, i), kv!.slice(i + 1)];
    cookieJar.set(k!, v ?? "");
  }
};
const cookieHeader = () => [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; ");
const go = async (url: string, init: RequestInit = {}) => {
  const res = await exports.default.fetch(url, { redirect: "manual", ...init, headers: { cookie: cookieHeader(), ...(init.headers ?? {}) } });
  storeCookies(res);
  return res;
};

it("register → consent → GitHub → callback → token → tools/list with props", async () => {
  const reg = await go(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none" }) });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };

  const verifier = "v".repeat(50);
  const authUrl = `${BASE}/authorize?` + new URLSearchParams({
    response_type: "code", client_id, redirect_uri: CB, state: "st", scope: "memory",
    code_challenge: await s256(verifier), code_challenge_method: "S256", resource: `${BASE}/mcp`,
  });
  const page = await go(authUrl);
  expect(page.status).toBe(200);
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1]!;

  const approve = await go(`${BASE}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, decision: "approve" }) });
  expect(approve.status).toBe(302);
  const gh = new URL(approve.headers.get("location")!);
  expect(gh.origin + gh.pathname).toBe("https://github.com/login/oauth/authorize");
  expect(gh.searchParams.get("code_challenge_method")).toBe("S256");
  expect(gh.searchParams.get("redirect_uri")).toBe(`${BASE}/callback`);

  const instAuth: string[] = [];
  mockFetch([
    { method: "POST", url: "https://github.com/login/oauth/access_token", respond: () =>
      json({ access_token: "ghu_live", refresh_token: "ghr_live", expires_in: 28800 }) },
    { url: "https://api.github.com/user/installations?", respond: (req) => {
      instAuth.push(req.headers.get("authorization") ?? "");
      return json({ installations: [] });
    } },
    { url: "https://api.github.com/user", respond: (req) => {
      expect(req.headers.get("authorization")).toBe("Bearer ghu_live");
      return json({ login: "dav", id: 42 });
    } },
  ]);
  const cb = await go(`${BASE}/callback?code=GHCODE&state=${gh.searchParams.get("state")}`);
  expect(cb.status).toBe(302);
  const back = new URL(cb.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(CB);
  expect(back.searchParams.get("state")).toBe("st");

  const tok = await go(`${BASE}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: back.searchParams.get("code")!, redirect_uri: CB,
      client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) });
  expect(tok.status).toBe(200);
  const { access_token } = (await tok.json()) as { access_token: string };

  const call = (body: unknown) => go(`${BASE}/mcp`, { method: "POST", body: JSON.stringify(body), headers: {
    authorization: `Bearer ${access_token}`, "content-type": "application/json",
    accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" } });

  const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  expect(init.status).toBe(200);
  expect(await init.text()).toContain("memory_index");  // instructions mention it

  const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const text = await list.text();
  for (const t of ["memory_scopes", "memory_index", "memory_health", "memory_read", "memory_search", "memory_save", "memory_delete"]) {
    expect(text).toContain(t);
  }

  // props reached the tool: memory_scopes calls GitHub with the user's token
  const scopes = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "memory_scopes", arguments: {} } });
  expect(await scopes.text()).toContain("app_not_installed");
  // ...and the token it used is the one GitHub issued at sign-in
  expect(instAuth.length).toBeGreaterThan(0);
  expect(instAuth.at(-1)).toBe("Bearer ghu_live");
});

it("rejects a disallowed redirect URI before showing consent", async () => {
  const reg = await go(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  const res = await go(`${BASE}/authorize?` + new URLSearchParams({ response_type: "code", client_id, redirect_uri: "https://evil.example/cb",
    state: "s", code_challenge: await s256("x".repeat(50)), code_challenge_method: "S256", resource: `${BASE}/mcp` }));
  expect(res.status).toBe(400);
  expect(await res.text()).toContain("Redirect URI not allowed");
});

it("never redirects to a non-allowlisted URI on an invalid authorize request", async () => {
  const reg = await go(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Evil", redirect_uris: ["https://evil.example/cb"], token_endpoint_auth_method: "none" }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  const res = await go(`${BASE}/authorize?` + new URLSearchParams({ response_type: "bogus", client_id, redirect_uri: "https://evil.example/cb",
    state: "s", code_challenge: await s256("x".repeat(50)), code_challenge_method: "S256", resource: `${BASE}/mcp` }));
  expect(res.status).toBe(400);
  expect(res.headers.get("location")).toBeNull();
});

it("/callback with a non-JSON GitHub token response → 502 page without secrets", async () => {
  const reg = await go(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none" }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  const page = await go(`${BASE}/authorize?` + new URLSearchParams({
    response_type: "code", client_id, redirect_uri: CB, state: "st2", scope: "memory",
    code_challenge: await s256("w".repeat(50)), code_challenge_method: "S256", resource: `${BASE}/mcp` }));
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1]!;
  const approve = await go(`${BASE}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, decision: "approve" }) });
  const gh = new URL(approve.headers.get("location")!);
  mockFetch([{ method: "POST", url: "https://github.com/login/oauth/access_token", respond: () =>
    new Response("<html>Bad Gateway</html>", { status: 200, headers: { "content-type": "text/html" } }) }]);
  const cb = await go(`${BASE}/callback?code=GHCODE&state=${gh.searchParams.get("state")}`);
  expect(cb.status).toBe(502);
  const body = await cb.text();
  expect(body).not.toContain("code=");
  expect(body).not.toMatch(/ghu_|ghr_|GHCODE/);
});

async function startFlow(state: string): Promise<string> {
  const reg = await go(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CB], token_endpoint_auth_method: "none" }) });
  const { client_id } = (await reg.json()) as { client_id: string };
  const page = await go(`${BASE}/authorize?` + new URLSearchParams({
    response_type: "code", client_id, redirect_uri: CB, state, scope: "memory",
    code_challenge: await s256("u".repeat(50)), code_challenge_method: "S256", resource: `${BASE}/mcp` }));
  const handle = /name="handle" value="([^"]+)"/.exec(await page.text())![1]!;
  const approve = await go(`${BASE}/authorize`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ handle, decision: "approve" }) });
  return new URL(approve.headers.get("location")!).searchParams.get("state")!;
}

async function callbackAs(user: { login: string; id: number }, githubState: string): Promise<Response> {
  mockFetch([
    { method: "POST", url: "https://github.com/login/oauth/access_token", respond: () => json({ access_token: "ghu_x", refresh_token: "ghr_x", expires_in: 28800 }) },
    { url: "https://api.github.com/user", respond: () => json(user) },
  ]);
  return go(`${BASE}/callback?code=C&state=${githubState}`);
}

it("refuses a GitHub user who isn't in SCOPES, with a clear page and no redirect", async () => {
  const res = await callbackAs({ login: "mallory", id: 666 }, await startFlow("s-m"));
  expect(res.status).toBe(403);
  expect(res.headers.get("location")).toBeNull();
  const body = await res.text();
  expect(body).toContain("isn't on this memory server");
  expect(body).toContain("mallory");
  expect(body).not.toMatch(/ghu_|ghr_/);
});

it("pins the numeric GitHub ID at first sign-in; another account with that login is refused", async () => {
  expect((await callbackAs({ login: "carol", id: 7 }, await startFlow("s-c1"))).status).toBe(302);
  expect((await callbackAs({ login: "Carol", id: 8 }, await startFlow("s-c2"))).status).toBe(403);
});
