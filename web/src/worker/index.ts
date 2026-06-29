/* ===========================================================================
   Worker entry — REST + WebSocket routing. /api/* runs the Worker first (see
   wrangler assets.run_worker_first); everything else falls through to the SPA.
   =========================================================================== */
import { RunSession } from "./runSession";
export { RunSession };

export interface Env {
  RUN: DurableObjectNamespace<RunSession>;
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  // Managed Agents (from web/.dev.vars locally / secrets in prod). Optional:
  // when absent, runs fall back to the scripted demo.
  ANTHROPIC_API_KEY?: string;
  STARDUST_AGENT_ID?: string;
  STARDUST_ENVIRONMENT_ID?: string;
}

const WS_PATH = /^\/api\/runs\/([^/]+)\/ws$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // Create a run.
    if (path === "/api/runs" && request.method === "POST") {
      const { url: target, mode } = (await request.json()) as { url?: string; mode?: string };
      if (!target) return Response.json({ error: "url required" }, { status: 400 });
      const runMode = mode === "agent" ? "agent" : mode === "probe" ? "probe" : "scripted";
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO runs (id, url, status, mode, created_at) VALUES (?, ?, 'pending', ?, ?)")
        .bind(id, target, runMode, Date.now())
        .run();
      return Response.json({ id }, { status: 201 });
    }

    // WebSocket: forward to the run's Durable Object (it returns the 101).
    const wsMatch = path.match(WS_PATH);
    if (wsMatch) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const runId = wsMatch[1];
      const stub = env.RUN.get(env.RUN.idFromName(runId));
      return stub.fetch(request);
    }

    // Artifacts: serve from R2. /api/artifacts/<key...>  ->  R2 key artifacts/<key...>
    if (path.startsWith("/api/artifacts/")) {
      const key = "artifacts/" + path.slice("/api/artifacts/".length);
      const object = await env.BUCKET.get(key);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("cache-control", "public, max-age=300");
      return new Response(object.body, { headers });
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
