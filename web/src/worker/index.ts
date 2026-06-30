/* ===========================================================================
   Worker entry — REST + WebSocket routing. /api/* runs the Worker first (see
   wrangler assets.run_worker_first); everything else falls through to the SPA.
   =========================================================================== */
import { RunSession } from "./runSession";
import { SandboxContainer } from "./sandbox";
import { startOAuth, handleCallback, getSessionUser, logout } from "./auth";
export { RunSession, SandboxContainer };

export interface Env {
  RUN: DurableObjectNamespace<RunSession>;
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS: Fetcher;
  // The "hands" on Cloudflare Containers (prod). Absent locally → host runner.
  SANDBOX?: DurableObjectNamespace<SandboxContainer>;
  PUBLIC_ORIGIN?: string;       // public Worker origin the container posts ingest to
  // Model keys (Worker secrets in prod) — injected into the container by SandboxContainer.
  BEDROCK_API_KEY?: string;
  BEDROCK_MODEL?: string;
  BEDROCK_REGION?: string;
  CEREBRAS_API_KEY?: string;
  CEREBRAS_MODEL?: string;
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
const PUBLISH = /^\/api\/runs\/([^/]+)\/publish$/;
const UNPUBLISH = /^\/api\/runs\/([^/]+)\/unpublish$/;
const PUBLISHED = /^\/api\/runs\/([^/]+)\/published$/;
const PUBLIC = /^\/p\/([^/]+)$/;

/** Owner gate for viewing a run / its artifacts. Legacy runs with no owner
 *  (created before auth) stay viewable so old test runs keep working. Returns
 *  true if access is allowed. (Public-publish bypass arrives in point C.) */
async function canViewRun(env: Env, runId: string, request: Request): Promise<boolean> {
  const row = await env.DB.prepare("SELECT user_id FROM runs WHERE id = ?")
    .bind(runId).first<{ user_id: string | null }>();
  if (!row) return false;
  if (!row.user_id) return true; // legacy / unowned
  const user = await getSessionUser(request, env);
  return !!user && user.id === row.user_id;
}

/** Owner of a run, or null. */
async function runOwner(env: Env, runId: string): Promise<string | null | undefined> {
  const row = await env.DB.prepare("SELECT user_id FROM runs WHERE id = ?").bind(runId).first<{ user_id: string | null }>();
  return row ? row.user_id : undefined; // undefined = no such run
}

/** Can this request serve a specific artifact? Owner or legacy always; otherwise
 *  only if it's a published page, or a shared asset of a run that has a published
 *  artifact (so public pages render with their images/fonts). */
async function canViewArtifact(env: Env, runId: string, artPath: string, request: Request): Promise<boolean> {
  const owner = await runOwner(env, runId);
  if (owner === undefined) return false; // no such run
  if (owner === null) return true; // legacy / unowned
  const user = await getSessionUser(request, env);
  if (user && user.id === owner) return true;
  if (artPath.startsWith("assets/")) {
    return !!(await env.DB.prepare("SELECT 1 FROM published WHERE run_id = ? LIMIT 1").bind(runId).first());
  }
  return !!(await env.DB.prepare("SELECT 1 FROM published WHERE run_id = ? AND path = ?").bind(runId, artPath).first());
}

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

    // List the signed-in user's runs (newest first) for the "Your runs" panel.
    if (path === "/api/runs" && request.method === "GET") {
      const user = await getSessionUser(request, env);
      if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
      const { results } = await env.DB.prepare(
        "SELECT id, url, status, mode, project, created_at FROM runs WHERE user_id = ? ORDER BY created_at DESC LIMIT 50",
      ).bind(user.id).all();
      return Response.json({ runs: results ?? [] });
    }

    // Publish an artifact → a public /p/<token> link (owner only).
    const pubM = path.match(PUBLISH);
    if (pubM && request.method === "POST") {
      const runId = pubM[1];
      const user = await getSessionUser(request, env);
      if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
      if ((await runOwner(env, runId)) !== user.id) return Response.json({ error: "forbidden" }, { status: 403 });
      const { path: artPath, title } = (await request.json()) as { path?: string; title?: string };
      if (!artPath) return Response.json({ error: "path required" }, { status: 400 });
      const existing = await env.DB.prepare("SELECT token FROM published WHERE run_id = ? AND path = ?").bind(runId, artPath).first<{ token: string }>();
      let token = existing?.token;
      if (!token) {
        token = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
        await env.DB.prepare("INSERT INTO published (token, run_id, path, user_id, title, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .bind(token, runId, artPath, user.id, title ?? null, Date.now()).run();
      }
      return Response.json({ token, url: `/p/${token}` });
    }

    // Unpublish an artifact (owner only).
    const unpubM = path.match(UNPUBLISH);
    if (unpubM && request.method === "POST") {
      const runId = unpubM[1];
      const user = await getSessionUser(request, env);
      if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
      if ((await runOwner(env, runId)) !== user.id) return Response.json({ error: "forbidden" }, { status: 403 });
      const { path: artPath } = (await request.json()) as { path?: string };
      await env.DB.prepare("DELETE FROM published WHERE run_id = ? AND path = ?").bind(runId, artPath ?? "").run();
      return Response.json({ ok: true });
    }

    // List a run's published artifacts (owner only) — drives the workspace UI.
    const publishedM = path.match(PUBLISHED);
    if (publishedM && request.method === "GET") {
      const runId = publishedM[1];
      const user = await getSessionUser(request, env);
      if (!user || (await runOwner(env, runId)) !== user.id) return Response.json({ published: [] });
      const { results } = await env.DB.prepare("SELECT token, path, title FROM published WHERE run_id = ?").bind(runId).all();
      return Response.json({ published: results ?? [] });
    }

    // Public link: /p/<token> → redirect to the (now public) artifact.
    const pM = path.match(PUBLIC);
    if (pM) {
      const row = await env.DB.prepare("SELECT run_id, path FROM published WHERE token = ?").bind(pM[1]).first<{ run_id: string; path: string }>();
      if (!row) return new Response("Not found", { status: 404 });
      return Response.redirect(`${url.origin}/api/artifacts/${row.run_id}/${row.path}`, 302);
    }

    // Create a run (requires a signed-in user; the run is owned by them).
    if (path === "/api/runs" && request.method === "POST") {
      const user = await getSessionUser(request, env);
      if (!user) return Response.json({ error: "unauthenticated" }, { status: 401 });
      const { url: target, mode } = (await request.json()) as { url?: string; mode?: string };
      if (!target) return Response.json({ error: "url required" }, { status: 400 });
      const runMode =
        mode === "demo" || mode === "scripted" ? "scripted"
        : mode === "cerebras" ? "cerebras"
        : mode === "uplift" ? "uplift"
        : mode === "agent" ? "agent"
        : mode === "probe" ? "probe"
        : "bedrock"; // default = real Opus-on-Bedrock run
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
      if (!(await canViewRun(env, runId, request))) return new Response("Forbidden", { status: 403 });
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
    // Token-authed download (the iterate container restores run inputs from R2).
    if (artMatch && request.method === "GET") {
      const runId = artMatch[1];
      if (!(await ingestAuthed(env, runId, request))) return new Response("Unauthorized", { status: 401 });
      const object = await env.BUCKET.get(`artifacts/${runId}/${artMatch[2]}`);
      if (!object) return new Response("Not found", { status: 404 });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      return new Response(object.body, { headers });
    }
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

    // Artifacts: serve from R2 (owner-gated). /api/artifacts/<runId>/<path...>
    if (path.startsWith("/api/artifacts/")) {
      const rest = path.slice("/api/artifacts/".length);
      const runId = rest.split("/")[0];
      const artPath = rest.slice(runId.length + 1);
      if (!(await canViewArtifact(env, runId, artPath, request))) return new Response("Forbidden", { status: 403 });
      const key = "artifacts/" + rest;
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
