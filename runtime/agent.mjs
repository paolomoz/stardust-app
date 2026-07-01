/* ===========================================================================
   stardust runtime entrypoint. Runs INSIDE the sandbox: reads the run config
   from env, runs the agent loop against the configured model provider, executes
   tools locally, and pushes progress/deliverables to the web app's ingest
   bridge. Open-loop alternative to Anthropic Managed Agents — the UI is unchanged.

   Modes (env.MODE, default "uplift"; ITERATE=1 is the legacy alias for iterate):
     uplift    — full stardust:uplift run → brand + 3 variants (home page).
     iterate   — apply one change to an existing variant (workspace chat).
     variant   — generate an ADDITIONAL direction (variant D, E, …) by forking a
                 base variant and re-crafting it (Directions chat / + new direction).
     template  — render ANOTHER page of the site in a chosen variant's direction
                 (the prototype phase). Restores the run's workspace bundle.

   Env:
     RUN_ID, INGEST_BASE, INGEST_TOKEN   (from the Durable Object)
     TARGET_URL                          (the site; uplift)
     MODEL_BACKEND=cerebras|bedrock  (default cerebras)
     OUTPUTS_DIR=/mnt/session/outputs, WORKDIR=/workspace
     iterate:  INSTRUCTION, VARIANT_ID, VARIANT_FILE
     variant:  INSTRUCTION, VARIANT_NAME (new id), VARIANT_FILE (base to fork)
     template: VARIANT_ID, VARIANT_FILE, SLUG, PAGE_URL, PAGE_TITLE, INSTRUCTION
   =========================================================================== */
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { makeProvider } from "./provider.mjs";
import { makeBedrockProvider } from "./provider-bedrock.mjs";
import { makeIngest } from "./ingest.mjs";
import { makeTools, TOOL_SPECS } from "./tools.mjs";
import { runLoop } from "./loop.mjs";
import { derivePages } from "./pages.mjs";

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

const mode = env.MODE || (env.ITERATE === "1" ? "iterate" : "uplift");
// Post-run jobs may run under a fresh isolated WORKDIR (prod parallel jobs) — make
// sure it exists before the plugin/impeccable cd into it.
try { mkdirSync(workdir, { recursive: true }); } catch { /* exists */ }
const variantId = env.VARIANT_ID || "C";
const variantFile = env.VARIANT_FILE || "home-C-cinematic.html";
const variantName = env.VARIANT_NAME || "D";
const instruction = env.INSTRUCTION || "";
const slug = env.SLUG || "";
const pageUrl = env.PAGE_URL || "";
const pageTitle = env.PAGE_TITLE || slug;

// The design context an iteration/variant fork needs (impeccable reads these).
// Snapshotted to R2 at the end of a run and restored at the start of a job — so
// jobs work on Cloudflare Containers' ephemeral disk (no bind mount).
const CTX_FILES = ["PRODUCT.md", "DESIGN.md", "DESIGN.json", "_brand-extraction.json"];
const ctxDir = `${workdir}/stardust/current`;
// The whole restorable workspace (root DESIGN/PRODUCT + stardust/ tree). Uploaded
// at the end of an uplift run; restored by template jobs (they need the direction,
// per-variant DESIGN files, brand extraction, assets, and the page inventory).
const BUNDLE_KEY = "_workspace.tgz";
const BUNDLE_TMP = "/tmp/_workspace.tgz";

/** Point impeccable's context loader at the persisted design context (uplift
 *  writes PRODUCT.md/DESIGN.* under stardust/current/, below the cwd). */
function pointImpeccableContext() {
  if (env.IMPECCABLE_CONTEXT_DIR) return;
  for (const d of [`${workdir}/stardust/current`, `${workdir}/stardust`]) {
    if (existsSync(`${d}/PRODUCT.md`) || existsSync(`${d}/DESIGN.md`)) { process.env.IMPECCABLE_CONTEXT_DIR = d; break; }
  }
}

/** Restore the run's workspace bundle into WORKDIR (root DESIGN/PRODUCT + the
 *  stardust/ tree). Best-effort — a template job needs it; log on miss. */
async function restoreBundle() {
  try {
    await ingest.download(BUNDLE_KEY, BUNDLE_TMP);
    execFileSync("tar", ["xzf", BUNDLE_TMP, "-C", workdir], { stdio: "inherit" });
    return true;
  } catch (e) {
    console.error("restoreBundle failed:", String(e?.message ?? e));
    return false;
  }
}

/** Tar the restorable workspace (the stardust/ tree + root DESIGN/PRODUCT files)
 *  and upload it as the run's bundle. Excludes the baked skills/runtime + caches. */
async function bundleWorkspace() {
  if (!existsSync(`${workdir}/stardust`)) return;
  try {
    execFileSync("bash", ["-lc",
      `cd ${workdir} && tar czf ${BUNDLE_TMP} --exclude=skills --exclude=runtime --exclude=node_modules --exclude=.git ` +
      `stardust $(ls DESIGN*.md DESIGN*.json PRODUCT.md 2>/dev/null)`], { stdio: "inherit" });
    await ingest.uploadFrom(BUNDLE_KEY, BUNDLE_TMP);
  } catch (e) {
    console.error("bundleWorkspace failed:", String(e?.message ?? e));
  }
}

/** Pin one variant as the single in-scope DESIGN so `prototype` renders only it:
 *  copy DESIGN-<id>.{md,json} to the unsuffixed alias and stash the siblings. */
function pinVariant(id) {
  try {
    execFileSync("bash", ["-lc",
      `cd ${workdir} && mkdir -p stardust/_stash && ` +
      `for f in DESIGN-*.md DESIGN-*.json; do [ -e "$f" ] || continue; case "$f" in ` +
      `DESIGN-${id}.*) ;; *) mv "$f" stardust/_stash/ ;; esac; done; ` +
      `[ -e DESIGN-${id}.md ] && cp DESIGN-${id}.md DESIGN.md; ` +
      `[ -e DESIGN-${id}.json ] && cp DESIGN-${id}.json DESIGN.json; true`], { stdio: "inherit" });
  } catch (e) {
    console.error("pinVariant failed:", String(e?.message ?? e));
  }
}

// ---- task strings per mode --------------------------------------------------

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

const newVariantFile = `home-${variantName}-proposed.html`;
const variantTask =
  `You are generating an ADDITIONAL design direction — variant ${variantName} — for an existing redesign by forking an existing variant and taking it somewhere new. ` +
  `A copy of the base variant is at ${outputsDir}/${variantFile} (persisted design context under /workspace/stardust; deliverables in ${outputsDir}). ` +
  `The director asks for: "${instruction}". ` +
  `FIRST classify: is this a QUESTION about the directions, or a request for a NEW direction/variant? Then do exactly ONE:\n` +
  `• QUESTION/comment → ANSWER via reply_to_user (clean Markdown) from the context; create nothing; finish with emit_milestone(phase="variant", event="answer").\n` +
  `• NEW DIRECTION → produce a new full-page prototype at ${outputsDir}/${newVariantFile}:\n` +
  `   1. run_bash: cp ${outputsDir}/${variantFile} ${outputsDir}/${newVariantFile}\n` +
  `   2. Re-craft ${newVariantFile} to realize the requested direction THROUGH impeccable — a substantial redesign pass (typeset / colorize / compose / motion / polish as the direction demands), staying brand-faithful (same logo, product truth, real content). Read the impeccable command reference you use and follow it.\n` +
  `   3. Inspect it in the browser (Playwright screenshot) and fix anything broken.\n` +
  `   4. upload_artifact ${newVariantFile} (and assets/thumb-${variantName}.png if you capture one).\n` +
  `   5. Send a short reply_to_user pitch of the new direction.\n` +
  `   6. Finish with emit_milestone(phase="variant", event="added", data={"card":{"id":"${variantName}","title":"<3-5 word name>","pitch":"<one sentence>","whatif":"<the what-if in one line>","role":"<one-word role>","file":"${newVariantFile}","thumb":"assets/thumb-${variantName}.png"}}). Omit thumb if you didn't make one.\n` +
  `Put everything the director should read in reply_to_user — other output is dim 'thinking'.`;

const tSlug = slug || "page";
const templateTask =
  `You are rendering another page of an existing site in a chosen redesign direction (variant ${variantId}). ` +
  `The target design system is DESIGN.md/DESIGN.json at the project root (already pinned to variant ${variantId}); the persisted context is under /workspace/stardust; write deliverables to ${outputsDir}. ` +
  (slug
    ? `Prototype the page "${pageTitle}" at ${pageUrl} (use slug "${slug}").\n`
    : `The director says: "${instruction}". If this is a QUESTION about the prototypes, answer it via reply_to_user and finish with emit_milestone(phase="template", event="answer"). Otherwise identify which page of ${url || "the site"} they mean, choose a short slug for it, and prototype it.\n`) +
  `Steps:\n` +
  `1. Announce: emit_milestone(phase="template", event="page_started", data={"slug":"${tSlug}","title":"${pageTitle || tSlug}"}).\n` +
  `2. If stardust/current/pages/<slug>.json does not exist, capture the page first: run stardust:extract <page-url> --single (store it under the slug).\n` +
  `3. Render it: run stardust:prototype <slug> using the pinned DESIGN. Keep it brand-faithful and consistent with the direction (same tokens, type, motion register).\n` +
  `4. Save the rendered page to ${outputsDir}/<slug>-proposed.html (copy it there — find it under stardust/prototypes/ if the skill wrote it elsewhere) and upload_artifact <slug>-proposed.html. Upload assets/thumb-<slug>.png too if you capture one.\n` +
  `5. Send a short reply_to_user summary and finish with emit_milestone(phase="template", event="page_done", data={"slug":"<slug>","title":"<title>","file":"<slug>-proposed.html","thumb":"assets/thumb-<slug>.png"}). Omit thumb if none.\n` +
  `Put everything the director should read in reply_to_user — other output is dim 'thinking'.`;

// ---- terminal + restore per mode -------------------------------------------

let task;
let doneHint;
let initialMessages;

if (mode === "iterate") {
  task = iterateTask;
  doneHint = `Finish now: if it was a question, answer it and call emit_milestone(phase="iterate", event="answer"); if a change, upload the updated ${variantFile} and call emit_milestone(phase="iterate", event="done").`;
  await ingest.download(variantFile, `${outputsDir}/${variantFile}`).catch(() => {});
  for (const f of CTX_FILES) await ingest.download(`_ctx/${f}`, `${ctxDir}/${f}`).catch(() => {});
  // Per-variant conversation, persisted to R2 so iterations have memory. Continue
  // it by appending this instruction as a follow-up turn.
  const SESSION_KEY = `_sessions/${variantId}.json`;
  const iterateFollowup =
    `The director says: "${instruction}". You have the full prior conversation above — use it. ` +
    `Classify the intent and do exactly ONE:\n` +
    `• QUESTION/comment → ANSWER via reply_to_user (clean Markdown) from the conversation + context; edit and upload nothing; finish with emit_milestone(phase="iterate", event="answer").\n` +
    `• CHANGE → apply it surgically to ${variantFile} (keep brand palette, type, and one canonical CTA intact, change nothing else, through impeccable; reason about earlier turns for undo/refine), inspect in the browser, upload the updated file, send a short reply_to_user summary, and finish with emit_milestone(phase="iterate", event="done", data={"variant":"${variantId}","file":"${variantFile}"}).\n` +
    `Put everything the director should read in reply_to_user — other output is dim 'thinking'. When unsure, prefer answering — NEVER edit the page just to answer a question.`;
  const prior = await ingest.downloadJSON(SESSION_KEY).catch(() => null);
  if (Array.isArray(prior) && prior.length) initialMessages = [...prior, { role: "user", content: iterateFollowup }];
  pointImpeccableContext();
} else if (mode === "variant") {
  task = variantTask;
  doneHint = `Finish now: if it was a question, call emit_milestone(phase="variant", event="answer"); otherwise upload ${newVariantFile} and call emit_milestone(phase="variant", event="added", data={"card":{...}}).`;
  await ingest.download(variantFile, `${outputsDir}/${variantFile}`).catch(() => {});
  for (const f of CTX_FILES) await ingest.download(`_ctx/${f}`, `${ctxDir}/${f}`).catch(() => {});
  pointImpeccableContext();
} else if (mode === "template") {
  task = templateTask;
  doneHint = `Finish now: upload <slug>-proposed.html and call emit_milestone(phase="template", event="page_done", data={"slug":...,"file":...}); or emit_milestone(phase="template", event="answer") for a question.`;
  await restoreBundle();
  pinVariant(variantId);
  pointImpeccableContext();
} else {
  task = upliftTask;
}

const terminal = (name, args) => {
  if (name !== "emit_milestone") return false;
  const p = args?.phase, e = args?.event;
  if (mode === "iterate") return p === "iterate" && (e === "done" || e === "answer");
  if (mode === "variant") return p === "variant" && (e === "added" || e === "answer");
  if (mode === "template") return p === "template" && (e === "page_done" || e === "answer");
  return p === "done";
};

try {
  await ingest.event({ type: "narration", text:
    mode === "iterate" ? `${provider.name} ${provider.model} — variant ${variantId}: ${instruction}`
    : mode === "variant" ? `${provider.name} ${provider.model} — new direction ${variantName}: ${instruction}`
    : mode === "template" ? `${provider.name} ${provider.model} — prototyping ${pageTitle || slug || "a page"} in variant ${variantId}`
    : `${provider.name} ${provider.model} — starting${url ? ` uplift of ${url}` : ""}.` });

  const { usage, done, steps } = await runLoop({
    provider,
    tools,
    toolSpecs: TOOL_SPECS,
    system,
    task,
    isDone: terminal,
    ...(doneHint ? { doneHint } : {}),
    ...(initialMessages ? { initialMessages } : {}),
    onNarration: (t) => ingest.event({ type: "narration", text: t }).catch(() => {}),
    onTool: (name) => ingest.event({ type: "tool", name }).catch(() => {}),
  });

  // Persist the per-variant conversation so the next iterate prompt has memory.
  if (mode === "iterate") await ingest.uploadJSON(`_sessions/${variantId}.json`, steps).catch(() => {});

  // Backstop: never strand the UI in "loading" if the loop ended without a
  // terminal milestone. Default each mode to an honest terminal event.
  if (!done) {
    const ev =
      mode === "iterate" ? { phase: "iterate", event: "done", variant: variantId, file: variantFile }
      : mode === "variant" ? { phase: "variant", event: "failed", message: "the direction wasn't produced" }
      : mode === "template" ? { phase: "template", event: "page_failed", slug: slug || tSlug, message: "the page wasn't rendered" }
      : { phase: "done" };
    await ingest.event(ev).catch(() => {});
  }

  // End-of-run snapshots: the design context (iterate/variant restore it) + the
  // whole workspace bundle (template jobs restore it) + discovered pages.
  if (mode === "uplift") {
    for (const f of CTX_FILES) await ingest.uploadFrom(`_ctx/${f}`, `${ctxDir}/${f}`).catch(() => {});
    const pages = derivePages(`${workdir}/stardust/current/pages`, url);
    if (pages.length) await ingest.event({ phase: "extract", event: "pages", pages }).catch(() => {});
    await bundleWorkspace();
  }
  // A new direction changed the workspace (new DESIGN-<name>) — re-bundle so
  // later template jobs can render pages in it too.
  if (mode === "variant" && done) await bundleWorkspace();

  console.log(`runtime finished: mode=${mode} done=${done} calls=${usage.calls} tokens=${usage.total}`);
} catch (e) {
  const message = String(e?.message ?? e);
  console.error("runtime error:", message);
  // Structured failure so the UI shows an honest error, not a hung spinner. A
  // post-run job failure must NOT fail the whole (already-done) run.
  let reported = false;
  try {
    const ev =
      mode === "iterate" ? { phase: "iterate", event: "failed", variant: variantId, message }
      : mode === "variant" ? { phase: "variant", event: "failed", message }
      : mode === "template" ? { phase: "template", event: "page_failed", slug: slug || tSlug, message }
      : { phase: "failed", message };
    await ingest.event(ev);
    reported = true;
  } catch { /* fall through to non-zero exit */ }
  process.exit(reported ? 0 : 1);
}
