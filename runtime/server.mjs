/* ===========================================================================
   In-container job server — the Cloudflare Containers entrypoint (the "hands").
   Replaces the host runner.mjs for production: instead of the host doing
   `docker run` per job, THIS runs inside the sandbox image, listens on a port,
   and on POST /run | /iterate spawns agent.mjs locally (no Docker-in-Docker).
   Per-job params arrive in the request body; model keys + INGEST_BASE come from
   the container's own env (set by the Worker's Container binding from secrets).
   The agent pushes milestones/artifacts to the Worker over the same ingest
   bridge, so the Worker/DO/UI are unchanged. The platform handles start/stop
   (cancel = the DO stops the instance), so there's no /cancel here.
   =========================================================================== */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.env.PORT || 8080);
const AGENT = join(dirname(fileURLToPath(import.meta.url)), "agent.mjs");
const INGEST_BASE = process.env.INGEST_BASE; // public Worker origin (container env)

/** Per-job env for the agent.mjs child: job params over the container's own env
 *  (which carries the model keys + INGEST_BASE). Mirrors runner.mjs's injection. */
function jobEnv(job) {
  // job.modelEnv carries the model keys + ingest origin from the Worker DO
  // (the container's own env doesn't get secrets). Overrides container env.
  const e = { ...process.env, ...(job.modelEnv || {}), RUN_ID: job.runId, INGEST_TOKEN: job.token };
  if (!e.INGEST_BASE) e.INGEST_BASE = INGEST_BASE;
  if (job.url) e.TARGET_URL = job.url;
  if (job.backend) e.MODEL_BACKEND = job.backend;
  if (job.mode) e.MODE = job.mode;
  // Parallel post-run jobs share ONE container here — isolate each job's project
  // tree under its own WORKDIR so they can't clobber /workspace.
  if (job.jobId) e.WORKDIR = `/workspace/jobs/${job.jobId}`;
  if (job.mode === "iterate") {
    e.ITERATE = "1";
    e.INSTRUCTION = job.instruction || "";
    e.VARIANT_ID = job.variantId || "C";
    e.VARIANT_FILE = job.variantFile || "home-C-cinematic.html";
  }
  if (job.mode === "variant") {
    e.INSTRUCTION = job.instruction || "";
    e.VARIANT_NAME = job.variantName || "D";
    e.VARIANT_FILE = job.variantFile || "home-C-cinematic.html";
  }
  if (job.mode === "template") {
    e.VARIANT_ID = job.variantId || "C";
    e.VARIANT_FILE = job.variantFile || "";
    e.INSTRUCTION = job.instruction || "";
    e.SLUG = job.slug || "";
    e.PAGE_URL = job.pageUrl || "";
    e.PAGE_TITLE = job.pageTitle || "";
  }
  return e;
}

/** Backstop for a hard crash the runtime couldn't self-report (it exits 0 when
 *  it does). Mirrors runner.mjs. */
function failureEvent(job, message) {
  if (job.mode === "iterate") return { phase: "iterate", event: "failed", variant: job.variantId, message };
  if (job.mode === "variant") return { phase: "variant", event: "failed", message };
  if (job.mode === "template") return { phase: "template", event: "page_failed", slug: job.slug || "", message };
  return { phase: "failed", message };
}

async function reportFailure(job, message) {
  try {
    await fetch(`${INGEST_BASE}/api/ingest/${job.runId}/event`, {
      method: "POST",
      headers: { authorization: `Bearer ${job.token}`, "content-type": "application/json" },
      body: JSON.stringify(failureEvent(job, message)),
    });
  } catch { /* best effort */ }
}

function runJob(job) {
  const child = spawn("node", [AGENT], { env: jobEnv(job), stdio: "inherit" });
  child.on("exit", (code) => {
    if (code && code !== 0) {
      console.log(`[sandbox] agent exited ${code} for run ${job.runId}`);
      void reportFailure(job, `the runtime exited with code ${code}`);
    }
  });
}

createServer((req, res) => {
  if (req.method === "GET") { res.writeHead(200).end("ok"); return; } // platform health check
  const isRun = req.method === "POST" && req.url === "/run";
  const isIterate = req.method === "POST" && req.url === "/iterate";
  if (!isRun && !isIterate) { res.writeHead(404).end("not found"); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const job = JSON.parse(body || "{}");
      if (isIterate) job.mode = "iterate";
      if (!job.runId || !job.token) throw new Error("runId and token required");
      runJob(job);
      res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
}).listen(PORT, () => console.log(`[sandbox-server] listening on :${PORT}  ingest=${INGEST_BASE}`));
