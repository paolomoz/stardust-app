/* ===========================================================================
   Ingest client — the same bridge the Managed Agents path used: push milestones
   + deliverables to the Worker, which fans them to R2 + the Durable Object + UI.
   Reused verbatim so the new runtime is a drop-in brain for the existing UI.
   =========================================================================== */
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const MIME = {
  ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff",
  ".gif": "image/gif", ".ico": "image/x-icon", ".txt": "text/plain",
};

export function makeIngest({ base, runId, token, outputsDir }) {
  const root = `${base}/api/ingest/${runId}`;
  const auth = { authorization: `Bearer ${token}` };
  return {
    /** Push a milestone / narration / tool event (the DO maps these to UI events). */
    async event(obj) {
      const r = await fetch(`${root}/event`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(obj) });
      if (!r.ok) throw new Error(`ingest event ${r.status}: ${(await r.text()).slice(0, 200)}`);
    },
    /** Upload a deliverable by its path relative to the outputs dir -> R2. */
    async artifact(rel) {
      const clean = String(rel).replace(/^\/+/, "");
      const body = await readFile(join(outputsDir, clean));
      const ct = MIME[extname(clean).toLowerCase()] || "application/octet-stream";
      const r = await fetch(`${root}/artifact/${clean}`, { method: "PUT", headers: { ...auth, "content-type": ct }, body });
      if (!r.ok) throw new Error(`ingest artifact ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return `uploaded ${clean} (${body.length}B)`;
    },
  };
}
