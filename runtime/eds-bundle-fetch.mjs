/* ===========================================================================
   Restore a run's _eds/ bundle from the Worker's ingest bridge (R2) onto local
   disk. Prod publish runs in a Cloudflare Container with an ephemeral disk —
   the deploy conversion job uploaded every _eds/ file as an artifact, so the
   bundle is re-materialised here before eds-publish.mjs pushes it out.
   =========================================================================== */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchRetry } from "./fetch-retry.mjs";

/** Download every artifact under _eds/ into destDir (keeping relative paths).
 *  Returns the file count; throws when the run has no uploaded bundle. */
export async function fetchEdsBundle({ ingestBase, runId, token, destDir }) {
  const auth = { authorization: `Bearer ${token}` };
  const lr = await fetchRetry(
    `${ingestBase}/api/ingest/${runId}/artifacts?prefix=${encodeURIComponent("_eds/")}`,
    { headers: auth }, { tries: 3, label: "eds bundle list" });
  if (!lr.ok) throw new Error(`bundle list failed: ${lr.status}`);
  const { paths } = await lr.json();
  if (!paths?.length) throw new Error("no _eds/ bundle uploaded for this run — run the deploy conversion first");
  for (const rel of paths) {
    const encoded = rel.split("/").map(encodeURIComponent).join("/");
    const r = await fetchRetry(`${ingestBase}/api/ingest/${runId}/artifact/${encoded}`,
      { headers: auth }, { tries: 3, label: `eds bundle get ${rel}` });
    if (!r.ok) throw new Error(`bundle fetch failed for ${rel}: ${r.status}`);
    const file = join(destDir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(await r.arrayBuffer()));
  }
  return paths.length;
}
