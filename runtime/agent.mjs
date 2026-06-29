/* ===========================================================================
   stardust runtime entrypoint (Cerebras/Gemma path). Runs INSIDE the sandbox:
   reads the run config from env, runs the agent loop against the configured
   model provider, executes tools locally, and pushes progress/deliverables to
   the web app's ingest bridge. This is the open-loop alternative to Anthropic
   Managed Agents — the UI is unchanged.

   Env:
     RUN_ID, INGEST_BASE, INGEST_TOKEN   (from the Durable Object)
     TARGET_URL                          (the site to redesign)
     CEREBRAS_API_KEY [, CEREBRAS_MODEL, CEREBRAS_BASE_URL]
     OUTPUTS_DIR=/mnt/session/outputs, WORKDIR=/workspace
     TASK (optional) — override the uplift instruction (used by smoke tests)
   =========================================================================== */
import { readFile } from "node:fs/promises";
import { makeProvider } from "./provider.mjs";
import { makeIngest } from "./ingest.mjs";
import { makeTools, TOOL_SPECS } from "./tools.mjs";
import { runLoop } from "./loop.mjs";

const env = process.env;
const runId = env.RUN_ID;
const base = env.INGEST_BASE;
const token = env.INGEST_TOKEN;
const url = env.TARGET_URL;
const outputsDir = env.OUTPUTS_DIR || "/mnt/session/outputs";
const workdir = env.WORKDIR || "/workspace";

if (!runId || !base || !token) {
  console.error("RUN_ID, INGEST_BASE, INGEST_TOKEN are required");
  process.exit(1);
}

const provider = makeProvider();
const ingest = makeIngest({ base, runId, token, outputsDir });
const tools = makeTools({ workdir, outputsDir, ingest });
const system = await readFile(new URL("./system-prompt.md", import.meta.url), "utf8");

const task =
  env.TASK ||
  `Redesign ${url} for presales. Run stardust:uplift to completion, non-interactively. ` +
    `The skills are baked at /workspace/skills; work in /workspace and write deliverables to ${outputsDir}. ` +
    `Emit each milestone (emit_milestone) the instant it happens and upload each deliverable (upload_artifact) as soon as it exists.`;

try {
  await ingest.event({ type: "narration", text: `Cerebras ${provider.model} — starting${url ? ` uplift of ${url}` : ""}.` });
  const { usage, done } = await runLoop({
    provider,
    tools,
    toolSpecs: TOOL_SPECS,
    system,
    task,
    onNarration: (t) => ingest.event({ type: "narration", text: t }).catch(() => {}),
    onTool: (name) => ingest.event({ type: "tool", name }).catch(() => {}),
  });
  if (!done) await ingest.event({ phase: "done" }).catch(() => {});
  console.log(`runtime finished: done=${done} calls=${usage.calls} tokens=${usage.total}`);
} catch (e) {
  console.error("runtime error:", e?.message ?? e);
  await ingest.event({ type: "narration", text: `Run error: ${e?.message ?? e}` }).catch(() => {});
  process.exit(1);
}
