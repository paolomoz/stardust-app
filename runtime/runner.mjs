/* ===========================================================================
   Host runner for the Cerebras/Gemma path. The Durable Object can't run Docker,
   so this tiny HTTP service does: POST /run {runId, url, token} -> spawn a
   sandbox container whose entrypoint is `node /workspace/runtime/agent.mjs`.
   Mirrors sandbox/spawn.sh, minus Managed Agents. Run it on the host:

     cd app && set -a && . ./.env && set +a && node runtime/runner.mjs

   Reads CEREBRAS_API_KEY from the environment and injects it into the container.
   =========================================================================== */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

const PORT = Number(process.env.RUNNER_PORT || 8790);
const IMAGE = process.env.IMAGE || "stardust-sandbox";
const OUTPUTS_DIR = resolve(process.env.OUTPUTS_DIR || `${process.cwd()}/sandbox/outputs`);
const INGEST_BASE = process.env.INGEST_BASE || "http://host.docker.internal:5173";
const MODEL = process.env.CEREBRAS_MODEL || "gemma-4-31b";
const CEREBRAS_API_KEY = process.env.CEREBRAS_API_KEY;
const CEREBRAS_BASE_URL = process.env.CEREBRAS_BASE_URL || "";

if (!CEREBRAS_API_KEY) {
  console.error("CEREBRAS_API_KEY not set (source app/.env first)");
  process.exit(1);
}

function startContainer({ runId, url, token }) {
  const out = `${OUTPUTS_DIR}/${runId}`;
  const work = `${OUTPUTS_DIR}/${runId}-workspace`;
  mkdirSync(out, { recursive: true });
  mkdirSync(work, { recursive: true });
  const args = [
    "run", "--rm",
    "-e", `RUN_ID=${runId}`,
    "-e", `TARGET_URL=${url}`,
    "-e", `INGEST_TOKEN=${token}`,
    "-e", `INGEST_BASE=${INGEST_BASE}`,
    "-e", `CEREBRAS_API_KEY=${CEREBRAS_API_KEY}`,
    "-e", `CEREBRAS_MODEL=${MODEL}`,
    ...(CEREBRAS_BASE_URL ? ["-e", `CEREBRAS_BASE_URL=${CEREBRAS_BASE_URL}`] : []),
    "-e", "OUTPUTS_DIR=/mnt/session/outputs",
    "-e", "WORKDIR=/workspace",
    "-v", `${out}:/mnt/session/outputs`,
    "-v", `${work}:/workspace/stardust`,
    "--entrypoint", "node",
    IMAGE, "/workspace/runtime/agent.mjs",
  ];
  const child = spawn("docker", args, { stdio: "inherit", detached: true });
  child.unref();
  console.log(`[runner] spawned ${MODEL} container for run ${runId} (${url})`);
}

createServer((req, res) => {
  if (req.method !== "POST" || !req.url?.endsWith("/run")) {
    res.writeHead(404).end("not found");
    return;
  }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    try {
      const { runId, url, token } = JSON.parse(body || "{}");
      if (!runId || !token) throw new Error("runId and token required");
      startContainer({ runId, url: url || "", token });
      res.writeHead(202, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: String(e.message || e) }));
    }
  });
}).listen(PORT, () => console.log(`[runner] listening on http://localhost:${PORT}  image=${IMAGE} model=${MODEL} outputs=${OUTPUTS_DIR}`));
