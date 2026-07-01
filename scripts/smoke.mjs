#!/usr/bin/env node
/* ===========================================================================
   Post-deploy smoke test — run after every prod (or local) deploy.

     node scripts/smoke.mjs [baseUrl] [runId]

   baseUrl  default https://stardust-web-production.paolo-moz.workers.dev
   runId    optional — a VIEWABLE run (legacy/null-owner) to exercise the
            owner-gated Tier 2 checks (suggest via Bedrock + WS panel push).
            Without it, only Tier 1 (public) runs.

   Dependency-free (Node 22 globals: fetch + WebSocket). Exits non-zero on any
   failure, so it can gate a deploy / CI. Mirrors DEPLOY.md's checklist.
   =========================================================================== */
const BASE = (process.argv[2] || "https://stardust-web-production.paolo-moz.workers.dev").replace(/\/$/, "");
const RUN = process.argv[3] || process.env.SMOKE_RUN_ID || "";

let pass = 0, fail = 0;
const ok = (n) => { console.log(`  \x1b[32m✓\x1b[0m ${n}`); pass++; };
const bad = (n, d) => { console.log(`  \x1b[31m✗\x1b[0m ${n}${d ? ` — ${d}` : ""}`); fail++; };
async function check(name, fn) {
  try { const r = await fn(); if (r === true) ok(name); else bad(name, typeof r === "string" ? r : "assertion failed"); }
  catch (e) { bad(name, String(e?.message || e)); }
}

async function tier1() {
  console.log("\nTier 1 — public");
  await check("GET / → 200", async () => { const r = await fetch(BASE + "/"); return r.status === 200 || `status ${r.status}`; });
  await check("GET /api/me → 200 + {user}", async () => {
    const r = await fetch(BASE + "/api/me"); if (r.status !== 200) return `status ${r.status}`;
    const j = await r.json(); return ("user" in j) || "missing user field";
  });
  await check("GET /auth/google → 302 to Google w/ client_id", async () => {
    const r = await fetch(BASE + "/auth/google", { redirect: "manual" });
    const loc = r.headers.get("location") || "";
    return (r.status === 302 && loc.includes("accounts.google.com") && loc.includes("client_id=")) || `status ${r.status} loc ${loc.slice(0, 50)}`;
  });
  await check("GET /auth/github → 302 to GitHub", async () => {
    const r = await fetch(BASE + "/auth/github", { redirect: "manual" });
    const loc = r.headers.get("location") || "";
    return (r.status === 302 && loc.includes("github.com/login/oauth")) || `status ${r.status}`;
  });
  await check("GET /api/_dev/login → 404 (no backdoor)", async () => {
    const r = await fetch(BASE + "/api/_dev/login", { redirect: "manual" });
    return r.status === 404 || `status ${r.status} (dev-login must not exist in prod)`;
  });
  await check("demo asset home-C → 200 html", async () => {
    const r = await fetch(BASE + "/knack-demo/home-C-cinematic.html"); // follows the .html→ext-less 307
    return (r.status === 200 && (r.headers.get("content-type") || "").includes("html")) || `status ${r.status}`;
  });
  await check("demo asset thumb-C → 200 image", async () => {
    const r = await fetch(BASE + "/knack-demo/assets/thumb-C.png");
    return (r.status === 200 && (r.headers.get("content-type") || "").includes("image")) || `status ${r.status}`;
  });
}

async function tier2() {
  if (!RUN) { console.log("\nTier 2 — skipped (pass a viewable runId to exercise suggest + WS)"); return; }
  console.log(`\nTier 2 — owner-gated (run ${RUN.slice(0, 8)}, must be viewable)`);
  await check("suggest → non-empty (Bedrock Haiku reachable)", async () => {
    const r = await fetch(`${BASE}/api/runs/${RUN}/suggest?screen=workspace`);
    if (r.status !== 200) return `status ${r.status}`;
    const j = await r.json();
    return (Array.isArray(j.suggestions) && j.suggestions.length > 0) || "empty — run not viewable or model unreachable";
  });
  await check("WS reopen → panel.variants pushed", async () => {
    const wsUrl = BASE.replace(/^http/, "ws") + `/api/runs/${RUN}/ws`;
    return await new Promise((res) => {
      let seen = false;
      let ws;
      try { ws = new WebSocket(wsUrl); } catch (e) { return res(`ws open failed: ${e}`); }
      const done = (v) => { try { ws.close(); } catch { /* */ } res(v); };
      const t = setTimeout(() => done(seen || "no panel.variants within 6s"), 6000);
      ws.onmessage = (e) => { try { if (JSON.parse(e.data).t === "panel.variants") { seen = true; clearTimeout(t); done(true); } } catch { /* */ } };
      ws.onerror = () => { clearTimeout(t); done("ws error"); };
    });
  });
}

console.log(`smoke → ${BASE}`);
await tier1();
await tier2();
console.log(`\n${fail ? "\x1b[31m✗ FAIL\x1b[0m" : "\x1b[32m✓ PASS\x1b[0m"}  (${pass} passed, ${fail} failed)`);
process.exit(fail ? 1 : 0);
