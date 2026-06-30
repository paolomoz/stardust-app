/* ===========================================================================
   Wire protocol — the typed contract between the RunSession Durable Object
   (server, the run's source of truth) and the client liveDriver. This is the
   formalized engine→UI event protocol: in M2 the DO scripts these events; in
   M5 the same events are derived from the agent's status.jsonl + artifacts.
   Imported by BOTH the client (src/*) and the Worker (worker/*).
   =========================================================================== */
import type {
  Message,
  Phase,
  RailState,
  ScreenId,
  TaskItem,
  VariantCard,
  VariantId,
} from "../state";

/** Server → client. Each event maps to a store patch in the liveDriver. */
export type ServerEvent =
  | { t: "run.started"; runId: string; url: string; projectName: string; seed: string }
  | { t: "phase"; phase: Phase }
  | { t: "screen"; screen: ScreenId }
  | { t: "tasks.init"; tasks: TaskItem[] }
  | { t: "task"; id: string; status: TaskItem["status"] }
  | { t: "status"; text: string }
  | { t: "progress"; value: number }
  | { t: "snapshot.ready" }
  | { t: "messages"; messages: Message[] }
  | { t: "message.append"; message: Message }
  | { t: "panel.brand"; brandReviewUrl: string; tensions: { n: string; text: string }[] }
  | { t: "panel.variants"; sharedFixes: string[]; variants: VariantCard[] }
  | { t: "panel.workspace"; activeVariant: VariantId; variants: VariantCard[] }
  | { t: "rail"; rail: RailState }
  | { t: "run.done" }
  | { t: "error"; message: string };

/** Client → server (over the same WebSocket). User-initiated intents. */
export type ClientCommand =
  | { t: "nav"; to: ScreenId }          // back/forward buttons + "see snapshot/directions"
  | { t: "open"; variant: VariantId }   // open a variant into the workspace
  | { t: "select"; variant: VariantId } // toolbar A/B/C switch — keep the server's active target in sync (no UI re-emit)
  | { t: "cancel" }                      // stop an in-flight run (Stop button)
  | { t: "send"; screen: ScreenId; text: string }; // composer

export const isServerEvent = (v: unknown): v is ServerEvent =>
  typeof v === "object" && v !== null && typeof (v as { t?: unknown }).t === "string";
