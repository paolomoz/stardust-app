#!/usr/bin/env node
/* ===========================================================================
   Provision the stardust Managed Agent + environment.
   Creates an agent (model claude-opus-4-8 + agent_toolset_20260401 + the system
   prompt) and an environment (cloud by default; --self-hosted for M4), then
   writes the IDs to agent/agent.local.json and web/.dev.vars so the Worker can
   create real sessions.

   Usage:
     ANTHROPIC_API_KEY=sk-ant-... node agent/setup.mjs            # cloud env (M3)
     ANTHROPIC_API_KEY=sk-ant-... node agent/setup.mjs --self-hosted
   Requires Node 22+ (global fetch). No npm deps.
   =========================================================================== */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BETA = "managed-agents-2026-04-01";
const API = "https://api.anthropic.com/v1";

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error("Set ANTHROPIC_API_KEY (an Anthropic key with Managed Agents beta access).");
  process.exit(1);
}
const selfHosted = process.argv.includes("--self-hosted");
// --agent-only: recreate just the agent (e.g. after editing system-prompt.md)
// and reuse the existing environment from agent.local.json — so a running
// poller bound to that environment keeps working.
const agentOnly = process.argv.includes("--agent-only");

const headers = {
  "x-api-key": key,
  "anthropic-version": "2023-06-01",
  "anthropic-beta": BETA,
  "content-type": "application/json",
};

async function post(path, body) {
  const res = await fetch(`${API}${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`POST ${path} -> ${res.status}\n${text}`);
  return JSON.parse(text);
}

const system = readFileSync(join(HERE, "system-prompt.md"), "utf8");

console.log("Creating agent (claude-opus-4-8)…");
const agent = await post("/agents", {
  name: "stardust-engine",
  model: "claude-opus-4-8",
  system,
  tools: [{ type: "agent_toolset_20260401" }],
});
console.log(`  agent ${agent.id} (v${agent.version})`);

let env;
if (agentOnly) {
  const prev = existsSync(join(HERE, "agent.local.json"))
    ? JSON.parse(readFileSync(join(HERE, "agent.local.json"), "utf8"))
    : null;
  if (!prev?.environmentId) {
    console.error("--agent-only needs an existing agent/agent.local.json with environmentId. Run setup once without it first.");
    process.exit(1);
  }
  env = { id: prev.environmentId };
  console.log(`Reusing environment ${env.id} (--agent-only)`);
} else {
  console.log(`Creating ${selfHosted ? "self-hosted" : "cloud"} environment…`);
  env = await post("/environments", {
    name: selfHosted ? "stardust-self-hosted" : "stardust-cloud",
    config: selfHosted ? { type: "self_hosted" } : { type: "cloud", networking: { type: "unrestricted" } },
  });
  console.log(`  environment ${env.id}`);
}

// Persist for reference.
const out = {
  agentId: agent.id,
  agentVersion: agent.version,
  environmentId: env.id,
  environmentType: agentOnly
    ? (JSON.parse(readFileSync(join(HERE, "agent.local.json"), "utf8")).environmentType ?? "self_hosted")
    : selfHosted ? "self_hosted" : "cloud",
};
writeFileSync(join(HERE, "agent.local.json"), JSON.stringify(out, null, 2) + "\n");
console.log("Wrote agent/agent.local.json");

// Append to web/.dev.vars so `vite dev` (Miniflare) exposes them to the Worker.
const devVars = join(HERE, "..", "web", ".dev.vars");
// INGEST_BASE: where the sandbox container reaches this Worker. Preserve an
// existing value; default to Docker Desktop's host gateway on the dev port.
const existing = existsSync(devVars) ? readFileSync(devVars, "utf8") : "";
const prevIngest = existing.split("\n").find((l) => /^INGEST_BASE=/.test(l));
const lines = [
  `ANTHROPIC_API_KEY=${key}`,
  `STARDUST_AGENT_ID=${agent.id}`,
  `STARDUST_ENVIRONMENT_ID=${env.id}`,
  prevIngest ?? `INGEST_BASE=http://host.docker.internal:5173`,
];
const kept = existing
  .split("\n")
  .filter((l) => l.trim() && !/^(ANTHROPIC_API_KEY|STARDUST_AGENT_ID|STARDUST_ENVIRONMENT_ID|INGEST_BASE)=/.test(l));
writeFileSync(devVars, [...kept, ...lines].join("\n") + "\n");
console.log("Updated web/.dev.vars");

console.log("\nDone. Start a real run with mode:'agent' (see agent/README.md).");
