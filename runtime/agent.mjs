/* ===========================================================================
   stardust runtime entrypoint. Runs INSIDE the sandbox: reads the run config
   from env, runs the agent loop against the configured model provider, executes
   tools locally, and pushes progress/deliverables to the web app's ingest
   bridge. Open-loop alternative to Anthropic Managed Agents — the UI is unchanged.

   Modes (env.MODE, default "uplift"; ITERATE=1 is the legacy alias for iterate):
     uplift    — full stardust:uplift run → brand + 3 variants (home page).
                 With UPLIFT_STAGE=direct it stops after direct (extract + brand +
                 the 3 directions), bundles the workspace, and hands off — the DO
                 then fans out one "build" job per variant (parallel craft).
     build     — craft ONE home-page variant from the phase-1 bundle (the pinned
                 DESIGN-<id> + direction). One container per variant, in parallel.
     iterate   — apply one change to an existing variant (workspace chat).
     variant   — generate an ADDITIONAL direction (variant D, E, …) by forking a
                 base variant and re-crafting it (Directions chat / + new direction).
     template  — render ANOTHER page of the site in a chosen variant's direction
                 (the prototype phase). Restores the run's workspace bundle.
     deploy    — convert finished prototypes into an Edge Delivery Services
                 bundle (_eds/: blocks + content fragments + manifest) per
                 eds-deploy-guide.md. A deterministic host-side publisher
                 (eds-publish.mjs, driven by the runner) does the transport.
     verify    — the deploy skill's Step 10 against the live preview (diff
                 probes + computed-layout gate).
     audit     — stardust:audit of a URL (the original site or the deployed
                 preview): scored design/SEO/LLM-visibility report.

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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
// Parallel uplift: phase 1 (UPLIFT_STAGE=direct) stops after direct and bundles;
// the DO then fans out one "build" job per variant.
const stage = env.UPLIFT_STAGE || "";
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
// Deploy-mode config (org/site/branch conventions decided by the DO).
const project = env.PROJECT || "";
const daOrg = env.DA_ORG || "paolomoz";
const daSite = env.DA_SITE || "stardust-app-fable";
const branch = env.BRANCH || project;
const previewHost = env.PREVIEW_HOST || `https://${branch}--${daSite}--${daOrg}.aem.page`;
let deployPages = [];
try { deployPages = JSON.parse(env.PAGES || "[]"); } catch { /* [] */ }

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

/** Pin one variant by STASHING its siblings — the plugin's own selector is
 *  DESIGN-<id> file PRESENCE at the project root (prototype has no --variant
 *  flag), and the -<id> suffix keys per-variant motion resolution, so the file
 *  keeps its name; we never copy it to an unsuffixed alias. */
function pinVariant(id) {
  try {
    execFileSync("bash", ["-lc",
      `cd ${workdir} && mkdir -p stardust/_stash && ` +
      `for f in DESIGN-*.md DESIGN-*.json; do [ -e "$f" ] || continue; case "$f" in ` +
      `DESIGN-${id}.*) ;; *) mv "$f" stardust/_stash/ ;; esac; done; true`], { stdio: "inherit" });
  } catch (e) {
    console.error("pinVariant failed:", String(e?.message ?? e));
  }
}

/** Tail the plugin's own run contract (stardust/status.jsonl — one JSON line
 *  per phase start/end/blocked) and relay each new line to the ingest bridge.
 *  Deterministic progress: the DO maps these to the board without waiting for
 *  the model to emit a milestone. Only whole lines are consumed. */
function startStatusTailer() {
  const file = `${workdir}/stardust/status.jsonl`;
  let offset = 0;
  const tick = () => {
    try {
      if (!existsSync(file)) return;
      const buf = readFileSync(file, "utf8");
      const nl = buf.lastIndexOf("\n");
      if (nl < offset) return; // no complete new line yet
      const chunk = buf.slice(offset, nl + 1);
      offset = nl + 1;
      for (const line of chunk.split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const j = JSON.parse(t);
          if (j?.skill && j?.event) {
            void ingest.event({ phase: "runstatus", skill: j.skill, step: j.phase ?? "", event: j.event, detail: j.detail, artifact: j.artifact }).catch(() => {});
          }
        } catch { /* malformed line — skip */ }
      }
    } catch { /* best-effort */ }
  };
  const t = setInterval(tick, 2000);
  t.unref?.();
  return () => { tick(); clearInterval(t); }; // final flush on stop
}

/** Deterministic progress watcher: the model batches milestone emissions, so the
 *  board can trail reality by whole phases. Poll the workspace for phase-marker
 *  files and push a `watch.marker` event the moment each lands — the DO maps
 *  markers to board-row advancement (never to panel payloads, which still come
 *  from the real milestones). Display-only, best-effort. */
function startMarkerWatcher() {
  const seen = new Set();
  const MARKERS = [
    ["rendered", () => existsSync(`${workdir}/stardust/current/pages`)],
    ["brand_extracted", () => existsSync(`${workdir}/stardust/current/_brand-extraction.json`)],
    ["brand_built", () => existsSync(`${workdir}/stardust/current/brand-review.html`)],
    ["directions", () => existsSync(`${workdir}/stardust/direction.md`)],
    ["designs", () => ["A", "B", "C"].every((v) => existsSync(`${workdir}/DESIGN-${v}.json`))],
  ];
  const tick = () => {
    for (const [id, hit] of MARKERS) {
      if (seen.has(id)) continue;
      try {
        if (hit()) {
          seen.add(id);
          void ingest.event({ phase: "watch", event: "marker", marker: id }).catch(() => {});
        }
      } catch { /* best-effort */ }
    }
  };
  const t = setInterval(tick, 15_000);
  t.unref?.();
  return () => clearInterval(t);
}

// ---- task strings per mode --------------------------------------------------

const upliftTask =
  env.TASK ||
  `Redesign ${url} for presales. Run stardust:uplift to completion, non-interactively. ` +
    `The skills are baked at /workspace/skills; work in /workspace and write deliverables to ${outputsDir}. ` +
    `Emit each milestone (emit_milestone) the instant it happens and upload each deliverable (upload_artifact) as soon as it exists.`;

// Phase 1 of the parallel uplift: everything BEFORE the variant builds — the
// pages are crafted by fan-out "build" workers afterwards, never by this
// container. Follows uplift's own chain (extract --single → tensions →
// reference grounding → three directions → direct) in hands-off mode.
const directTask =
  `Redesign ${url} for presales. Run stardust:uplift in HANDS-OFF mode, but ONLY through its direction phases — ` +
  `stop BEFORE prototyping; the three variant pages are built afterwards by parallel workers, NOT by you. ` +
  `The skills are baked at /workspace/skills; work in /workspace; write deliverables to ${outputsDir}.\n` +
  `1. Uplift Phase 1: stardust:extract ${url} --single, in full (live render, vision-verified capture). Emit extract.started / ` +
  `extract.seed / extract.tensions / extract.brand_ready milestones the INSTANT each happens, and upload brand-review.html plus every asset it references.\n` +
  `2. Uplift Phases 2–4: tensions/traits (uplift-improvements.md + uplift-questions.md), reference grounding, the three variant ` +
  `directions, then stardust:direct — ending with stardust/direction.md and the per-variant DESIGN-A/B/C.{md,json} at the project root, exactly per the skill.\n` +
  `3. As the LAST thing, emit_milestone(phase="direct", event="variants_ready", data={"sharedFixes":[…],"variants":[{id,title,pitch,whatif,role,file,thumb},…]}) — ` +
  `sharedFixes from uplift-improvements.md; file names home-A-proposed.html, home-B-proposed.html, home-C-cinematic.html; thumbs assets/thumb-<id>.png. ` +
  `Those files don't exist yet; the build workers create and upload them.\n` +
  `Keep stardust/status.jsonl appended at every phase boundary (run-status contract). ` +
  `Do NOT run the prototype phase, do NOT build any variant page, do NOT emit prototype.variant_done or done.`;

// Phase 2 worker: craft ONE variant's page from the phase-1 bundle. This IS the
// plugin's documented parallel mechanism (isolated workspace copy, siblings
// stashed, DESIGN-<id> presence selects the variant).
const buildTask =
  `You are one isolated parallel builder finishing an uplift of ${url}: craft variant ${variantId}'s page. ` +
  `This workspace is your own copy of the project (the plugin's isolated-workspace parallel contract): brand extraction + captures ` +
  `under stardust/current, stardust/direction.md, and ONLY DESIGN-${variantId}.{md,json} at the project root (siblings stashed) — ` +
  `file presence selects the variant; do not restore or touch the stashed siblings. Write deliverables to ${outputsDir}.\n` +
  `1. Read /workspace/skills/stardust/uplift/SKILL.md (the per-variant build contract, gates included — vision gate too) and ` +
  `stardust/direction.md's variant ${variantId} section. For variant C the motion register comes from DESIGN-${variantId}.json extensions.motion.register.\n` +
  `2. Build the page THROUGH $impeccable craft (read /workspace/skills/impeccable/reference/craft.md and follow it): production-grade, ` +
  `brand-faithful, real content from the extracted capture (stardust/current/pages/), then inspect and improve it in the browser ` +
  `(Playwright screenshots) until it meets the studio bar. Run the validation gates for this ONE variant. The plugin writes it under stardust/prototypes/.\n` +
  `3. Copy the finished page to ${outputsDir}/${variantFile}. If it references lenis.min.js / lenis.min.css (cinematic), copy those next to it ` +
  `in ${outputsDir} (or rewrite to paths that resolve from the outputs tree) so the page renders in an iframe. ` +
  `Capture a thumbnail to ${outputsDir}/assets/thumb-${variantId}.png (1280px, above the fold); if the capture fails, use the newest ` +
  `screenshot under stardust/validation/ instead. upload_artifact the page, the thumb, and every asset the page references.\n` +
  `4. Finish with emit_milestone(phase="prototype", event="variant_done", data={"variant":"${variantId}","file":"${variantFile}"}). ` +
  `Build ONLY variant ${variantId}.`;

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
  `The target design system is DESIGN-${variantId}.{md,json} at the project root — the ONLY in-scope variant (siblings stashed; file presence selects it); the persisted context is under /workspace/stardust; write deliverables to ${outputsDir}. ` +
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

const deployList = deployPages.map((p) => `- ${p.slug}: "${p.title || p.slug}" ← ${outputsDir}/${p.file}`).join("\n");
// The AuthorKit runtime contract the conversion targets. The EDS repo is NOT in
// this sandbox — the host publisher bootstraps AuthorKit on the project branch
// (pinned ref) before pushing — so the contract is fixed by policy, not probed.
const AK_CONTRACT = `{"runtime":"authorkit","blockWrapperClass":"none","buttonClasses":".btn / .btn-primary / .btn-group","fragmentScriptPolicy":"inert-innerHTML","emptySectionCollapse":true}`;
const deployTask =
  `You are converting finished stardust prototypes into an Edge Delivery Services (AEM EDS) site by RUNNING the baked deploy skill: ` +
  `read /workspace/skills/stardust/deploy/SKILL.md and follow its conversion steps (1–9) faithfully.\n` +
  `Project: ${project} · org ${daOrg} · site ${daSite} · branch ${branch} · preview host ${previewHost}.\n` +
  `Pages to convert (finished prototypes already in ${outputsDir}):\n${deployList}\n` +
  `Sandbox constraints (this changes HOW you execute the skill, never its quality bar):\n` +
  `- The EDS repo is NOT present here and a deterministic host publisher does ALL transport. SKIP the repo probe, git, DA writes, ` +
  `preview/live, the aem-cli local harness, and Step 10 (a separate verify job runs the diff against the real preview). ` +
  `Target runtime contract (treat as stardust/runtime-contract.json): ${AK_CONTRACT} — so block CSS is scoped \`.name\` (NEVER \`.name.block\`), ` +
  `buttons are a.btn / .btn-primary inside p.btn-group, header/footer are STATIC FRAGMENTS per the skill's Step 6.\n` +
  `- Before starting: restore inputs — the workspace under /workspace/stardust has the brand context; copy the prototype pages from ${outputsDir} ` +
  `into stardust/prototypes/ so the skill finds them where it expects.\n` +
  `- Write EVERYTHING into ${outputsDir}/_eds/ (the publisher's contract — schema in /workspace/runtime/eds-deploy-guide.md):\n` +
  `  content/  — DA body fragments (home = index.html) + the Step-6 nav/footer fragments under content/fragments/;\n` +
  `  code/     — blocks/, styles/, fonts/, icons/, img/${project}/ (copy image binaries from ${outputsDir}/assets/), AND any runtime file the ` +
  `skill has you adjust — e.g. scripts/postlcp.js so fragments load from /${project}/fragments/ (all content for this project lives under the /${project}/ prefix);\n` +
  `  manifest.json — per the guide's schema (daPath prefix /${project}/; images by absolute code-bus URL ${previewHost}/img/${project}/…).\n` +
  `- If ${outputsDir}/_eds/manifest.json already exists this is an INCREMENTAL deploy: merge, reuse existing block names (read their CSS first), only add new blocks when none fits.\n` +
  `- keyFacts gate: if DESIGN.json extensions.metadata.keyFacts is absent, note it and continue (the skill's own rule).\n` +
  `Emit emit_milestone(phase="deploy", event="page_converted", data={"slug":"<slug>"}) the moment each page's fragment is written. ` +
  `upload_artifact EVERY file under _eds/. reply_to_user a short summary (blocks created, compromises). ` +
  `Finish with emit_milestone(phase="deploy", event="bundle_ready", data={"pages":${JSON.stringify(deployPages.map((p) => p.slug))}}).`;

// Post-preview fidelity verify: the deploy skill's Step 10 (stardust:diff) +
// the computed-layout gate, run against the LIVE preview from the sandbox.
const verifyList = deployPages.map((p) => `- ${p.slug}: prototype ${outputsDir}/${p.file} ⇄ ${previewHost}/${p.daPath ?? `${project}/${p.slug === "home" ? "index" : p.slug}`}`.replace("/index", "/")).join("\n");
const verifyTask =
  `You are verifying a deployed Edge Delivery preview against its source prototypes — the deploy skill's Step 10 plus the computed-layout gate. ` +
  `Read /workspace/skills/stardust/diff/SKILL.md for the exact probe invocations (profile eds). Pages:\n${verifyList}\n` +
  `1. Serve the prototypes locally: run_bash \`cd ${outputsDir} && (python3 -m http.server 8791 >/dev/null 2>&1 &) && sleep 1\`.\n` +
  `2. For EACH page run BOTH probes — node /workspace/skills/stardust/diff/scripts/visual-diff.mjs and content-diff.mjs — with ` +
  `PROTO = http://localhost:8791/<prototype file> and BUILD = the preview URL above.\n` +
  `3. Also run the computed-layout check per /workspace/skills/stardust/deploy/SKILL.md (headless Playwright on the BUILD URL: every grid/flex ` +
  `block computes display:grid/flex, main .section count > 0, blocks decorated, zero pageerror, zero broken images).\n` +
  `4. After each page: emit_milestone(phase="deploy", event="verify_page", data={"slug":"<slug>","ok":true|false,"flags":"<short 🔴/🟡 summary or empty>"}).\n` +
  `5. reply_to_user a short fidelity summary. Finish with emit_milestone(phase="deploy", event="verified", data={"ok":true|false}).\n` +
  `Judge per the diff skill's pass bar (no/justified visual flags AND zero structural 🔴). Network access to ${previewHost} is available.`;

const auditTask =
  `Audit ${url} — run stardust:audit in full, hands-off: read /workspace/skills/stardust/audit/SKILL.md and follow it ` +
  `(all phases; use the skill's degradation ladder — no refero MCP and no marketing-skills plugin here, so their built-in ` +
  `fallbacks apply; skip PageSpeed gracefully if unreachable; Playwright is preinstalled). If a recent extraction exists under ` +
  `stardust/current (restored workspace), reuse it per the skill's freshness rule instead of re-crawling.\n` +
  `When the audit completes:\n` +
  `1. Copy stardust/audit/<domain-slug>/audit.json and report.html to ${outputsDir}/audit/ (keep file names; also copy any assets report.html references, keeping relative paths).\n` +
  `2. upload_artifact audit/report.html, audit/audit.json, and each copied asset.\n` +
  `3. reply_to_user the scorecard (overall + seven dimensions) and the top P1 findings, in clean Markdown.\n` +
  `4. Finish with emit_milestone(phase="audit", event="done", data={"report":"audit/report.html","json":"audit/audit.json",` +
  `"overall":<0-100>,"scores":{"<dimension>":<score>, …}}) — scores straight from audit.json.\n` +
  `If the audit cannot complete (extract fails entirely), emit_milestone(phase="audit", event="failed", data={"message":"<reason>"}).`;

// ---- terminal + restore per mode -------------------------------------------

let task;
let doneHint;
let initialMessages;

/** Restore a job's inputs concurrently — the model can't start until these land,
 *  so serial round-trips sit on the critical path of every interactive job. */
const restoreJobInputs = () =>
  Promise.all([
    ingest.download(variantFile, `${outputsDir}/${variantFile}`).catch(() => {}),
    ...CTX_FILES.map((f) => ingest.download(`_ctx/${f}`, `${ctxDir}/${f}`).catch(() => {})),
  ]);

if (mode === "iterate") {
  task = iterateTask;
  doneHint = `Finish now: if it was a question, answer it and call emit_milestone(phase="iterate", event="answer"); if a change, upload the updated ${variantFile} and call emit_milestone(phase="iterate", event="done").`;
  await restoreJobInputs();
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
  await restoreJobInputs();
  pointImpeccableContext();
} else if (mode === "template") {
  task = templateTask;
  doneHint = `Finish now: upload <slug>-proposed.html and call emit_milestone(phase="template", event="page_done", data={"slug":...,"file":...}); or emit_milestone(phase="template", event="answer") for a question.`;
  await restoreBundle();
  pinVariant(variantId);
  pointImpeccableContext();
} else if (mode === "build") {
  task = buildTask;
  doneHint = `Finish now: upload ${variantFile} (+ thumb) and call emit_milestone(phase="prototype", event="variant_done", data={"variant":"${variantId}","file":"${variantFile}"}).`;
  await restoreBundle();
  pinVariant(variantId);
  pointImpeccableContext();
} else if (mode === "deploy") {
  task = deployTask;
  doneHint = `Finish now: upload every _eds/ file and call emit_milestone(phase="deploy", event="bundle_ready", data={"pages":[…]}).`;
  // The native deploy skill wants the project context (brand tokens, DESIGN,
  // captures) — restore the workspace bundle and pin the shipped variant.
  await restoreBundle();
  if (env.VARIANT_ID) pinVariant(env.VARIANT_ID);
  // Best-effort restore of inputs (locally the outputs mount already has them):
  // the page prototypes, plus the existing _eds manifest + block CSS for an
  // incremental deploy.
  await Promise.all(deployPages.map((p) => ingest.download(p.file, `${outputsDir}/${p.file}`).catch(() => {})));
  const prevManifest = await ingest.downloadJSON("_eds/manifest.json").catch(() => null);
  if (prevManifest) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(`${outputsDir}/_eds`, { recursive: true }).catch(() => {});
    await writeFile(`${outputsDir}/_eds/manifest.json`, JSON.stringify(prevManifest, null, 2)).catch(() => {});
    for (const b of prevManifest.blocks ?? []) {
      await ingest.download(`_eds/code/blocks/${b}/${b}.css`, `${outputsDir}/_eds/code/blocks/${b}/${b}.css`).catch(() => {});
      await ingest.download(`_eds/code/blocks/${b}/${b}.js`, `${outputsDir}/_eds/code/blocks/${b}/${b}.js`).catch(() => {});
    }
    await ingest.download("_eds/code/styles/styles.css", `${outputsDir}/_eds/code/styles/styles.css`).catch(() => {});
  }
} else if (mode === "verify") {
  task = verifyTask;
  doneHint = `Finish now: emit_milestone(phase="deploy", event="verify_page", …) for any page not yet reported, then emit_milestone(phase="deploy", event="verified", data={"ok":…}).`;
  await Promise.all(deployPages.map((p) => ingest.download(p.file, `${outputsDir}/${p.file}`).catch(() => {})));
} else if (mode === "audit") {
  task = auditTask;
  doneHint = `Finish now: upload audit/report.html + audit/audit.json and call emit_milestone(phase="audit", event="done", data={…scores…}) — or event="failed" with the reason.`;
  await restoreBundle(); // best-effort: lets the skill reuse a fresh extraction
} else if (stage === "direct") {
  task = directTask;
  doneHint = `Finish now: emit_milestone(phase="direct", event="variants_ready", data={"sharedFixes":[…],"variants":[…]}) with the three directions.`;
} else {
  task = upliftTask;
}

const terminal = (name, args) => {
  if (name !== "emit_milestone") return false;
  const p = args?.phase, e = args?.event;
  if (mode === "iterate") return p === "iterate" && (e === "done" || e === "answer");
  if (mode === "variant") return p === "variant" && (e === "added" || e === "answer");
  if (mode === "template") return p === "template" && (e === "page_done" || e === "answer");
  if (mode === "build") return p === "prototype" && e === "variant_done";
  if (mode === "deploy") return p === "deploy" && e === "bundle_ready";
  if (mode === "verify") return p === "deploy" && e === "verified";
  if (mode === "audit") return p === "audit" && (e === "done" || e === "failed");
  if (stage === "direct") return p === "direct" && e === "variants_ready";
  return p === "done";
};

// The watcher only helps long uplift phases (extract/direct emit late); short
// post-run jobs have reliable terminal milestones.
const stopWatcher = mode === "uplift" ? startMarkerWatcher() : null;
// The status tailer relays the plugin's own run contract for every job that
// runs skills (everything but iterate's surgical edit, which is impeccable-only).
const stopStatus = mode !== "iterate" ? startStatusTailer() : null;

try {
  await ingest.event({ type: "narration", text:
    mode === "iterate" ? `${provider.name} ${provider.model} — variant ${variantId}: ${instruction}`
    : mode === "variant" ? `${provider.name} ${provider.model} — new direction ${variantName}: ${instruction}`
    : mode === "template" ? `${provider.name} ${provider.model} — prototyping ${pageTitle || slug || "a page"} in variant ${variantId}`
    : mode === "build" ? `${provider.name} ${provider.model} — crafting variant ${variantId}`
    : mode === "deploy" ? `${provider.name} ${provider.model} — converting ${deployPages.length} page(s) to Edge Delivery`
    : mode === "verify" ? `${provider.name} ${provider.model} — verifying ${deployPages.length} deployed page(s) against the prototypes`
    : mode === "audit" ? `${provider.name} ${provider.model} — auditing ${url}`
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

  stopWatcher?.();
  stopStatus?.();

  // Backstop: never strand the UI in "loading" if the loop ended without a
  // terminal milestone. Default each mode to an honest terminal event.
  if (!done) {
    const ev =
      mode === "iterate" ? { phase: "iterate", event: "done", variant: variantId, file: variantFile }
      : mode === "variant" ? { phase: "variant", event: "failed", message: "the direction wasn't produced" }
      : mode === "template" ? { phase: "template", event: "page_failed", slug: slug || tSlug, message: "the page wasn't rendered" }
      : mode === "build" ? { phase: "prototype", event: "variant_failed", variant: variantId, message: "the variant wasn't built" }
      : mode === "deploy" ? { phase: "deploy", event: "failed", message: "the conversion didn't finish" }
      : mode === "verify" ? { phase: "deploy", event: "verified", ok: false, message: "the verify didn't finish" }
      : mode === "audit" ? { phase: "audit", event: "failed", message: "the audit didn't finish" }
      : stage === "direct" ? { phase: "failed", message: "the directions weren't composed" }
      : { phase: "done" };
    await ingest.event(ev).catch(() => {});
  }

  // End-of-run snapshots: the design context (iterate/variant restore it) + the
  // whole workspace bundle (build/template jobs restore it) + discovered pages.
  // In the parallel pipeline this runs at the end of phase 1; the deterministic
  // bundle_ready event is the DO's fan-out signal (workers need the bundle).
  if (mode === "uplift") {
    await Promise.all(CTX_FILES.map((f) => ingest.uploadFrom(`_ctx/${f}`, `${ctxDir}/${f}`).catch(() => {})));
    const pages = derivePages(`${workdir}/stardust/current/pages`, url);
    if (pages.length) await ingest.event({ phase: "extract", event: "pages", pages }).catch(() => {});
    await bundleWorkspace();
    if (stage === "direct" && done) await ingest.event({ phase: "direct", event: "bundle_ready" });
  }
  // A new direction changed the workspace (new DESIGN-<name>) — re-bundle so
  // later template jobs can render pages in it too.
  if (mode === "variant" && done) await bundleWorkspace();
  // A-first canon freeze: variant A's build re-snapshots the bundle (its canon
  // + rendered structure) so the B/C workers — dispatched after A settles —
  // fork a consistent skeleton instead of each inventing their own.
  if (mode === "build" && done && variantId === "A") await bundleWorkspace();

  console.log(`runtime finished: mode=${mode}${stage ? `/${stage}` : ""} done=${done} calls=${usage.calls} tokens=${usage.total}`);
} catch (e) {
  stopWatcher?.();
  stopStatus?.();
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
      : mode === "build" ? { phase: "prototype", event: "variant_failed", variant: variantId, message }
      : mode === "deploy" ? { phase: "deploy", event: "failed", message }
      : mode === "verify" ? { phase: "deploy", event: "verified", ok: false, message }
      : mode === "audit" ? { phase: "audit", event: "failed", message }
      : { phase: "failed", message };
    await ingest.event(ev);
    reported = true;
  } catch { /* fall through to non-zero exit */ }
  process.exit(reported ? 0 : 1);
}
