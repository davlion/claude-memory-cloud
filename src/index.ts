import type { Env } from "./env";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      const probe = url.searchParams.get("probe");
      if (probe) {
        const r = await fetch(probe);
        return Response.json({ probed: r.status });
      }
      return Response.json({ ok: true, version: env.WORKER_VERSION });
    }
    return new Response("not found", { status: 404 });
  },
};
