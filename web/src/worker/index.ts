/* ===========================================================================
   Worker entry — REST + WebSocket routing. /api/* runs the Worker first (see
   wrangler assets.run_worker_first); everything else falls through to the SPA.
   =========================================================================== */
import { RunSession } from "./runSession";
import { startOAuth, handleCallback, getSessionUser, logout } from "./auth";
export { RunSession };

export interface Env {
  RUN: DurableObjectNamespace<RunSession>;
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  // OAuth (web/.dev.vars locally / wrangler secrets in prod). Google = one client
  // (both redirect URIs); GitHub = separate dev/prod apps (one callback each).
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GITHUB_CLIENT_ID_DEV?: string;
  GITHUB_CLIENT_SECRET_DEV?: string;
  GITHUB_CLIENT_ID_PROD?: string;
  GITHUB_CLIENT_SECRET_PROD?: string;
  // Managed Agents (from web/.dev.vars locally / secrets in prod). Optional:
  // when absent, runs fall back to the scripted demo.
  ANTHROPIC_API_KEY?: string;
  STARDUST_AGENT_ID?: string;
  STARDUST_ENVIRONMENT_ID?: string;
  // Base URL the sandbox container uses to reach this Worker's ingest endpoints.
  // Local dev (Docker Desktop): http://host.docker.internal:5174. Prod: the
  // public Worker origin.
  INGEST_BASE?: string;
  // Host runner that docker-runs the Cerebras/Gemma runtime (mode "cerebras").
  RUNNER_URL?: string;
}

const WS_PATH = /^\/api\/runs\/([^/]+)\/ws$/;
const INGEST_EVENT = /^\/api\/ingest\/([^/]+)\/event$/;
const INGEST_ARTIFACT = /^\/api\/ingest\/([^/]+)\/artifact\/(.+)$/;

/** Authorize an ingest call against the run's per-run token (stored in D1). */
async function ingestAuthed(env: Env, runId: string, request: Request): Promise<boolean> {
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!bearer) return false;
  const row = await env.DB.prepare("SELECT ingest_token FROM runs WHERE id = ?")
    .bind(runId)
    .first<{ ingest_token: string | null }>();
  return !!row?.ingest_token && row.ingest_token === bearer;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // ---- Auth ----
    if (path === "/auth/google") return startOAuth("google", request, env);
    if (path === "/auth/github") return startOAuth("github", request, env);
    if (path === "/auth/google/callback") return handleCallback("google", request, env);
    if (path === "/auth/github/callback") return handleCallback("github", request, env);
    if (path === "/auth/logout" && request.method === "POST") return logout(request, env);
    if (path === "/api/me") {
      const user = await getSessionUser(request, env);
      return Response.json({ user });
    }

    // Create a run (requires a signed-in user; the run is owned by them).
    if (path === "/api/runs" && request.method === "POST") {
      const user = await getSessionUser(request, env);
      if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
      const { url: target, mode } = (await request.json()) as { url?: string; mode?: string };
      if (!target) return Response.json({ error: "url required" }, { status: 400 });
      const runMode =
        mode === "cerebras" ? "cerebras"
        : mode === "bedrock" ? "bedrock"
        : mode === "uplift" ? "uplift"
        : mode === "agent" ? "agent"
        : mode === "probe" ? "probe"
        : "scripted";
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO runs (id, url, status, mode, user_id, created_at) VALUES (?, ?, 'pending', ?, ?, ?)")
        .bind(id, target, runMode, user.id, Date.now())
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

    // Ingest: the sandbox agent pushes a milestone event. -> the run's DO.
    const evMatch = path.match(INGEST_EVENT);
    if (evMatch && request.method === "POST") {
      const runId = evMatch[1];
      if (!(await ingestAuthed(env, runId, request))) return new Response("Unauthorized", { status: 401 });
      let ev: unknown;
      try {
        ev = await request.json();
      } catch {
        return Response.json({ error: "invalid json" }, { status: 400 });
      }
      const stub = env.RUN.get(env.RUN.idFromName(runId));
      await stub.ingestEvent(runId, ev);
      return Response.json({ ok: true });
    }

    // Ingest: the sandbox agent uploads a deliverable. -> R2 + notify the DO.
    const artMatch = path.match(INGEST_ARTIFACT);
    if (artMatch && (request.method === "PUT" || request.method === "POST")) {
      const runId = artMatch[1];
      const rel = artMatch[2];
      if (!(await ingestAuthed(env, runId, request))) return new Response("Unauthorized", { status: 401 });
      const key = `artifacts/${runId}/${rel}`;
      const contentType = request.headers.get("content-type") ?? "application/octet-stream";
      await env.BUCKET.put(key, request.body, { httpMetadata: { contentType } });
      const stub = env.RUN.get(env.RUN.idFromName(runId));
      await stub.ingestArtifact(runId, rel, contentType);
      return Response.json({ ok: true, key });
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
