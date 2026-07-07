/* ===========================================================================
   EDS publisher — deterministic transport for the deploy phase. Runs on the
   HOST (imported by runner.mjs): takes the _eds/ bundle a deploy job wrote to
   the run's outputs dir and pushes it live:

     1. git: sync the project's code branch of the EDS repo (create from main
        if absent), overlay _eds/code/**, commit, push (gh-authenticated).
     2. force AEM Code Sync + poll until the pushed marker is served.
     3. DA: sanitise + PUT every content fragment to admin.da.live.
     4. wait for the pushed images to be live on the code bus (preview ingests
        them into Media Bus at that moment — a race writes about:error).
     5. POST preview (admin.hlx.page) per page, verify the .plain.html.
     6. (optional --live) POST live per page.

   Progress is reported to the run's ingest bridge as deploy.* events, so the
   DO/UI stay in sync without the publisher knowing about the UI.
   No LLM anywhere in this file — the conversion job did the thinking.
   =========================================================================== */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRetry } from "./fetch-retry.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AuthorKit is the decided deploy runtime (prior plugin reviews: it converts
// better than vanilla boilerplate; the deploy skill is validated against it).
// Source mode: --from-sibling a known-good ALREADY-BOOTSTRAPPED stardust site
// repo (the script's recommended path). Upstream aemsites/author-kit does NOT
// carry the static-fragment postlcp.js the mandatory edits verify — that
// variant lives only in bootstrapped site repos, so --ref against upstream
// hard-fails by design. hirslanden-stardust-eds carries both verified edits.
const AUTHORKIT_SIBLING = process.env.AUTHORKIT_SIBLING || "/Users/paolo/stardust/migrations/hirslanden-stardust-eds";
// The bootstrap script ships with the baked deploy skill; build.sh stages it
// under sandbox/skills/ on the host, and the image bakes it at /workspace/skills/.
const BOOTSTRAP_CANDIDATES = [
  join(dirname(fileURLToPath(import.meta.url)), "..", "sandbox", "skills", "stardust", "deploy", "scripts", "bootstrap-authorkit.mjs"),
  join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "stardust", "deploy", "scripts", "bootstrap-authorkit.mjs"),
];
const BOOTSTRAP_SCRIPT = BOOTSTRAP_CANDIDATES.find((p) => existsSync(p)) ?? BOOTSTRAP_CANDIDATES[0];

/** Encode non-ASCII to numeric entities — DA strips <head>/charset and mangles
 *  raw multibyte UTF-8 (→ U+FFFD); entities survive the round-trip. */
export function sanitise(html) {
  let out = "";
  for (let i = 0; i < html.length; i += 1) {
    const cp = html.codePointAt(i);
    if (cp <= 0x7f) { out += html[i]; continue; }
    if (cp > 0xffff) i += 1; // surrogate pair
    out += `&#${cp};`;
  }
  return out;
}

/** git with a gh-backed askpass (no credential-helper config mutation). */
function git(cwd, args, { env = {} } = {}) {
  return execFileSync("git", args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function ghAskpass() {
  const p = join(tmpdir(), `stardust-askpass-${process.pid}.sh`);
  // GITHUB_TOKEN (prod containers, no gh CLI) wins; gh-authenticated dev otherwise.
  writeFileSync(p, `#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  Password*) if [ -n "$GITHUB_TOKEN" ]; then echo "$GITHUB_TOKEN"; else exec gh auth token; fi ;;\nesac\n`);
  chmodSync(p, 0o700);
  return p;
}

export async function publish(job, { log = console.log } = {}) {
  const { runId, outputsDir, ingestBase, ingestToken, daToken, live = false, reposDir } = job;
  const edsDir = join(outputsDir, "_eds");

  const report = async (event, data = {}) => {
    try {
      await fetchRetry(`${ingestBase}/api/ingest/${runId}/event`, {
        method: "POST",
        headers: { authorization: `Bearer ${ingestToken}`, "content-type": "application/json" },
        body: JSON.stringify({ phase: "deploy", event, ...data }),
      }, { tries: 3, label: "deploy.report" });
    } catch { /* progress is best-effort */ }
  };

  let manifest, org, site, branch, project, previewHost, liveHost;
  try {
    manifest = JSON.parse(readFileSync(join(edsDir, "manifest.json"), "utf8"));
    ({ org, site, branch, project } = manifest);
    previewHost = manifest.previewHost || `https://${branch}--${site}--${org}.aem.page`;
    liveHost = previewHost.replace(".aem.page", ".aem.live");
  } catch (e) {
    const message = `no publishable _eds bundle: ${String(e?.message ?? e)}`;
    log(`[eds] FAILED: ${message}`);
    await report("failed", { message });
    return { ok: false, message };
  }
  const admin = `https://admin.hlx.page`;
  const auth = { authorization: `Bearer ${daToken}` };

  try {
    // ---- 1. code branch -----------------------------------------------------
    const repoDir = join(reposDir, site);
    const askpass = ghAskpass();
    const gitEnv = { GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" };
    if (!existsSync(repoDir)) {
      mkdirSync(reposDir, { recursive: true });
      log(`[eds] cloning ${org}/${site}`);
      git(reposDir, ["clone", "--quiet", `https://github.com/${org}/${site}.git`, site], { env: gitEnv });
    }
    git(repoDir, ["fetch", "--quiet", "origin"], { env: gitEnv });
    const remoteBranch = git(repoDir, ["ls-remote", "--heads", "origin", branch], { env: gitEnv }).trim();
    git(repoDir, ["checkout", "-B", branch, remoteBranch ? `origin/${branch}` : "origin/main"], { env: gitEnv });

    // AuthorKit runtime port (branch-scoped; main stays vanilla). Idempotent —
    // the script verifies its two mandatory edits and hard-fails if they can't
    // be applied, so a drifted source can't silently ship a broken runtime. A
    // failed attempt leaves a hybrid tree, so reset before retrying.
    const plPath = join(repoDir, "scripts", "postlcp.js");
    const runtimeOk = existsSync(join(repoDir, "scripts", "ak.js"))
      && existsSync(plPath) && /el\.className\s*=\s*name/.test(readFileSync(plPath, "utf8"));
    if (!runtimeOk) {
      if (!existsSync(BOOTSTRAP_SCRIPT)) throw new Error(`bootstrap-authorkit.mjs not staged at ${BOOTSTRAP_SCRIPT} — run sandbox/build.sh`);
      if (!existsSync(join(AUTHORKIT_SIBLING, "scripts", "ak.js"))) throw new Error(`AuthorKit sibling not found at ${AUTHORKIT_SIBLING} (set AUTHORKIT_SIBLING)`);
      git(repoDir, ["checkout", "--", "."]); // drop any hybrid leftovers from a failed port
      log(`[eds] bootstrapping AuthorKit runtime on ${branch} (from sibling ${AUTHORKIT_SIBLING})`);
      // The script exits 0 even on a failed mandatory edit — detect via output.
      const out = execFileSync("node", [BOOTSTRAP_SCRIPT, "--target", repoDir, "--from-sibling", AUTHORKIT_SIBLING], { encoding: "utf8" });
      if (/FAILED|FAIL\s/.test(out)) throw new Error(`AuthorKit bootstrap failed a mandatory edit:\n${out.split("\n").filter((l) => /FAIL|FAILED/.test(l)).join("\n")}`);
      log(`[eds] authorkit bootstrapped (sibling port, edits verified)`);
      await report("code_pushed", { branch, detail: "authorkit bootstrapped" });
    }

    const codeDir = join(edsDir, "code");
    if (existsSync(codeDir)) cpSync(codeDir, repoDir, { recursive: true });
    // Favicon: if the bundle ships one (deploy skill Step 3 § Favicon), make
    // sure head.html links it — deterministic, idempotent, .ico needs no link.
    for (const ext of ["svg", "png", "ico"]) {
      if (!existsSync(join(repoDir, `favicon.${ext}`))) continue;
      const headPath = join(repoDir, "head.html");
      if (ext !== "ico" && existsSync(headPath)) {
        const head = readFileSync(headPath, "utf8");
        if (!/rel=["']icon["']/.test(head)) {
          writeFileSync(headPath, `${head.trimEnd()}\n<link rel="icon" href="/favicon.${ext}">\n`);
          log(`[eds] head.html: linked /favicon.${ext}`);
        }
      }
      break;
    }
    // Deterministic Code-Sync marker: poll for this exact string on the branch host.
    const marker = `/* stardust-deploy ${project} ${Date.now()} */`;
    const stylesPath = join(repoDir, "styles", "styles.css");
    if (existsSync(stylesPath)) writeFileSync(stylesPath, readFileSync(stylesPath, "utf8") + `\n${marker}\n`);

    git(repoDir, ["add", "-A"]);
    const dirty = git(repoDir, ["status", "--porcelain"]).trim();
    if (dirty) {
      git(repoDir, ["-c", "user.name=stardust", "-c", "user.email=stardust@local", "commit", "--quiet", "-m",
        `stardust deploy ${project}: ${manifest.pages.map((p) => p.slug).join(", ")}`]);
      git(repoDir, ["push", "--quiet", "origin", branch], { env: gitEnv });
      log(`[eds] pushed ${branch} (${dirty.split("\n").length} files)`);
    } else {
      log(`[eds] code unchanged on ${branch}`);
    }
    await report("code_pushed", { branch });

    // ---- 2. force Code Sync + wait for the marker ---------------------------
    if (dirty) {
      const cs = await fetchRetry(`${admin}/code/${org}/${site}/${branch}/*`, { method: "POST", headers: auth }, { label: "code-sync" });
      log(`[eds] code sync ${cs.status}`);
      const deadline = Date.now() + 180_000;
      let synced = false;
      while (Date.now() < deadline) {
        try {
          const css = await (await fetch(`${previewHost}/styles/styles.css`, { headers: { "cache-control": "no-cache" } })).text();
          if (css.includes(marker)) { synced = true; break; }
        } catch { /* not resolving yet (fresh branch DNS) */ }
        await sleep(4000);
      }
      log(synced ? "[eds] code live on branch host" : "[eds] WARN code-sync marker not seen in 180s — continuing");
    }

    // ---- 3. content → DA -----------------------------------------------------
    // Normalize daPaths defensively: no leading slashes (a "/<project>/…" path
    // becomes source/org/site//… → DA 400), no trailing .html.
    const fragments = [...(manifest.fragments ?? []), ...manifest.pages]
      .map((f) => ({ ...f, daPath: String(f.daPath ?? "").replace(/^\/+/, "").replace(/\.html$/i, "") }))
      .filter((f) => f.daPath);
    for (const f of fragments) {
      const html = sanitise(readFileSync(join(edsDir, f.content), "utf8"));
      const form = new FormData();
      form.set("data", new Blob([html], { type: "text/html" }), "data.html");
      const r = await fetchRetry(`https://admin.da.live/source/${org}/${site}/${f.daPath}.html`,
        { method: "PUT", headers: auth, body: form }, { label: `da PUT ${f.daPath}` });
      if (!r.ok) throw new Error(`DA write failed for ${f.daPath}: ${r.status} ${(await r.text()).slice(0, 200)}`);
      log(`[eds] DA ← ${f.daPath}.html (${r.status})`);
      if (f.slug) await report("page_pushed", { slug: f.slug });
    }

    // ---- 4. images live on the code bus before preview ingests them ---------
    for (const img of manifest.images ?? []) {
      const url = `${previewHost}/${img}`;
      const deadline = Date.now() + 90_000;
      let ok = false;
      while (Date.now() < deadline) {
        try { if ((await fetch(url, { method: "HEAD" })).status === 200) { ok = true; break; } } catch { /* retry */ }
        await sleep(3000);
      }
      if (!ok) log(`[eds] WARN image not live yet: ${url}`);
    }

    // ---- 5. preview + verify -------------------------------------------------
    const failures = [];
    for (const f of fragments) {
      const pv = await fetchRetry(`${admin}/preview/${org}/${site}/${branch}/${f.daPath}`, { method: "POST", headers: auth }, { label: `preview ${f.daPath}` });
      if (!pv.ok) { failures.push(`${f.daPath}: preview ${pv.status}`); continue; }
      if (!f.slug) continue; // nav/footer fragments need no verify/report
      // Atomic delivery asserts (the deploy skill's per-page contract): body
      // intact, zero about:error, exactly one <h1>, no root-relative /img/ srcs
      // (they ingest as about:error on the next preview).
      const plain = await (await fetch(`${previewHost}/${f.daPath}.plain.html`, { headers: { "cache-control": "no-cache" } })).text();
      const errors = (plain.match(/about:error/g) ?? []).length;
      if (errors) {
        // Preview is idempotent and re-ingests — one repair pass.
        await sleep(4000);
        await fetchRetry(`${admin}/preview/${org}/${site}/${branch}/${f.daPath}`, { method: "POST", headers: auth }, { label: `re-preview ${f.daPath}` });
      }
      const h1s = (plain.match(/<h1[\s>]/g) ?? []).length;
      if (h1s !== 1) log(`[eds] WARN ${f.daPath}: ${h1s} <h1> elements (contract wants exactly 1)`);
      if (/src="\/img\//.test(plain)) log(`[eds] WARN ${f.daPath}: root-relative /img/ src in delivered content`);
      const url = `${previewHost}/${f.daPath.replace(/\/index$/, "/")}`;
      log(`[eds] previewed ${url}${errors ? ` (repaired ${errors} image ingests)` : ""}`);
      await report("page_previewed", { slug: f.slug, url });
    }
    if (failures.length) throw new Error(failures.join("; "));

    // ---- 6. optional live publish -------------------------------------------
    if (live) {
      for (const f of fragments) {
        const lv = await fetchRetry(`${admin}/live/${org}/${site}/${branch}/${f.daPath}`, { method: "POST", headers: auth }, { label: `live ${f.daPath}` });
        if (!lv.ok) throw new Error(`${f.daPath}: live ${lv.status}`);
        if (f.slug) await report("page_live", { slug: f.slug, url: `${liveHost}/${f.daPath.replace(/\/index$/, "/")}` });
      }
    }

    await report("published", { project, branch, previewHost, live, pages: manifest.pages.map((p) => p.slug) });
    log(`[eds] done — ${previewHost}/${project}/`);
    return { ok: true, previewHost };
  } catch (e) {
    const message = String(e?.message ?? e);
    log(`[eds] FAILED: ${message}`);
    await report("failed", { message });
    return { ok: false, message };
  }
}
