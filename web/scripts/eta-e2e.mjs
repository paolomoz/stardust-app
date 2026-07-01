#!/usr/bin/env node
/* Zero-cost E2E for the dynamic ETA: creates an inert running bedrock run in the
   dev worker's local D1, backdates its start ~700s, POSTs the milestone stream to
   the ingest endpoint, then prints every emitted `eta` event. No paid model run.

     node scripts/eta-e2e.mjs [baseUrl]   (default http://localhost:5173)   */
import { execSync } from "node:child_process";

const BASE = (process.argv[2] || "http://localhost:5173").replace(/\/$/, "");
const id = "eta-e2e-" + Math.random().toString(36).slice(2, 8);
const token = "tok-" + Math.random().toString(36).slice(2, 10);
const now = Date.now();
const start = now - 700_000; // simulate ~700s elapsed at ingest time

const sql = (s) => execSync(
  `npx wrangler d1 execute stardust-web-db --local --command ${JSON.stringify(s)}`,
  { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 },
);
const query = (s) => { // --json read → rows
  const out = execSync(`npx wrangler d1 execute stardust-web-db --local --json --command ${JSON.stringify(s)}`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 32 * 1024 * 1024 });
  try { return JSON.parse(out)[0].results; } catch { return []; }
};

// Inert run + a backdated run.started event (MIN(ts) = the DO's startTs anchor).
sql(`INSERT INTO runs (id, url, mode, status, ingest_token, created_at) VALUES ('${id}','https://www.example.com/','bedrock','running','${token}',${now});`);
sql(`INSERT INTO run_events (run_id, seq, payload, ts) VALUES ('${id}', 0, '${JSON.stringify({ t: "run.started", runId: id }).replace(/'/g, "''")}', ${start});`);
console.log(`run ${id}  (start backdated ${(now - start) / 1000}s)`);

const post = async (ev) => {
  const r = await fetch(`${BASE}/api/ingest/${id}/event`, {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(ev),
  });
  if (!r.ok) throw new Error(`ingest ${r.status}: ${await r.text()}`);
};

await post({ phase: "extract", event: "brand_ready", brandReview: "brand-review.html", palette: ["#0094d4"] });
await post({ phase: "direct", event: "variants_ready", sharedFixes: ["x"], variants: [{ id: "A", title: "A", pitch: "p", role: "r", file: "home-A-proposed.html" }, { id: "B", title: "B", pitch: "p", role: "r", file: "home-B-proposed.html" }, { id: "C", title: "C", pitch: "p", role: "r", file: "home-C-proposed.html" }] });
await post({ phase: "prototype", event: "variant_done", variant: "A" });
await post({ phase: "prototype", event: "variant_done", variant: "B" });
await post({ phase: "prototype", event: "variant_done", variant: "C" });
await post({ phase: "done" });

// Read back every eta event + what the client would render right after receipt.
console.log("\nemitted eta events (seconds = TOTAL, anchored at startedAt):");
for (const row of query(`SELECT payload FROM run_events WHERE run_id='${id}' AND payload LIKE '%"eta"%' ORDER BY seq`)) {
  let p; try { p = JSON.parse(row.payload); } catch { continue; }
  if (p.t !== "eta") continue;
  const elapsed = p.startedAt ? (Date.now() - p.startedAt) / 1000 : 0;
  console.log(`  total=${p.seconds}s (${(p.seconds / 60).toFixed(1)}m)  startedAt=${p.startedAt ? "yes" : "MISSING"}  → remain ~${Math.round(p.seconds - elapsed)}s, bar ${Math.round(Math.min(95, elapsed / p.seconds * 100))}%`);
}
const tr = query(`SELECT result_json FROM runs WHERE id='${id}'`)[0];
if (tr?.result_json) { try { console.log("\npersisted timings:", JSON.stringify(JSON.parse(tr.result_json).timings)); } catch { /* */ } }
// cleanup
sql(`DELETE FROM run_events WHERE run_id='${id}'; DELETE FROM runs WHERE id='${id}';`);
console.log("\n(cleaned up test run)");
