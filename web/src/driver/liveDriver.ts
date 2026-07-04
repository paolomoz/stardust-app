/* ===========================================================================
   Live driver — the M2+ transport. Replaces the mock driver: starts a run via
   the Worker API, opens a WebSocket to the run's RunSession Durable Object, and
   applies streamed ServerEvents to the same store the screens render from.
   User intents go back as ClientCommands. The store/screens are unchanged.
   =========================================================================== */
import { store } from "../state";
import type { ScreenId, VariantId } from "../state";
import type { ClientCommand, ServerEvent } from "../shared/protocol";
import { isServerEvent } from "../shared/protocol";

let ws: WebSocket | null = null;
// Reconnect state: the DO replays the timeline + panels on every (re)connection
// and message.append is id-deduped, so a reconnect self-heals the store.
let wsRunId: string | null = null;
let closedByUs = false;
let retries = 0;
// Commands typed while the socket was down — flushed on (re)open instead of
// being silently dropped.
const pending: ClientCommand[] = [];

// Once the user (or a /?view= URL) picks a view, the client owns navigation —
// ignore the DO's own `screen` events so they can't yank the view back.
let viewLocked = false;
export function lockView(): void { viewLocked = true; }

function wsUrl(id: string): string {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}/api/runs/${id}/ws`;
}

function apply(ev: ServerEvent): void {
  switch (ev.t) {
    case "run.started":
      store.update((s) => {
        s.url = ev.url;
        s.projectName = ev.projectName;
        s.seed = ev.seed;
      });
      break;
    case "phase":
      store.set({ phase: ev.phase });
      break;
    case "screen":
      if (!viewLocked) store.set({ screen: ev.screen });
      break;
    case "tasks.init":
      store.set({ tasks: ev.tasks });
      break;
    case "task":
      store.update((s) => {
        const t = s.tasks.find((x) => x.id === ev.id);
        if (t) t.status = ev.status;
      });
      break;
    case "status":
      store.set({ statusTicker: ev.text });
      break;
    case "progress":
      store.set({ progress: ev.value });
      break;
    case "snapshot.ready":
      store.set({ snapshotReady: true });
      break;
    case "messages":
      store.set({ messages: ev.messages });
      break;
    case "message.append":
      store.update((s) => {
        if (s.messages.some((m) => m.id === ev.message.id)) return; // idempotent by id
        s.messages = [...s.messages, ev.message];
        if (ev.message.artifact) s.lastArtifact = { ref: ev.message.artifact, at: Date.now() };
      });
      break;
    case "panel.brand":
      store.update((s) => {
        s.brandReviewUrl = ev.brandReviewUrl;
        s.tensions = ev.tensions;
      });
      break;
    case "panel.variants":
      store.update((s) => {
        s.sharedFixes = ev.sharedFixes;
        s.variants = ev.variants;
      });
      break;
    case "panel.workspace":
      store.update((s) => {
        s.activeVariant = ev.activeVariant;
        if (ev.variants.length) s.variants = ev.variants;
      });
      break;
    case "panel.pages":
      store.set({ pageCandidates: ev.pages });
      break;
    case "panel.templates":
      store.update((s) => {
        s.templates = ev.templates;
        if (ev.protoVariant) s.protoVariant = ev.protoVariant;
      });
      break;
    case "panel.deploy":
      store.set({ deploy: ev.deploy });
      break;
    case "panel.audit":
      store.set({ audit: ev.audit });
      break;
    case "rail":
      store.set({ rail: ev.rail });
      break;
    case "busy":
      // Starting new work clears any stale estimate from the previous task.
      store.set(ev.value ? { agentBusy: true, eta: undefined } : { agentBusy: false });
      break;
    case "eta":
      // `seconds` is the TOTAL estimate anchored at `startedAt` (run start), so
      // re-anchors mid-run and reopen both compute elapsed correctly. Fall back
      // to receipt time only when the server didn't send an anchor (iterate).
      store.set({ eta: { seconds: ev.seconds, at: ev.startedAt ?? Date.now() } });
      break;
    case "run.done":
      store.set({ agentBusy: false });
      break;
    case "error":
      console.error("[stardust] run error:", ev.message);
      store.set({ error: ev.message, agentBusy: false });
      break;
  }
}

function command(cmd: ClientCommand): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(cmd));
  else pending.push(cmd); // flushed on (re)connect
}

/** Landing → start a run: create it, then stream its events over the WS.
 *  "bedrock" = the real Opus run; "cerebras" = cheap demo model; "scripted" =
 *  the offline knack replay. */
export async function beginRun(url: string, mode: "scripted" | "cerebras" | "bedrock" = "bedrock"): Promise<void> {
  resetRun();
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, mode }),
  });
  if (!res.ok) {
    store.set({ messages: [{ id: "err", role: "agent", lead: "Could not start the run. Is the Worker running?" }] });
    return;
  }
  const { id } = (await res.json()) as { id: string };
  store.set({ live: true, runId: id }); // a fresh run → artifact "ready" toasts are wanted
  // Make the run bookmarkable/reload-safe the moment it exists — a reload of
  // /?run=<id> reopens this run live instead of landing on a blank home.
  try { history.replaceState(null, "", `/?run=${id}`); } catch { /* sandboxed iframe etc. */ }
  openSocket(id);
}

/** Publish an artifact → public /p/<token>. Returns the absolute share URL. */
export async function publishArtifact(runId: string, path: string, title?: string): Promise<string> {
  const r = await fetch(`/api/runs/${runId}/publish`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path, title }),
  });
  if (!r.ok) throw new Error("publish failed");
  const { url } = (await r.json()) as { url: string };
  return `${location.origin}${url}`;
}
export async function unpublishArtifact(runId: string, path: string): Promise<void> {
  await fetch(`/api/runs/${runId}/unpublish`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path }),
  });
}
export async function fetchPublished(runId: string): Promise<{ path: string; url: string }[]> {
  try {
    const r = await fetch(`/api/runs/${runId}/published`);
    const j = (await r.json()) as { published: { path: string; token: string }[] };
    return (j.published ?? []).map((p) => ({ path: p.path, url: `/p/${p.token}` }));
  } catch {
    return [];
  }
}

/** Reopen a finished run by id (/?run=<id>) — connect to its DO, which replays
 *  the saved timeline from D1. No new run is created (no agent cost). */
export function reopenRun(runId: string): void {
  resetRun();
  store.set({ runId });
  openSocket(runId);
}

function openSocket(id: string): void {
  wsRunId = id;
  closedByUs = false;
  retries = 0;
  connect();
}

function connect(): void {
  if (!wsRunId) return;
  const sock = new WebSocket(wsUrl(wsRunId));
  ws = sock;
  sock.addEventListener("open", () => {
    retries = 0;
    while (pending.length && sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(pending.shift()));
  });
  sock.addEventListener("message", (e) => {
    try {
      const data = JSON.parse(typeof e.data === "string" ? e.data : "");
      if (isServerEvent(data)) apply(data);
    } catch {
      /* ignore malformed frames */
    }
  });
  // Auto-reconnect with backoff: a DO eviction, network blip, or laptop sleep
  // must not freeze a 20-minute run's UI. (`error` is always followed by
  // `close`, so only `close` schedules the retry.)
  sock.addEventListener("close", () => {
    if (closedByUs || ws !== sock) return;
    ws = null;
    const delay = Math.min(15_000, 500 * 2 ** retries++) + Math.random() * 400;
    setTimeout(() => { if (!closedByUs && wsRunId) connect(); }, delay);
  });
}

export interface RunSummary {
  id: string;
  url: string;
  status: string;
  mode: string;
  project: string | null;
  created_at: number;
}

/** The signed-in user's runs (newest first) for the "Your runs" panel. */
export async function listRuns(): Promise<RunSummary[]> {
  try {
    const r = await fetch("/api/runs");
    if (!r.ok) return [];
    const j = (await r.json()) as { runs: RunSummary[] };
    return j.runs ?? [];
  } catch {
    return [];
  }
}

export const navTo = (to: ScreenId) => command({ t: "nav", to });
export const openVariant = (variant: VariantId) => command({ t: "open", variant });
export const selectVariant = (variant: VariantId) => command({ t: "select", variant });
export const cancelRun = () => command({ t: "cancel" });
export const sendMessage = (screen: ScreenId, text: string) => command({ t: "send", screen, text });
export const addVariant = (instruction: string) => command({ t: "addVariant", instruction });
export const prototypePages = (slugs: string[]) => command({ t: "prototype", slugs });
export const setProtoVariant = (variant: VariantId) => command({ t: "setProtoVariant", variant });
export const deployPages = (slugs: string[]) => command({ t: "deploy", slugs });
export const goLive = () => command({ t: "golive" });
export const rolloutSite = () => command({ t: "rollout" });
export const auditSite = (target: "original" | "deployed") => command({ t: "audit", target });

export function resetRun(): void {
  closedByUs = true;
  wsRunId = null;
  pending.length = 0;
  if (ws) {
    ws.close();
    ws = null;
  }
  viewLocked = false;
  store.reset();
}
