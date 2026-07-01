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
  `You are in an ongoing session for variant ${variantId} of an existing redesign (its file is ${outputsDir}/${variantFile}; the persisted workspace is /workspace/stardust, deliverables in ${outputsDir}). ` +
  `The director says: "${instruction}". ` +
  `FIRST classify the intent, then do exactly ONE of the following:\n` +
  `• QUESTION or comment (asking what you did, why, what you know, for an opinion/explanation, etc.): ANSWER it by calling reply_to_user with clean Markdown (short paragraphs, - bullets, **bold**) drawn from your knowledge + the persisted context (state.json, direction.md, PRODUCT/DESIGN, the variant file). Do NOT edit or upload any file. Then finish with emit_milestone(phase="iterate", event="answer").\n` +
  `• CHANGE request: apply it surgically to ${variantFile} — read the file, make exactly the requested change while keeping the brand palette, type, and one canonical CTA intact, and change nothing else. Do it through impeccable (pick the matching command — colorize, typeset, polish, motion, or a targeted craft edit — read its reference/<command>.md, follow it). Do NOT re-run extract or direct, and do NOT touch other variants. Then inspect in the browser (Playwright screenshot), write ${variantFile} back to ${outputsDir} + upload_artifact each changed path, send a short reply_to_user summary of what changed, and finish with emit_milestone(phase="iterate", event="done", data={"variant":"${variantId}","file":"${variantFile}"}).\n` +
  `Put everything the director should read in reply_to_user — your other output is shown only as dim 'thinking'. When unsure, prefer answering — NEVER edit the page just to respond to a question.`;

const task = iterate ? iterateTask : upliftTask;
const iterateHint = `Finish now: if it was a question, answer it and call emit_milestone(phase="iterate", event="answer"); if a change, upload the updated ${variantFile} and call emit_milestone(phase="iterate", event="done").`;

// Per-variant conversation, persisted to R2 so iterations have memory across
// prompts. When it exists, continue it by appending this instruction as a follow-
// up turn (the agent sees its own prior edits + reasoning — enables real undo/
// refine); the first iteration seeds it via iterateTask and we persist the result.
const SESSION_KEY = `_sessions/${variantId}.json`;
const iterateFollowup =
  `The director says: "${instruction}". You have the full prior conversation above — use it. ` +
  `Classify the intent and do exactly ONE:\n` +
  `• QUESTION/comment → ANSWER via reply_to_user (clean Markdown) from the conversation + context; edit and upload nothing; finish with emit_milestone(phase="iterate", event="answer").\n` +
  `• CHANGE → apply it surgically to ${variantFile} (keep brand palette, type, and one canonical CTA intact, change nothing else, through impeccable; reason about earlier turns for undo/refine), inspect in the browser, upload the updated file, send a short reply_to_user summary, and finish with emit_milestone(phase="iterate", event="done", data={"variant":"${variantId}","file":"${variantFile}"}).\n` +
  `Put everything the director should read in reply_to_user — other output is dim 'thinking'. When unsure, prefer answering — NEVER edit the page just to answer a question.`;
let initialMessages;

// The design context an iteration needs (impeccable reads these). Snapshotted to
// R2 at the end of a run and restored at the start of an iteration — so iterate
// works even on Cloudflare Containers' ephemeral disk (no bind mount).
const CTX_FILES = ["PRODUCT.md", "DESIGN.md", "DESIGN.json", "_brand-extraction.json"];
const ctxDir = `${workdir}/stardust/current`;

if (iterate) {
  // Restore the target variant + design context from R2 (best-effort).
  await ingest.download(variantFile, `${outputsDir}/${variantFile}`).catch(() => {});
  for (const f of CTX_FILES) await ingest.download(`_ctx/${f}`, `${ctxDir}/${f}`).catch(() => {});
  // Restore the per-variant conversation → continue it with this instruction.
  const prior = await ingest.downloadJSON(SESSION_KEY).catch(() => null);
  if (Array.isArray(prior) && prior.length) initialMessages = [...prior, { role: "user", content: iterateFollowup }];
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
    ? `${provider.name} ${provider.model} — variant ${variantId}: ${instruction}`
    : `${provider.name} ${provider.model} — starting${url ? ` uplift of ${url}` : ""}.` });
  const { usage, done, steps } = await runLoop({
    provider,
    tools,
    toolSpecs: TOOL_SPECS,
    system,
    task,
    ...(iterate ? { doneHint: iterateHint } : {}),
    ...(initialMessages ? { initialMessages } : {}),
    onNarration: (t) => ingest.event({ type: "narration", text: t }).catch(() => {}),
    onTool: (name) => ingest.event({ type: "tool", name }).catch(() => {}),
  });
  // Persist the updated per-variant conversation so the next prompt has memory.
  if (iterate) await ingest.uploadJSON(SESSION_KEY, steps).catch(() => {});
  // Backstop: if the loop ended without the agent emitting a terminal milestone
  // (iterate done/answer, or run done — all matched by loop's `terminal`), emit
  // one so the UI never strands in "loading". Default an iteration to `done` (a
  // change); a missed answer is covered by the reopen guard. (The DO also dedupes.)
  if (!done) {
    await ingest.event(iterate
      ? { phase: "iterate", event: "done", variant: variantId, file: variantFile }
      : { phase: "done" }).catch(() => {});
  }
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
