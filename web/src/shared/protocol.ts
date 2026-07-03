/* ===========================================================================
   Wire protocol — the typed contract between the RunSession Durable Object
   (server, the run's source of truth) and the client liveDriver. This is the
   formalized engine→UI event protocol: in M2 the DO scripts these events; in
   M5 the same events are derived from the agent's status.jsonl + artifacts.
   Imported by BOTH the client (src/*) and the Worker (worker/*).
   =========================================================================== */
import type {
  AuditState,
  DeployState,
  Message,
  PageCandidate,
  Phase,
  RailState,
  ScreenId,
  TaskItem,
  TemplatePage,
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
  | { t: "panel.pages"; pages: PageCandidate[] }                               // prototype phase: discovered pages
  | { t: "panel.templates"; protoVariant: string; templates: TemplatePage[] }  // prototype phase: page prototypes
  | { t: "panel.deploy"; deploy: DeployState }                                 // deploy/rollout phase: EDS push state
  | { t: "panel.audit"; audit: AuditState }                                    // audit phase: scorecard state
  | { t: "rail"; rail: RailState }
  | { t: "busy"; value: boolean }       // agent working ↔ idle (drives the chat thinking dots)
  | { t: "eta"; seconds: number; startedAt?: number } // ETA bar: total estimate (s) + run-start epoch anchor; re-emitted (re-anchored) at each milestone
  | { t: "run.done" }
  | { t: "error"; message: string };

/** Client → server (over the same WebSocket). User-initiated intents. */
export type ClientCommand =
  | { t: "nav"; to: ScreenId }          // back/forward buttons + "see snapshot/directions"
  | { t: "open"; variant: VariantId }   // open a variant into the workspace
  | { t: "select"; variant: VariantId } // toolbar A/B/C switch — keep the server's active target in sync (no UI re-emit)
  | { t: "cancel" }                      // stop an in-flight run (Stop button)
  | { t: "send"; screen: ScreenId; text: string }  // composer
  | { t: "addVariant"; instruction: string }       // generate an extra direction (variant D, E, …)
  | { t: "prototype"; slugs: string[] }            // render selected pages in the chosen direction
  | { t: "setProtoVariant"; variant: VariantId }   // pin which variant direction the prototype phase uses
  | { t: "deploy"; slugs: string[] }               // convert + push pages to AEM Edge Delivery (preview)
  | { t: "golive" }                                // publish the deployed pages to aem.live
  | { t: "rollout" }                               // prototype every remaining page, then deploy the site live
  | { t: "audit"; target: "original" | "deployed" }; // run stardust:audit on the site (or the deployed preview)

export const isServerEvent = (v: unknown): v is ServerEvent =>
  typeof v === "object" && v !== null && typeof (v as { t?: unknown }).t === "string";
