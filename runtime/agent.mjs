/* ===========================================================================
   stardust runtime entrypoint (Cerebras/Gemma path). Runs INSIDE the sandbox:
   reads the run config from env, runs the agent loop against the configured
   model provider, executes tools locally, and pushes progress/deliverables to
   the web app's ingest bridge. This is the open-loop alternative to Anthropic
   Managed Agents — the UI is unchanged.

   Env:
     RUN_ID, INGEST_BASE, INGEST_TOKEN   (from the Durable Object)
     TARGET_URL                          (the site to redesign)
     MODEL_BACKEND=cerebras|bedrock  (default cerebras)
     cerebras: CEREBRAS_API_KEY [, CEREBRAS_MODEL, CEREBRAS_BASE_URL]
     bedrock:  BEDROCK_API_KEY [, BEDROCK_MODEL, BEDROCK_REGION]
     OUTPUTS_DIR=/mnt/session/outputs, WORKDIR=/workspace
     TASK (optional) — override the uplift instruction (used by smoke tests)
     ITERATE=1 — iteration mode: apply one change to an existing variant
       INSTRUCTION (the director's change), VARIANT_ID (A|B|C),
       VARIANT_FILE (e.g. home-C-cinematic.html). Reuses the persisted
       /workspace/stardust tree + /mnt/session/outputs from the original run.
   =========================================================================== */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { makeProvider } from "./provider.mjs";
import { makeBedrockProvider } from "./provider-bedrock.mjs";
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

const backend = (env.MODEL_BACKEND || "cerebras").toLowerCase();
const provider = backend === "bedrock" ? makeBedrockProvider() : makeProvider();
const ingest = makeIngest({ base, runId, token, outputsDir });
const tools = makeTools({ workdir, outputsDir, ingest });
const system = await readFile(new URL("./system-prompt.md", import.meta.url), "utf8");

const iterate = env.ITERATE === "1";
const variantId = env.VARIANT_ID || "C";
const variantFile = env.VARIANT_FILE || "home-C-cinematic.html";
const instruction = env.INSTRUCTION || "";

const upliftTask =
  env.TASK ||
  `Redesign ${url} for presales. Run stardust:uplift to completion, non-interactively. ` +
    `The skills are baked at /workspace/skills; work in /workspace and write deliverables to ${outputsDir}. ` +
    `Emit each milestone (emit_milestone) the instant it happens and upload each deliverable (upload_artifact) as soon as it exists.`;

const iterateTask =
  `ITERATION, not a full run. A redesign already exists in this sandbox: the persisted workspace is at /workspace/stardust and the deliverables are in ${outputsDir}. ` +
  `The director wants ONE change to variant ${variantId} (the file ${outputsDir}/${variantFile}): "${instruction}". ` +
  `Apply it surgically — read the existing ${variantFile}, make exactly the requested change while keeping the brand palette, type, and one canonical CTA intact, and change nothing else. ` +
  `Do this through impeccable, not by hand: pick the matching impeccable command for the request (e.g. colorize, typeset, polish, motion, or a targeted craft edit), read its reference/<command>.md, and follow that flow. ` +
  `Do NOT re-run extract or direct, and do NOT touch the other variants. ` +
  `Then inspect the result in the browser (Playwright screenshot) to confirm it renders and the change landed, write the updated ${variantFile} back to ${outputsDir} (plus any new assets), and upload_artifact each changed path. ` +
  `Finally call emit_milestone(phase="iterate", event="done", data={"variant":"${variantId}","file":"${variantFile}"}) — that is the LAST thing you do.`;

const task = iterate ? iterateTask : upliftTask;
const iterateHint = `Finish the requested change to variant ${variantId}, upload the updated ${variantFile}, then call emit_milestone with phase "iterate" and event "done".`;

// The design context an iteration needs (impeccable reads these). Snapshotted to
// R2 at the end of a run and restored at the start of an iteration — so iterate
// works even on Cloudflare Containers' ephemeral disk (no bind mount).
const CTX_FILES = ["PRODUCT.md", "DESIGN.md", "DESIGN.json", "_brand-extraction.json"];
const ctxDir = `${workdir}/stardust/current`;

if (iterate) {
  // Restore the target variant + design context from R2 (best-effort).
  await ingest.download(variantFile, `${outputsDir}/${variantFile}`).catch(() => {});
  for (const f of CTX_FILES) await ingest.download(`_ctx/${f}`, `${ctxDir}/${f}`).catch(() => {});
}

// On iteration, point impeccable's context loader at the persisted design context
// (stardust:uplift writes PRODUCT.md/DESIGN.* under stardust/current/, which sits
// below the /workspace cwd where context.mjs would otherwise find nothing).
if (iterate && !env.IMPECCABLE_CONTEXT_DIR) {
  for (const d of [`${workdir}/stardust/current`, `${workdir}/stardust`]) {
    if (existsSync(`${d}/PRODUCT.md`) || existsSync(`${d}/DESIGN.md`)) { process.env.IMPECCABLE_CONTEXT_DIR = d; break; }
  }
}

try {
  await ingest.event({ type: "narration", text: iterate
    ? `${provider.name} ${provider.model} — re-rendering variant ${variantId}: ${instruction}`
    : `${provider.name} ${provider.model} — starting${url ? ` uplift of ${url}` : ""}.` });
  const { usage, done } = await runLoop({
    provider,
    tools,
    toolSpecs: TOOL_SPECS,
    system,
    task,
    ...(iterate ? { doneHint: iterateHint } : {}),
    onNarration: (t) => ingest.event({ type: "narration", text: t }).catch(() => {}),
    onTool: (name) => ingest.event({ type: "tool", name }).catch(() => {}),
  });
  // Always emit the terminal milestone at clean exit — unconditional + idempotent
  // (the DO dedupes: done→`if(finished)return`, iterate→`if(!iterating)return`).
  // Guards the case where the in-loop emit_milestone was made (done=true) but its
  // ingest POST silently failed, which would otherwise strand the UI in "loading".
  await ingest.event(iterate
    ? { phase: "iterate", event: "done", variant: variantId, file: variantFile }
    : { phase: "done" }).catch(() => {});
  // Snapshot the design context to R2 so a later iteration can restore it.
  if (!iterate) {
    for (const f of CTX_FILES) await ingest.uploadFrom(`_ctx/${f}`, `${ctxDir}/${f}`).catch(() => {});
  }
  console.log(`runtime finished: mode=${iterate ? "iterate" : "uplift"} done=${done} calls=${usage.calls} tokens=${usage.total}`);
} catch (e) {
  const message = String(e?.message ?? e);
  console.error("runtime error:", message);
  // Structured failure so the UI shows an honest error, not a hung spinner. An
  // iteration failure must NOT fail the whole (already-done) run. If we report
  // it ourselves, exit 0 so the runner's exit backstop doesn't double-report;
  // exit 1 only when we couldn't (then the runner reports for us).
  let reported = false;
  try {
    await ingest.event(iterate
      ? { phase: "iterate", event: "failed", variant: variantId, message }
      : { phase: "failed", message });
    reported = true;
  } catch { /* fall through to non-zero exit */ }
  process.exit(reported ? 0 : 1);
}
