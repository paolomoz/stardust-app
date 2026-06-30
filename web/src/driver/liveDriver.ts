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
      store.set({ screen: ev.screen });
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
        if (!s.messages.some((m) => m.id === ev.message.id)) s.messages = [...s.messages, ev.message];
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
    case "rail":
      store.set({ rail: ev.rail });
      break;
    case "busy":
      // Starting new work clears any stale estimate from the previous task.
      store.set(ev.value ? { agentBusy: true, eta: undefined } : { agentBusy: false });
      break;
    case "eta":
      store.set({ eta: { seconds: ev.seconds, at: Date.now() } });
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
}

/** Landing → start a run: create it, then stream its events over the WS.
 *  mode "agent" runs a real Managed Agents session; default "scripted" (demo). */
export async function beginRun(url: string, mode: "scripted" | "agent" | "probe" | "uplift" | "cerebras" | "bedrock" = "scripted"): Promise<void> {
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
  openSocket(id);
}

/** Reopen a finished run by id (/?run=<id>) — connect to its DO, which replays
 *  the saved timeline from D1. No new run is created (no agent cost). */
export function reopenRun(runId: string): void {
  resetRun();
  openSocket(runId);
}

function openSocket(id: string): void {
  ws = new WebSocket(wsUrl(id));
  ws.addEventListener("message", (e) => {
    try {
      const data = JSON.parse(typeof e.data === "string" ? e.data : "");
      if (isServerEvent(data)) apply(data);
    } catch {
      /* ignore malformed frames */
    }
  });
}

export const navTo = (to: ScreenId) => command({ t: "nav", to });
export const openVariant = (variant: VariantId) => command({ t: "open", variant });
export const selectVariant = (variant: VariantId) => command({ t: "select", variant });
export const cancelRun = () => command({ t: "cancel" });
export const sendMessage = (screen: ScreenId, text: string) => command({ t: "send", screen, text });

export function resetRun(): void {
  if (ws) {
    ws.close();
    ws = null;
  }
  store.reset();
}
