import { afterEach, vi } from "vitest";

export type Route = {
  method?: string;
  /** Matched against the full URL with startsWith, or a RegExp. */
  url: string | RegExp;
  respond: (req: Request) => Response | Promise<Response>;
};

/** Intercepts global fetch (including from Worker code in the same isolate). Unmatched requests throw. */
export function mockFetch(routes: Route[]) {
  const calls: Request[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    calls.push(req.clone());
    // A matching regex route wins; otherwise the longest matching string prefix wins.
    // Route order therefore doesn't matter, and a bare repo URL never shadows its sub-paths.
    const matching = routes.filter(
      (r) =>
        (!r.method || r.method === req.method) &&
        (typeof r.url === "string" ? req.url.startsWith(r.url) : r.url.test(req.url)),
    );
    const route = matching.find((r) => typeof r.url !== "string")
      ?? matching.sort((a, b) => (b.url as string).length - (a.url as string).length)[0];
    if (!route) throw new Error(`unmocked fetch: ${req.method} ${req.url}`);
    return route.respond(req);
  });
  return { calls, spy };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => vi.restoreAllMocks());
