/* ===========================================================================
   Run-state store — the single source of truth the screens render from.
   In M1 it is fed by the mock driver; in M2 the same shape is fed by the
   Worker WebSocket. Keep this transport-agnostic.
   =========================================================================== */

export type ScreenId = "landing" | "working" | "brand" | "audit" | "variants" | "workspace";
export type Phase = "prototype" | "deploy";
export type TaskStatus = "done" | "run" | "wait";
export type VariantId = "A" | "B" | "C";

export interface TaskItem {
  id: string;
  cat: string;           // CRAWL / READ / EXTRACT / ANALYZE / GENERATE / VALIDATE
  kind: "crawl" | "read" | "extract" | "analyze" | "generate" | "validate";
  title: string;
  detail: string;
  status: TaskStatus;
}

export interface Message {
  id: string;
  role: "agent" | "user";
  lead?: string;         // first emphasized line (agent)
  body?: string[];       // following paragraphs
  text?: string;         // user bubble text
  seed?: string;         // optional seed chip hash
  plan?: PlanBlock;
  tool?: string;         // tool-activity row (run_bash, read_file…) — muted style
  artifact?: ArtifactRef;// a clickable artifact card (opens on the right)
}

export interface ArtifactRef {
  kind: "brand" | "variant";
  label: string;         // "Brand review" | "Variant C — cinematic"
  variant?: VariantId;   // for kind:"variant"
}

export interface PlanBlock {
  tag: string;           // "3 tensions" | "plan"
  steps: { n: string; text: string }[];
  status?: string;       // "Applied · re-rendered"
  acts?: string[];       // ["Undo","Keep"]
}

export interface VariantCard {
  id: VariantId;
  title: string;
  pitch: string;
  thumb: string;         // image url
  src: string;           // proposed html url (iframe)
  segLabel: string;      // "C · cinematic"
  segWord: string;       // "cinematic"
  role: string;          // "cinematic · visionary pick"
  recommended?: boolean;
  faithful?: string;     // A-only single line (no whatif)
  whatif?: string;       // B/C
  movesLabel?: string;   // "moves" | "motion" | "composition"
  moves?: string[];
}

export interface RailState {
  swatches: string[];
  signature?: string;
  note?: string;
  variant?: string;      // workspace: "C · cinematic" (rendered with #variantLabel)
  tensions?: number;     // brand/variants: "tensions N"
  score?: string;        // ambient audit score chip, e.g. "62 / 100" or "62 → 94"
  clock?: string;
  busy?: boolean;        // show spinner + "reading…" item
}

// An audit is an optional, on-demand scored diagnosis — of the current live site
// (uplift baseline) or of the result (deploy/rollout). Costs time + tokens, so
// it's never auto-run. See NAVIGATION.md.
export interface AuditFinding {
  n: string;
  text: string;
  fixed?: boolean;       // resolved in the redesign (for before/after audits)
}
export interface AuditState {
  status: "idle" | "running" | "done";
  score?: number;        // 0..100
  baseline?: number;     // the uplift-baseline score, for the after-audit delta
  findings: AuditFinding[];
}

export interface RunState {
  screen: ScreenId;
  phase: Phase;
  url: string;
  projectName: string;
  seed: string;
  messages: Message[];
  tasks: TaskItem[];
  statusTicker: string;       // working-stage status line
  progress: number;           // 0..100 working progress
  snapshotReady: boolean;     // enables "See snapshot" on working
  brandReviewUrl: string;
  tensions: { n: string; text: string }[];
  sharedFixes: string[];
  variants: VariantCard[];
  activeVariant: VariantId;
  viewport: "desktop" | "mobile";
  rail: RailState;
  error?: string;             // set when a run fails/cancels — working screen shows it
  agentBusy?: boolean;        // agent is working → show thinking dots in the chat
  eta?: { seconds: number; at: number }; // ETA bar: estimate + client receipt time
  live?: boolean;             // a fresh run is streaming (not a reopen) → enable toasts
  lastArtifact?: { ref: ArtifactRef; at: number }; // newest artifact → "ready" toast
  runId?: string;             // the active run's id (for publish/ownership calls)
  published?: { path: string; url: string }[]; // this run's published artifacts
  audit?: AuditState;         // optional on-demand audit (uplift baseline / result)
}

type Listener = (s: RunState) => void;

function initial(): RunState {
  return {
    screen: "landing",
    phase: "prototype",
    url: "",
    projectName: "",
    seed: "",
    messages: [],
    tasks: [],
    statusTicker: "",
    progress: 0,
    snapshotReady: false,
    brandReviewUrl: "",
    tensions: [],
    sharedFixes: [],
    variants: [],
    activeVariant: "C",
    viewport: "desktop",
    rail: { swatches: [] },
    error: undefined,
    agentBusy: false,
    eta: undefined,
    live: false,
    lastArtifact: undefined,
    runId: undefined,
    published: [],
    audit: undefined,
  };
}

class Store {
  private s: RunState = initial();
  private listeners = new Set<Listener>();

  get(): RunState {
    return this.s;
  }

  /** Shallow-merge a patch and notify subscribers. */
  set(patch: Partial<RunState>): void {
    this.s = { ...this.s, ...patch };
    this.emit();
  }

  /** Mutate in place via a recipe, then notify (for array pushes etc.). */
  update(fn: (s: RunState) => void): void {
    fn(this.s);
    this.emit();
  }

  reset(): void {
    this.s = initial();
    this.emit();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.s);
  }
}

export const store = new Store();
