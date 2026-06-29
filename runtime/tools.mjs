/* ===========================================================================
   Tools the agent can call. Shell + file editing run locally in the sandbox;
   emit_milestone / upload_artifact are STRUCTURED tools the loop forwards to the
   ingest bridge — so progress/uploads are reliable (the model can't "forget to
   curl" — it just calls a tool, and we do the HTTP).
   =========================================================================== */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const sh = promisify(execFile);
const MAX = 24_000;
const cut = (s) => (s.length > MAX ? s.slice(0, MAX) + `\n…[truncated ${s.length - MAX} chars]` : s);

export const TOOL_SPECS = [
  { type: "function", function: { name: "run_bash", description: "Run a bash command in the sandbox; returns combined stdout+stderr (truncated). Use for anything not covered by the file tools (node, playwright, git, ls, etc.).", parameters: { type: "object", properties: { command: { type: "string" }, cwd: { type: "string", description: "working directory (default /workspace)" } }, required: ["command"] } } },
  { type: "function", function: { name: "read_file", description: "Read a UTF-8 file.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "write_file", description: "Write a UTF-8 file (creates parent dirs, overwrites).", parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] } } },
  { type: "function", function: { name: "edit_file", description: "Replace the first occurrence of old_str with new_str in a file.", parameters: { type: "object", properties: { path: { type: "string" }, old_str: { type: "string" }, new_str: { type: "string" } }, required: ["path", "old_str", "new_str"] } } },
  { type: "function", function: { name: "emit_milestone", description: "Push a progress milestone to the live web UI. Call the INSTANT a phase boundary happens. Shapes: extract.started; extract.seed{seed}; extract.tensions{items:[{n,text}]}; extract.brand_ready{brandReview}; direct.variants_ready{sharedFixes,variants:[{id,title,pitch,whatif,role,file,thumb}]}; prototype.variant_done{variant}; done.", parameters: { type: "object", properties: { phase: { type: "string" }, event: { type: "string" }, data: { type: "object", description: "the milestone payload fields for this phase/event" } }, required: ["phase"] } } },
  { type: "function", function: { name: "upload_artifact", description: "Upload one deliverable to the UI by its path relative to /mnt/session/outputs (e.g. brand-review.html, assets/thumb-A.png). Upload the brand surface as soon as it exists and each variant as it finishes.", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
];

export function makeTools({ workdir, outputsDir, ingest }) {
  return {
    async run_bash({ command, cwd }) {
      try {
        const { stdout, stderr } = await sh("bash", ["-lc", command], { cwd: cwd || workdir, maxBuffer: 16 * 1024 * 1024, timeout: 180_000 });
        return cut((stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "")) || "(no output)";
      } catch (e) {
        return cut(`[exit ${e.code ?? "?"}] ${e.message}\n${e.stdout || ""}\n${e.stderr || ""}`);
      }
    },
    async read_file({ path }) {
      try { return cut(await readFile(path, "utf8")); } catch (e) { return `[error] ${e.message}`; }
    },
    async write_file({ path, content }) {
      try { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content ?? ""); return `wrote ${path} (${(content ?? "").length}B)`; } catch (e) { return `[error] ${e.message}`; }
    },
    async edit_file({ path, old_str, new_str }) {
      try {
        const s = await readFile(path, "utf8");
        if (!s.includes(old_str)) return `[error] old_str not found in ${path}`;
        await writeFile(path, s.replace(old_str, new_str));
        return `edited ${path}`;
      } catch (e) { return `[error] ${e.message}`; }
    },
    async emit_milestone({ phase, event, data }) {
      try { await ingest.event({ phase, event, ...(data || {}) }); return `milestone ${phase}.${event ?? ""} sent`; } catch (e) { return `[error] ${e.message}`; }
    },
    async upload_artifact({ path }) {
      try { return await ingest.artifact(path); } catch (e) { return `[error] ${e.message}`; }
    },
  };
}

export const LOCAL_TOOLS = new Set(["run_bash", "read_file", "write_file", "edit_file"]);
