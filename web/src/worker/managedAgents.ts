/* ===========================================================================
   Minimal Anthropic Managed Agents client (the bits the Worker needs):
   create a session, send a user message, and stream the session's SSE events.
   Docs: POST /v1/sessions, POST /v1/sessions/:id/events, GET /v1/sessions/:id/stream
   beta header: managed-agents-2026-04-01
   =========================================================================== */
const API = "https://api.anthropic.com/v1";
const BETA = "managed-agents-2026-04-01";

export interface MaCreds {
  apiKey: string;
  agentId: string;
  environmentId: string;
}

/** Subset of Managed Agents session events we map to the UI. */
export type SessionEvent =
  | { type: "agent.message"; content: { type: string; text?: string }[] }
  | { type: "agent.tool_use"; name: string }
  | { type: "session.status_idle"; [k: string]: unknown }
  | { type: "session.status_terminated"; [k: string]: unknown }
  | { type: string; [k: string]: unknown };

function headers(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": BETA,
    ...extra,
  };
}

export async function createSession(c: MaCreds, title: string, metadata?: Record<string, string>): Promise<string> {
  const res = await fetch(`${API}/sessions`, {
    method: "POST",
    headers: headers(c.apiKey, { "content-type": "application/json" }),
    body: JSON.stringify({ agent: c.agentId, environment_id: c.environmentId, title, metadata }),
  });
  if (!res.ok) throw new Error(`createSession ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { id: string }).id;
}

export async function sendUserMessage(c: MaCreds, sessionId: string, text: string): Promise<void> {
  const res = await fetch(`${API}/sessions/${sessionId}/events?beta=true`, {
    method: "POST",
    headers: headers(c.apiKey, { "content-type": "application/json" }),
    body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text }] }] }),
  });
  if (!res.ok) throw new Error(`sendUserMessage ${res.status}: ${await res.text()}`);
}

/** Open the SSE stream and yield parsed session events until the caller stops. */
export async function* streamEvents(c: MaCreds, sessionId: string): AsyncGenerator<SessionEvent> {
  const res = await fetch(`${API}/sessions/${sessionId}/events/stream?beta=true`, {
    headers: headers(c.apiKey, { Accept: "text/event-stream" }),
  });
  if (!res.ok || !res.body) throw new Error(`streamEvents ${res.status}: ${await res.text()}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        yield JSON.parse(json) as SessionEvent;
      } catch {
        /* skip non-JSON keepalives */
      }
    }
  }
}
