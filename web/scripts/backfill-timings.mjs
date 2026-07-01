#!/usr/bin/env node
/* ===========================================================================
   Backfill result_json.timings for existing completed runs, so the dynamic ETA
   learner (runSession.learnEta) has seed data from day one. Derives milestone
   elapsed from the stored run_events timeline — no re-run needed.

     node scripts/backfill-timings.mjs            # local D1 (default)
     node scripts/backfill-timings.mjs --remote   # prod D1 (--env production)

   Maps emitted status events → learner labels:
     "brand surface captured"  → brand_ready
     "three directions composed" → variants_ready
     "variant X rendered" (last) → variant_done
     run.done (or MAX ts)        → total
   Merges into result_json (keeps brand/variants/palette); skips runs already
   backfilled or missing key milestones. Idempotent.
   =========================================================================== */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const REMOTE = process.argv.includes("--remote");
const DBFLAGS = REMOTE ? "--remote --env production" : "--local";
const PIPELINE_VERSION = "serial-1";
const MODES = ["bedrock", "uplift", "cerebras", "agent"];

const d1 = (sql) => {
  const out = execSync(
    `npx wrangler d1 execute stardust-web-db ${DBFLAGS} --json --command ${JSON.stringify(sql)}`,
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
  );
  return JSON.parse(out)[0].results;
};

const runs = d1(
  `SELECT id, mode, result_json FROM runs WHERE status='done' AND mode IN (${MODES.map((m) => `'${m}'`).join(",")})`,
);
console.log(`${runs.length} completed real runs`);

const updates = [];
let done = 0, skip = 0;
for (const run of runs) {
  let cur = {};
  try { cur = JSON.parse(run.result_json || "{}"); } catch { /* */ }
  // (Recomputes even if timings exist — deterministic + repairs earlier bad data.)

  const evs = d1(`SELECT ts, payload FROM run_events WHERE run_id='${run.id}' ORDER BY seq`)
    .map((e) => { try { return { ts: e.ts, p: JSON.parse(e.payload) }; } catch { return null; } })
    .filter(Boolean);
  if (!evs.length) { skip++; continue; }
  const start = Math.min(...evs.map((e) => e.ts));
  // Bound by the FIRST run.done — reopens re-emit events with fresh timestamps
  // after completion, which would otherwise push milestones past the end.
  const firstDone = evs.find((e) => e.p.t === "run.done");
  const end = firstDone ? firstDone.ts : Math.max(...evs.map((e) => e.ts));
  const upTo = evs.filter((e) => e.ts <= end);
  const firstTs = (pred) => upTo.find(pred)?.ts ?? 0;
  const brand = firstTs((e) => e.p.t === "status" && e.p.text === "brand surface captured");
  const variants = firstTs((e) => e.p.t === "status" && e.p.text === "three directions composed");
  const variant = firstTs((e) => e.p.t === "status" && /^variant .* rendered$/.test(e.p.text || ""));
  const total = end - start;
  if (total <= 0 || (!brand && !variants)) { skip++; continue; } // not a real uplift shape

  const byLabel = {};
  if (brand) byLabel.brand_ready = brand - start;
  if (variants) byLabel.variants_ready = variants - start;
  if (variant) byLabel.variant_done = variant - start;
  byLabel.done = total;

  const merged = { ...cur, timings: { byLabel, total, pipelineVersion: PIPELINE_VERSION, mode: run.mode } };
  const json = JSON.stringify(merged).replace(/'/g, "''");
  updates.push(`UPDATE runs SET result_json='${json}' WHERE id='${run.id}';`);
  const s = (x) => (x ? `${Math.round((x - start) / 1000)}s` : "—");
  console.log(`  ${run.mode.padEnd(9)} total ${Math.round(total / 1000)}s  brand ${s(brand)} variants ${s(variants)} variant ${s(variant)}`);
  done++;
}

if (updates.length) {
  const f = "/tmp/backfill-timings.sql";
  writeFileSync(f, updates.join("\n"));
  execSync(`npx wrangler d1 execute stardust-web-db ${DBFLAGS} --file ${f}`, { stdio: "inherit" });
}
console.log(`\nbackfilled ${done}, skipped ${skip}`);
