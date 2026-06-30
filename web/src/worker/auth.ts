/* ===========================================================================
   Auth — Google + GitHub OAuth, hand-rolled for the Worker (no dependency).
   Google uses PKCE (S256) + state; GitHub uses state. Sessions are opaque ids
   stored in D1 (sessions table) and carried in an HttpOnly cookie. Identity is
   linked by verified email (users.id = lowercased email), so logging in with
   either provider lands in the same account.
   =========================================================================== */
import type { Env } from "./index";

const SESSION_COOKIE = "sd_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const STATE_COOKIE = "sd_oauth"; // short-lived {state, verifier, provider}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatar: string;
  providers: string[];
}

/* ---- small helpers ---- */

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function randB64url(n: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}
async function sha256B64url(s: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}
function parseCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = request.headers.get("cookie") ?? "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function cookie(name: string, value: string, opts: { maxAge?: number; secure: boolean }): string {
  let c = `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax`;
  if (opts.maxAge !== undefined) c += `; Max-Age=${opts.maxAge}`;
  if (opts.secure) c += "; Secure";
  return c;
}
const isSecure = (url: URL) => url.protocol === "https:";

/* ---- provider config ---- */

type Provider = "google" | "github";

function githubCreds(env: Env, url: URL): { id?: string; secret?: string } {
  const dev = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  return dev
    ? { id: env.GITHUB_CLIENT_ID_DEV, secret: env.GITHUB_CLIENT_SECRET_DEV }
    : { id: env.GITHUB_CLIENT_ID_PROD, secret: env.GITHUB_CLIENT_SECRET_PROD };
}
const redirectUri = (url: URL, p: Provider) => `${url.origin}/auth/${p}/callback`;

/* ---- start: redirect to the provider ---- */

export async function startOAuth(provider: Provider, request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = randB64url(16);
  let authorize: URL;
  let verifier = "";

  if (provider === "google") {
    if (!env.GOOGLE_CLIENT_ID) return new Response("Google login not configured", { status: 500 });
    verifier = randB64url(32);
    authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
    authorize.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
    authorize.searchParams.set("redirect_uri", redirectUri(url, "google"));
    authorize.searchParams.set("response_type", "code");
    authorize.searchParams.set("scope", "openid email profile");
    authorize.searchParams.set("state", state);
    authorize.searchParams.set("code_challenge", await sha256B64url(verifier));
    authorize.searchParams.set("code_challenge_method", "S256");
    authorize.searchParams.set("prompt", "select_account");
  } else {
    const { id } = githubCreds(env, url);
    if (!id) return new Response("GitHub login not configured", { status: 500 });
    authorize = new URL("https://github.com/login/oauth/authorize");
    authorize.searchParams.set("client_id", id);
    authorize.searchParams.set("redirect_uri", redirectUri(url, "github"));
    authorize.searchParams.set("scope", "read:user user:email");
    authorize.searchParams.set("state", state);
  }

  const payload = JSON.stringify({ state, verifier, provider });
  const headers = new Headers({ Location: authorize.toString() });
  headers.append("Set-Cookie", cookie(STATE_COOKIE, payload, { maxAge: 600, secure: isSecure(url) }));
  return new Response(null, { status: 302, headers });
}

/* ---- callback: exchange code, upsert user, create session ---- */

export async function handleCallback(provider: Provider, request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const saved = (() => {
    try { return JSON.parse(parseCookies(request)[STATE_COOKIE] ?? "{}"); } catch { return {}; }
  })() as { state?: string; verifier?: string; provider?: string };

  const fail = (msg: string) => {
    const h = new Headers({ Location: `/?auth_error=${encodeURIComponent(msg)}` });
    h.append("Set-Cookie", cookie(STATE_COOKIE, "", { maxAge: 0, secure: isSecure(url) }));
    return new Response(null, { status: 302, headers: h });
  };

  if (!code || !state || state !== saved.state || saved.provider !== provider) return fail("bad_state");

  let profile: { email: string; name: string; avatar: string } | null = null;
  try {
    if (provider === "google") {
      const tok = await fetchJson("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET!,
          redirect_uri: redirectUri(url, "google"), grant_type: "authorization_code", code_verifier: saved.verifier ?? "",
        }),
      });
      const info = await fetchJson("https://openidconnect.googleapis.com/v1/userinfo", {
        headers: { authorization: `Bearer ${tok.access_token}` },
      });
      if (!info.email || info.email_verified === false) return fail("no_verified_email");
      profile = { email: info.email, name: info.name ?? info.email, avatar: info.picture ?? "" };
    } else {
      const { id, secret } = githubCreds(env, url);
      const tok = await fetchJson("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({ code, client_id: id!, client_secret: secret!, redirect_uri: redirectUri(url, "github") }),
      });
      const gh = { authorization: `Bearer ${tok.access_token}`, "user-agent": "stardust", accept: "application/vnd.github+json" };
      const user = await fetchJson("https://api.github.com/user", { headers: gh });
      const emails = (await fetchJson("https://api.github.com/user/emails", { headers: gh })) as { email: string; primary: boolean; verified: boolean }[];
      const primary = Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified) : null;
      if (!primary?.email) return fail("no_verified_email");
      profile = { email: primary.email, name: user.name ?? user.login ?? primary.email, avatar: user.avatar_url ?? "" };
    }
  } catch {
    return fail("oauth_failed");
  }

  const userId = await upsertUser(env, provider, profile);
  const sid = randB64url(32);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(sid, userId, now + SESSION_TTL_MS, now)
    .run();

  const h = new Headers({ Location: "/" });
  h.append("Set-Cookie", cookie(STATE_COOKIE, "", { maxAge: 0, secure: isSecure(url) }));
  h.append("Set-Cookie", cookie(SESSION_COOKIE, sid, { maxAge: SESSION_TTL_MS / 1000, secure: isSecure(url) }));
  return new Response(null, { status: 302, headers: h });
}

async function fetchJson(input: string, init?: RequestInit): Promise<any> {
  const r = await fetch(input, init);
  if (!r.ok) throw new Error(`${input} ${r.status}`);
  return r.json();
}

async function upsertUser(env: Env, provider: Provider, p: { email: string; name: string; avatar: string }): Promise<string> {
  const id = p.email.toLowerCase();
  const existing = await env.DB.prepare("SELECT providers FROM users WHERE id = ?").bind(id).first<{ providers: string | null }>();
  if (existing) {
    let provs: string[] = [];
    try { provs = JSON.parse(existing.providers ?? "[]"); } catch { /* ignore */ }
    if (!provs.includes(provider)) provs.push(provider);
    await env.DB.prepare("UPDATE users SET name = ?, avatar = ?, providers = ? WHERE id = ?")
      .bind(p.name, p.avatar, JSON.stringify(provs), id).run();
  } else {
    await env.DB.prepare("INSERT INTO users (id, email, name, avatar, providers, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, p.email, p.name, p.avatar, JSON.stringify([provider]), Date.now()).run();
  }
  return id;
}

/* ---- session verification + logout ---- */

export async function getSessionUser(request: Request, env: Env): Promise<SessionUser | null> {
  const sid = parseCookies(request)[SESSION_COOKIE];
  if (!sid) return null;
  const row = await env.DB.prepare(
    "SELECT u.id, u.email, u.name, u.avatar, u.providers FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?",
  ).bind(sid, Date.now()).first<{ id: string; email: string; name: string; avatar: string; providers: string | null }>();
  if (!row) return null;
  let providers: string[] = [];
  try { providers = JSON.parse(row.providers ?? "[]"); } catch { /* ignore */ }
  return { id: row.id, email: row.email, name: row.name, avatar: row.avatar, providers };
}

/** DEV ONLY — localhost-gated session for local UI iteration. Returns 404 on any
 *  non-localhost host, so it can never establish a session in production. Remove
 *  (or leave; it's inert in prod) when shipping. */
export async function devLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") return new Response("not found", { status: 404 });
  const id = "dev@localhost";
  const existing = await env.DB.prepare("SELECT id FROM users WHERE id = ?").bind(id).first();
  if (!existing) {
    await env.DB.prepare("INSERT INTO users (id, email, name, avatar, providers, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, id, "Dev", "", JSON.stringify(["dev"]), Date.now()).run();
  }
  const sid = randB64url(32);
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(sid, id, now + SESSION_TTL_MS, now).run();
  const h = new Headers({ Location: "/" });
  h.append("Set-Cookie", cookie(SESSION_COOKIE, sid, { maxAge: SESSION_TTL_MS / 1000, secure: false }));
  return new Response(null, { status: 302, headers: h });
}

export async function logout(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const sid = parseCookies(request)[SESSION_COOKIE];
  if (sid) await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
  const h = new Headers();
  h.append("Set-Cookie", cookie(SESSION_COOKIE, "", { maxAge: 0, secure: isSecure(url) }));
  return Response.json({ ok: true }, { headers: h });
}
