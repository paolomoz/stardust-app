/* ===========================================================================
   Host runner for the open-loop runtime. The Durable Object can't run Docker,
   so this tiny HTTP service does: POST /run {runId, url, token, backend} ->
   spawn a sandbox container whose entrypoint is `node /workspace/runtime/agent.mjs`.
   Mirrors sandbox/spawn.sh, minus Managed Agents. Run it on the host:

     cd app && set -a && . ./.env && set +a && node runtime/runner.mjs

   Reads the model keys from the environment and injects the right ones per
   backend (cerebras|bedrock) into the container.
   =========================================================================== */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.RUNNER_PORT || 8790);
const IMAGE = process.env.IMAGE || "stardust-sandbox";
const OUTPUTS_DIR = resolve(process.env.OUTPUTS_DIR || `${process.cwd()}/sandbox/outputs`);
const INGEST_BASE = process.env.INGEST_BASE || "http://host.docker.internal:5173";
// From the runner (on the host), reach the Worker directly — host.docker.internal
// is a container-only alias. Used to report a hard crash the runtime couldn't.
const SELF_INGEST = process.env.RUNNER_INGEST_BASE || "http://localhost:5173";

// Runs the operator intentionally stopped — their container exit must not be
// reported as a failure.
const canceled = new Set();
// Live container names per run, so cancel can kill every in-flight job (the run
// plus any parallel variant/template jobs).
const running = new Map(); // runId -> Set<containerName>

const containerName = (runId, mode, jobId) =>
  jobId ? `stardust-${runId}-${jobId}` : `stardust-${runId}${mode === "iterate" ? "-iter" : ""}`;

/** The failure event shape for a job that crashed before self-reporting. */
function failureEvent(mode, variantId, slug, message) {
  if (mode === "iterate") return { phase: "iterate", event: "failed", variant: variantId, message };
  if (mode === "variant") return { phase: "variant", event: "failed", message };
  if (mode === "template") return { phase: "template", event: "page_failed", slug: slug || "", message };
  return { phase: "failed", message };
}

async function reportFailure(runId, token, mode, variantId, slug, message) {
  try {
    await fetch(`${SELF_INGEST}/api/ingest/${runId}/event`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(failureEvent(mode, variantId, slug, message)),
    });
  } catch { /* best effort */ }
}

// Per-backend config from the host environment (app/.env).
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || "gemma-4-31b";
const CEREBRAS_BASE_URL = process.env.CEREBRAS_BASE_URL || "";
// Tolerate a Bedrock key pasted as "AWS_BEARER_TOKEN_BEDROCK=ABSK…".
const BEDROCK_API_KEY = (process.env.BEDROCK_API_KEY || "").replace(/^AWS_BEARER_TOKEN_BEDROCK=/, "").trim();
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || "us.anthropic.claude-opus-4-8";
const BEDROCK_REGION = process.env.BEDROCK_REGION || "us-east-1";

/** Env vars injected into the container for the chosen backend. */
function backendEnv(backend) {
  if (backend === "bedrock") {
    if (!BEDROCK_API_KEY) throw new Error("BEDROCK_API_KEY not set on the runner host");
    return {
      MODEL_BACKEND: "bedrock",
      BEDROCK_API_KEY,
      BEDROCK_MODEL,
      BEDROCK_REGION,
      _label: `bedrock ${BEDROCK_MODEL}`,
    };
  }
  if (!CEREBRAS_API_KEY) throw new Error("CEREBRAS_API_KEY not set on the runner host");
  return {
    MODEL_BACKEND: "cerebras",
    CEREBRAS_API_KEY,
    CEREBRAS_MODEL,
    ...(CEREBRAS_BASE_URL ? { CEREBRAS_BASE_URL } : {}),
    _label: `cerebras ${CEREBRAS_MODEL}`,
  };
}

function startContainer({ runId, url, token, backend, mode, jobId, instruction, variantId, variantFile, variantName, slug, pageUrl, pageTitle }) {
  const out = `${OUTPUTS_DIR}/${runId}`;
  // Post-run jobs (variant/template) run in their own isolated workspace so
  // parallel jobs never race on one stardust/ tree; the run + iterate reuse the
  // run's persisted workspace.
  const workDirHost = jobId ? `${OUTPUTS_DIR}/${runId}-${jobId}-workspace` : `${OUTPUTS_DIR}/${runId}-workspace`;
  mkdirSync(out, { recursive: true });
  mkdirSync(workDirHost, { recursive: true });

  // Per-mode env for agent.mjs. MODE selects the branch; ITERATE stays set for
  // iterate (back-compat with the in-container server.mjs path).
  const modeEnv = {};
  if (mode) modeEnv.MODE = mode;
  if (mode === "iterate") { modeEnv.ITERATE = "1"; modeEnv.INSTRUCTION = instruction || ""; modeEnv.VARIANT_ID = variantId || "C"; modeEnv.VARIANT_FILE = variantFile || "home-C-cinematic.html"; }
  if (mode === "variant") { modeEnv.INSTRUCTION = instruction || ""; modeEnv.VARIANT_NAME = variantName || "D"; modeEnv.VARIANT_FILE = variantFile || "home-C-cinematic.html"; }
  if (mode === "template") { modeEnv.VARIANT_ID = variantId || "C"; modeEnv.VARIANT_FILE = variantFile || ""; modeEnv.INSTRUCTION = instruction || ""; modeEnv.SLUG = slug || ""; modeEnv.PAGE_URL = pageUrl || ""; modeEnv.PAGE_TITLE = pageTitle || ""; }

  const be = backendEnv(backend);
  const { _label, ...envVars } = be;
  const envArgs = Object.entries({
    RUN_ID: runId,
    TARGET_URL: url,
    INGEST_TOKEN: token,
    INGEST_BASE,
    OUTPUTS_DIR: "/mnt/session/outputs",
    WORKDIR: "/workspace",
    ...modeEnv,
    ...envVars,
  }).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

  const name = containerName(runId, mode, jobId);
  const args = [
    "run", "--rm", "--name", name,
    ...envArgs,
    "-v", `${out}:/mnt/session/outputs`,
    "-v", `${workDirHost}:/workspace/stardust`,
    "--entrypoint", "node",
    IMAGE, "/workspace/runtime/agent.mjs",
  ];
  canceled.delete(runId);
  if (!running.has(runId)) running.set(runId, new Set());
  running.get(runId).add(name);
  const child = spawn("docker", args, { stdio: "inherit" });
  child.on("exit", (code) => {
    running.get(runId)?.delete(name);
    // Backstop: report a crash the runtime couldn't (OOM / hard kill). Skip
    // intentional cancels and clean exits.
    if (canceled.has(runId)) return;
    if (code && code !== 0) {
      console.log(`[runner] job ${name} exited ${code} — reporting failure`);
      void reportFailure(runId, token, mode, variantId, slug, `the runtime exited with code ${code}`);
    }
  });
  child.unref();
  const label = mode === "iterate" ? `iterate(${variantId}: ${instruction})`
    : mode === "variant" ? `variant ${variantName}: ${instruction}`
    : mode === "template" ? `template ${slug || instruction} (variant ${variantId})`
    : "container";
  console.log(`[runner] spawned [${_label}] ${label} for run ${runId} (${url || ""})`);
}

function cancelRun(runId) {
  canceled.add(runId);
  const names = new Set(running.get(runId) ?? []);
  // Also cover the legacy names in case tracking missed one.
  names.add(containerName(runId));
  names.add(containerName(runId, "iterate"));
  for (const name of names) {
    const child = spawn("docker", ["kill", name], { stdio: "ignore" });
    child.on("error", () => {});
  }
  running.delete(runId);
  console.log(`[runner] cancel requested for run ${runId}`);
}

createServer((req, res) => {
  const isRun = req.method === "POST" && req.url?.endsWith("/run");
  const isCancel = req.method === "POST" && req.url?.endsWith("/cancel");
  if (!isRun && !isCancel) {
    res.writeHead(404).end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const job = JSON.parse(body || "{}");
      const { runId, token } = job;
      if (!runId) throw new Error("runId required");
      if (isCancel) {
        cancelRun(runId);
      } else {
        if (!token) throw new Error("token required");
        startContainer({ ...job, url: job.url || "", backend: job.backend || "bedrock" });
      }
      res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
}).listen(PORT, () => console.log(`[runner] listening on http://localhost:${PORT}  image=${IMAGE} outputs=${OUTPUTS_DIR}  backends=${[CEREBRAS_API_KEY && "cerebras", BEDROCK_API_KEY && "bedrock"].filter(Boolean).join(",")}`));
