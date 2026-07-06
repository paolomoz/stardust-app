/* ===========================================================================
   RunSession Durable Object — one per run, the run's source of truth. Accepts
   WebSocket connections, scripts the knack uplift run (M2: timed events; M5: the
   same events derived from the agent), persists the timeline to D1, and
   re-emits any screen's payload on a client nav command.
   =========================================================================== */
import { DurableObject } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import type { Env } from "./index";
import type { AuditState, DeployPage, DeployState, Message, PageCandidate, RailState, ScreenId, TaskItem, TemplatePage, VariantCard, VariantId } from "../state";
import type { ClientCommand, ServerEvent } from "../shared/protocol";
import { scrubInternals } from "./scrub";
import {
  KNACK_EDS,
  KNACK_PAGES,
  KNACK_PALETTE,
  KNACK_PROJECT,
  KNACK_SEED,
  KNACK_SHARED_FIXES,
  KNACK_TENSIONS,
  STATUS_TICKER,
  VARIANT_META,
  knackTasks,
} from "../shared/knack-content";

// Demo artifacts are bundled as static assets (web/public/knack-demo/**), served
// directly (no auth, no R2) so the offline demo previews actually render.
const ART = "/knack-demo";
// brand-review lives under review/ (its own assets/) to avoid colliding with the
// variants' assets/ when merged into one R2 prefix. See scripts/seed-r2.sh.
const brandReviewUrl = `${ART}/review/brand-review.html`;
const variants: VariantCard[] = VARIANT_META.map((m) => ({
  ...m,
  src: `${ART}/${m.file}`,
  thumb: `${ART}/assets/${m.thumbFile}`,
}));

// Honest uplift step list (single-page render → 3 variants), driven live by the
// agent's milestones. Deliberately NOT the knack demo copy ("24 pages found").
const UPLIFT_TASKS: TaskItem[] = [
  { id: "crawl", cat: "CAPTURE", kind: "crawl", title: "Rendering the page", detail: "live capture", status: "wait" },
  { id: "read", cat: "READ", kind: "read", title: "Reading the brand", detail: "palette · type · logo", status: "wait" },
  { id: "extract", cat: "EXTRACT", kind: "extract", title: "Brand surface", detail: "tokens · motifs", status: "wait" },
  { id: "analyze", cat: "ANALYZE", kind: "analyze", title: "Finding tensions", detail: "CTAs · scale · contrast", status: "wait" },
  { id: "generate", cat: "DIRECT", kind: "generate", title: "Composing 3 directions", detail: "brand-faithful bets", status: "wait" },
  { id: "validate", cat: "VALIDATE", kind: "validate", title: "Validating renders", detail: "a11y · responsive · motion", status: "wait" },
];

function deriveProject(url: string): string {
  try {
    return new URL(url.startsWith("http") ? url : `https://${url}`).hostname.replace(/^www\./, "");
  } catch {
    return KNACK_PROJECT;
  }
}

// ---- Dynamic ETA (self-calibrating, LLM-free) ----------------------------
// Milestone timing model learned from past runs' result_json.timings, keyed on
// milestone LABEL (never on hardcoded phase meaning) so it absorbs pipeline
// changes automatically. Bump PIPELINE_VERSION when the run flow changes
// (parallel craft, phase reorders) so old-shape runs don't blend with new ones.
const PIPELINE_VERSION = "fable-1";
type EtaModel = { f: Record<string, number>; meanTotal: number; p10: number; p90: number; hasHistory: boolean };
// Fallback when there's no matching history — fable-1 priors: plugin 0.14.4
// (vision gates lengthen extract/prototype) + A-first canon stagger
// (extract+direct ~13m, craft A ~7m, then B/C in parallel ~7m ≈ 27 min).
const ETA_DEFAULTS: EtaModel = {
  f: { brand_ready: 0.28, variants_ready: 0.5, variant_done: 0.9 },
  meanTotal: 1620, p10: 15 * 60, p90: 45 * 60, hasHistory: false,
};
// Iterate ETA: pooled median of past iteration durations (LLM-free, no similarity
// index — one bucket per backend). Default until history accrues (seconds).
const ITER_ETA_DEFAULT = { median: 90, p10: 30, p90: 360 };
// Post-run job priors (seconds): a new direction forks + re-crafts one page; a
// template renders (extract + prototype) one page. Fixed — not yet learned.
const VARIANT_ETA = 5 * 60;
const TEMPLATE_ETA = 6 * 60;

export class RunSession extends DurableObject<Env> {
  private sockets = new Set<WebSocket>();
  private events: ServerEvent[] = [];
  private seq = 0;
  private started = false;
  private runId = "";
  private project = KNACK_PROJECT;
  private timers: number[] = [];
  private ticker?: number;
  // M5: real uplift run state. When set, the panel emitters use real artifacts
  // (pushed by the sandbox agent via the ingest endpoints) instead of the knack
  // demo constants.
  private uplift = false;
  private finished = false;
  private tasks: TaskItem[] = [];
  private realTensions: { n: string; text: string }[] = [];
  private realBrand?: { brandReviewUrl: string; tensions: { n: string; text: string }[] };
  private realPalette?: string[]; // extracted brand palette (footer swatches); KNACK_PALETTE is demo-only
  private realVariants?: { sharedFixes: string[]; variants: VariantCard[] };
  // M6: workspace iteration. activeVariant is the target a "tell me a change"
  // applies to; iterVersion cache-busts the iframe src on each re-render.
  private activeVariant?: VariantId;
  private iterVersion = 0;
  // M6 iteration completion: an iteration is "done" the moment its updated
  // variant file lands (ingestArtifact) — we don't depend on the agent emitting
  // the terminal iterate.done milestone (it sometimes exits without it).
  private iterating = false;
  private iterateVariant?: VariantId;
  private iterateFile?: string;
  private iterateStart = 0; // ms epoch — for the iterate ETA anchor + duration record
  // Prototype phase state. pageCandidates: pages discovered from the home
  // inventory; templates: page prototypes (queued→done); protoVariant: the pinned
  // direction. addingVariant + variantQueue serialize extra-direction jobs;
  // templateInflight counts in-flight page jobs (busy clears at 0).
  private realPages: PageCandidate[] = [];
  private realTemplates: TemplatePage[] = [];
  private protoVariant?: string;
  private addingVariant = false;
  private variantQueue: string[] = [];
  private templateInflight = 0;
  // Parallel uplift: variant ids whose build workers are still in flight, and how
  // many of them delivered. The run completes when the set drains (≥1 success).
  private pendingBuilds: string[] = [];
  private buildsSucceeded = 0;
  // True when this run uses the split pipeline — its ONLY completion signal is
  // the build fan-out draining; a stray `done` milestone from a worker (or the
  // phase-1 model) must not finish the run early.
  private parallelUplift = false;
  // Per-variant build retry count — a worker that finishes without uploading its
  // page (observed in prod) gets one re-craft before the variant is dropped.
  private buildRetries: Record<string, number> = {};
  // A-first canon freeze: variants whose build dispatch waits for the first
  // (canon) build to settle. Persisted so eviction can't strand them.
  private stagedBuilds: string[] = [];
  // Deploy/rollout: the run's EDS push state (one code branch + one DA folder
  // per project). Persisted so it survives eviction and reopen.
  private deployState?: DeployState;
  // Audit phase: the latest stardust:audit scorecard (original or deployed).
  private auditState?: AuditState;
  // Demo (scripted) run: the whole ladder is simulated offline — action
  // commands (prototype/deploy/rollout) never spawn a container or touch DA.
  private demo = false;
  // Progress is monotonic — deterministic markers and model milestones interleave
  // and must never pull the bar backwards.
  private lastProgress = 0;
  // Dynamic ETA state (see PIPELINE_VERSION / ETA_DEFAULTS above).
  private etaModel: EtaModel | null = null;
  private startTs = 0;                            // run start (ms epoch) = MIN(run_events.ts)
  private lastEta = 0;                            // last emitted TOTAL seconds (EMA glide)
  private timings: Record<string, number> = {};  // milestone label -> elapsed ms (this run)
  private mode = "";
  private directions = "";                        // user's free-text design brief (optional)

  async fetch(request: Request): Promise<Response> {
    const runId = new URL(request.url).pathname.match(/^\/api\/runs\/([^/]+)\/ws$/)?.[1] ?? "";
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.sockets.add(server);

    if (!this.started) {
      this.started = true;
      this.runId = runId;
      // Cold start: load the persisted timeline + result. No events → a fresh run
      // (kick it off); otherwise a reopen (replay only, no new paid run).
      const persisted = await this.env.DB.prepare(
        "SELECT payload FROM run_events WHERE run_id = ? ORDER BY seq",
      )
        .bind(runId)
        .all<{ payload: string }>();
      const rows = persisted.results ?? [];
      if (rows.length) {
        for (const r of rows) {
          try {
            this.events.push(JSON.parse(r.payload) as ServerEvent);
          } catch {
            /* skip malformed */
          }
        }
        // Continue the seq past the restored timeline — otherwise the next emit
        // (e.g. a workspace iteration) collides with an existing (run_id, seq)
        // row and the INSERT throws, aborting the command after the WS broadcast.
        this.seq = rows.length;
        await this.rehydrateResult(runId);
      } else {
        void this.start(runId);
      }
    }

    // Bring THIS socket up to date — covers a cold reopen AND a reconnect to a
    // warm DO. Replay the timeline, then (re)send the panel data from the
    // rehydrated/live result: run_events may not carry panel.* under client-owned
    // nav, so the Brand/Directions/Workspace views need it pushed explicitly.
    for (const ev of this.events) server.send(JSON.stringify(ev));
    if (this.realBrand) server.send(JSON.stringify({ t: "panel.brand", brandReviewUrl: this.realBrand.brandReviewUrl, tensions: this.realBrand.tensions }));
    if (this.realVariants?.variants?.length) server.send(JSON.stringify({ t: "panel.variants", sharedFixes: this.realVariants.sharedFixes, variants: this.realVariants.variants }));
    if (this.realPages.length) server.send(JSON.stringify({ t: "panel.pages", pages: this.realPages }));
    if (this.realTemplates.length) server.send(JSON.stringify({ t: "panel.templates", protoVariant: this.protoVariant ?? "", templates: this.realTemplates }));
    if (this.deployState) server.send(JSON.stringify({ t: "panel.deploy", deploy: this.deployState }));
    if (this.auditState) server.send(JSON.stringify({ t: "panel.audit", audit: this.auditState }));
    // Stored rail events bake in run-time swatches; if we know the real palette,
    // resend the last rail corrected (display-only, not persisted).
    if (this.realPalette?.length) {
      const lastRail = [...this.events].reverse().find((ev) => ev.t === "rail");
      if (lastRail && lastRail.t === "rail") {
        server.send(JSON.stringify({ t: "rail", rail: { ...lastRail.rail, swatches: this.realPalette } }));
      }
    }
    // Clear a stale spinner on reopen: a terminal run (done/error) that isn't
    // actively iterating must not replay a `busy=true` whose matching
    // `busy=false` never arrived (an iteration that crashed before uploading, or
    // one that predates the completion fix). Display-only, not persisted.
    if (!this.iterating) {
      const st = await this.env.DB.prepare("SELECT status FROM runs WHERE id = ?").bind(runId).first<{ status: string }>();
      if (st?.status === "done" || st?.status === "error") server.send(JSON.stringify({ t: "busy", value: false }));
    }

    server.addEventListener("message", (e) => {
      try {
        const cmd = JSON.parse(typeof e.data === "string" ? e.data : "") as ClientCommand;
        void this.onCommand(cmd);
      } catch {
        /* ignore malformed */
      }
    });
    const drop = () => this.sockets.delete(server);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---- event plumbing ---- */

  private async emit(ev: ServerEvent): Promise<void> {
    this.events.push(ev);
    const payload = JSON.stringify(ev);
    // Persist BEFORE broadcasting — if the INSERT throws, a connected client
    // must not have seen an event that a reopen can never replay.
    // Compute the next seq atomically from the table rather than trusting an
    // in-memory counter — the DO can emit on the ingest path (cold start),
    // across reconnects, or after a reopen, where this.seq would be stale and
    // collide on the (run_id, seq) primary key.
    await this.env.DB.prepare(
      "INSERT INTO run_events (run_id, seq, payload, ts) SELECT ?, COALESCE((SELECT MAX(seq) + 1 FROM run_events WHERE run_id = ?), 0), ?, ?",
    )
      .bind(this.runId, this.runId, payload, Date.now())
      .run();
    this.seq++; // keep in-memory counter advancing for message-id uniqueness
    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(ws);
      }
    }
  }

  /** Emit a monotonic progress value (never backwards). */
  private async bumpProgress(value: number): Promise<void> {
    if (value <= this.lastProgress) return;
    this.lastProgress = value;
    await this.emit({ t: "progress", value });
  }

  private schedule(ms: number, fn: () => Promise<void> | void): void {
    this.timers.push(setTimeout(() => void fn(), ms) as unknown as number);
  }

  private clearTimers(): void {
    this.timers.forEach((t) => clearTimeout(t));
    this.timers = [];
    if (this.ticker !== undefined) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  /** Build a rail state, using the run's extracted palette for the footer
   *  swatches (KNACK_PALETTE is only the scripted-demo fallback). */
  private railState(partial: Omit<RailState, "swatches">): RailState {
    return { swatches: this.realPalette ?? KNACK_PALETTE, ...partial };
  }

  /* ---- Dynamic ETA: milestone-anchored, self-calibrating, LLM-free ---- */

  /** Run start epoch (ms). MIN(run_events.ts) is the true wall-clock anchor and
   *  survives DO eviction/reopen. Cached after first read. */
  private async runStartTs(): Promise<number> {
    if (this.startTs) return this.startTs;
    const row = await this.env.DB.prepare("SELECT MIN(ts) AS t FROM run_events WHERE run_id = ?").bind(this.runId).first<{ t: number | null }>();
    this.startTs = row?.t ?? Date.now();
    return this.startTs;
  }

  /** Backend timing class — opus (bedrock/uplift) ≈tens of minutes vs cerebras
   *  ≈minutes; never blend their totals when learning ETAs. */
  private timingClass(): string[] {
    return this.mode === "bedrock" || this.mode === "uplift" ? ["bedrock", "uplift"]
      : this.mode ? [this.mode] : ["bedrock", "uplift"];
  }

  /** Learn the milestone-fraction model from recent completed REAL runs. Reads
   *  result_json.timings (folded in on done); filters to the current pipeline
   *  version; falls back to ETA_DEFAULTS when there's no matching history. */
  private async learnEta(): Promise<EtaModel> {
    try {
      const cls = this.timingClass();
      const ph = cls.map(() => "?").join(",");
      const rows = await this.env.DB.prepare(
        `SELECT result_json FROM runs WHERE status='done' AND id != ? AND mode IN (${ph}) ORDER BY created_at DESC LIMIT 20`,
      ).bind(this.runId, ...cls).all<{ result_json: string | null }>();
      const totals: number[] = [];
      const byLabel: Record<string, number[]> = {};
      for (const row of rows.results ?? []) {
        let tm: { byLabel?: Record<string, number>; total?: number; pipelineVersion?: string } | undefined;
        try { tm = JSON.parse(row.result_json || "{}").timings; } catch { continue; }
        if (!tm?.total || !tm.byLabel) continue;
        if ((tm.pipelineVersion ?? "serial-1") !== PIPELINE_VERSION) continue;
        totals.push(tm.total);
        // Only genuine intermediate milestones (0 < elapsed < total). Guards
        // against reopen-corrupted history where a re-emitted event's ts lands
        // after run.done (fraction > 1); 'done' itself (==total) is excluded.
        for (const [k, v] of Object.entries(tm.byLabel)) if (v > 0 && v < tm.total!) (byLabel[k] ??= []).push(v / tm.total!);
      }
      if (!totals.length) return ETA_DEFAULTS;
      const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
      const pct = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
      const f: Record<string, number> = { ...ETA_DEFAULTS.f };
      for (const [k, arr] of Object.entries(byLabel)) f[k] = mean(arr);
      const secs = totals.map((t) => t / 1000);
      // Widen bounds a touch (few samples) so a slower/faster run isn't over-clamped.
      return { f, meanTotal: mean(secs), p10: Math.max(120, pct(secs, 0.1) * 0.7), p90: pct(secs, 0.9) * 1.3, hasHistory: true };
    } catch { return ETA_DEFAULTS; }
  }

  /** Iterate ETA (LLM-free): pooled median + percentiles of past iteration
   *  durations for this backend class. No similarity matching — one bucket.
   *  Falls back to ITER_ETA_DEFAULT until enough history accrues. */
  private async learnIterateEta(): Promise<{ median: number; p10: number; p90: number }> {
    try {
      const cls = this.timingClass();
      const ph = cls.map(() => "?").join(",");
      const rows = await this.env.DB.prepare(
        `SELECT result_json FROM runs WHERE status='done' AND mode IN (${ph}) AND result_json LIKE '%iterMs%' ORDER BY created_at DESC LIMIT 30`,
      ).bind(...cls).all<{ result_json: string | null }>();
      const all: number[] = [];
      for (const row of rows.results ?? []) {
        try { const a = JSON.parse(row.result_json || "{}").iterMs; if (Array.isArray(a)) for (const x of a) if (x > 0) all.push(x); } catch { /* */ }
      }
      if (all.length < 2) return ITER_ETA_DEFAULT;
      const secs = all.map((x) => x / 1000).sort((a, b) => a - b);
      const pct = (p: number) => secs[Math.min(secs.length - 1, Math.floor(p * secs.length))];
      return { median: pct(0.5), p10: Math.max(20, pct(0.1) * 0.8), p90: pct(0.9) * 1.3 };
    } catch { return ITER_ETA_DEFAULT; }
  }

  /** Append one iteration's wall-clock (ms) to result_json.iterMs so the pooled
   *  iterate learner self-calibrates. */
  private async persistIterTiming(ms: number): Promise<void> {
    const row = await this.env.DB.prepare("SELECT result_json FROM runs WHERE id = ?").bind(this.runId).first<{ result_json: string | null }>();
    let cur: Record<string, unknown> = {};
    try { if (row?.result_json) cur = JSON.parse(row.result_json); } catch { /* */ }
    const iterMs = Array.isArray(cur.iterMs) ? (cur.iterMs as number[]) : [];
    iterMs.push(ms);
    await this.env.DB.prepare("UPDATE runs SET result_json = ? WHERE id = ?").bind(JSON.stringify({ ...cur, iterMs }), this.runId).run();
  }

  /** t=0 prior: the historical mean when we have history, else the tuned
   *  pipeline default (ETA_DEFAULTS.meanTotal). Fully LLM-free — a blind model
   *  guess here used to pin the bar at the 45m clamp ceiling and made the
   *  estimate look static. Emits the initial ETA anchored at run start. */
  private async primeEta(_detail: string): Promise<void> {
    const m = (this.etaModel = await this.learnEta());
    const start = await this.runStartTs();
    const seconds = Math.round(Math.min(m.p90, Math.max(m.p10, m.meanTotal)));
    this.lastEta = seconds;
    await this.emit({ t: "eta", seconds, startedAt: start });
  }

  /** Re-anchor when milestone `label` fires: total_est = elapsed / f(label),
   *  EMA-smoothed + bounded, never below elapsed. Records elapsed for learning. */
  private async reestimateEta(label: string): Promise<void> {
    const m = this.etaModel ?? (this.etaModel = await this.learnEta());
    const start = await this.runStartTs();
    const elapsedMs = Date.now() - start;
    this.timings[label] = elapsedMs;
    const f = m.f[label];
    if (!f || f <= 0) return; // unknown label: recorded for learning, no re-anchor
    const elapsed = elapsedMs / 1000;
    let est = elapsed / f;
    // Glide, don't jerk — but trust live milestone evidence over the prior
    // (0.5/0.5 made the bar look static when the prior started high).
    if (this.lastEta > 0) est = 0.7 * est + 0.3 * this.lastEta;
    // variant_done is the last, highest-variance signal (fires 0.57–0.98 of total)
    // and the run is nearly over by then — only let it pull the estimate DOWN, so
    // the bar never jumps backward at the finish.
    if (label === "variant_done" && this.lastEta > 0) est = Math.min(est, this.lastEta);
    est = Math.min(m.p90, Math.max(m.p10, est));
    est = Math.round(Math.max(elapsed + 5, est)); // never claim already-done
    this.lastEta = est;
    await this.emit({ t: "eta", seconds: est, startedAt: start });
  }

  /* ---- the scripted run ---- */

  private async start(runId: string): Promise<void> {
    this.runId = runId;
    const row = await this.env.DB.prepare("SELECT url, mode, directions FROM runs WHERE id = ?")
      .bind(runId)
      .first<{ url: string; mode: string; directions: string | null }>();
    const url = row?.url ?? "https://www.knack.com/";
    this.mode = row?.mode ?? "";
    this.directions = row?.directions ?? "";
    this.project = deriveProject(url);
    await this.env.DB.prepare("UPDATE runs SET status = 'running', project = ? WHERE id = ?")
      .bind(this.project, runId)
      .run();

    if (row?.mode === "cerebras") return this.runRuntime(url, "cerebras");
    if (row?.mode === "scripted") return this.runScripted(url, runId);
    // bedrock (default) — legacy Managed-Agents modes (uplift/agent/probe) fold
    // into the open-loop runtime, which replaced that path.
    return this.runRuntime(url, "bedrock");
  }

  /* ---- M2 scripted demo run ---- */

  private async runScripted(url: string, runId: string): Promise<void> {
    // Everything downstream is simulated offline — no containers, no DA.
    this.demo = true;
    // Seed the real accumulators with demo content so the prototype/deploy/
    // rollout screens (which read these) work exactly as in a live run.
    this.realVariants = { sharedFixes: KNACK_SHARED_FIXES, variants };
    this.realPages = KNACK_PAGES.map((p) => ({ ...p }));
    this.protoVariant = "C";
    const tasks = knackTasks();
    tasks[0].status = "run";
    // Content first, screen last — so the screen mounts with its data present.
    await this.emit({ t: "run.started", runId, url, projectName: this.project, seed: KNACK_SEED });
    await this.emit({ t: "phase", phase: "prototype" });
    await this.emit({ t: "tasks.init", tasks });
    await this.emit({ t: "progress", value: 8 });
    await this.emit({ t: "status", text: STATUS_TICKER[0] });
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "eta", seconds: 6 }); // demo timeline is ~6s
    await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock: "⏱ ~ a few minutes · reading the site" } });
    if (this.directions) await this.emit({ t: "message.append", message: { id: "brief", role: "user", text: `${this.project} — ${this.directions}` } });
    await this.emit({ t: "message.append", message: { id: "intro", role: "agent", lead: `On it — reading **${this.project}**, learning the brand, and composing directions.`, body: ["This normally takes a few minutes. I'll show the snapshot the moment it's ready."] } });
    await this.emit({ t: "screen", screen: "working" });

    let i = 0;
    this.ticker = setInterval(() => {
      i = (i + 1) % STATUS_TICKER.length;
      void this.emit({ t: "status", text: STATUS_TICKER[i] });
    }, 820) as unknown as number;

    const step = async (doneId: string, runId2: string | null, progress: number) => {
      await this.emit({ t: "task", id: doneId, status: "done" });
      if (runId2) await this.emit({ t: "task", id: runId2, status: "run" });
      await this.emit({ t: "progress", value: progress });
    };

    this.schedule(900, () => step("crawl", "read", 22));
    this.schedule(1700, () => step("read", "extract", 40));
    this.schedule(2800, () => step("extract", "analyze", 58));
    this.schedule(3800, () => step("analyze", "generate", 74));
    this.schedule(4900, () => step("generate", "validate", 90));
    // Artifact cards (+ "ready" toasts) — mirrors the real run's brand/variant signals.
    this.schedule(3200, () => this.emit({ t: "message.append", message: { id: "art-brand", role: "agent", artifact: { kind: "brand", label: "Brand review" } } }));
    this.schedule(5200, () => this.emit({ t: "message.append", message: { id: "art-C", role: "agent", artifact: { kind: "variant", variant: "C", label: "Variant C — cinematic" } } }));
    this.schedule(6000, async () => {
      await this.emit({ t: "task", id: "validate", status: "done" });
      await this.emit({ t: "progress", value: 100 });
      await this.emit({ t: "busy", value: false });
      await this.emit({ t: "snapshot.ready" });
    });
    // Stream brand → directions → workspace. Each of these calls clearTimers(),
    // so chain the next only after the previous has run (matches how real runs
    // emit panel.brand/variants eagerly; lets the Overview tabs light up).
    this.schedule(6800, async () => {
      await this.toBrand();
      this.schedule(1000, async () => {
        await this.toVariants();
        this.schedule(1000, async () => {
          await this.toWorkspace("C");
          // Publish the prototype-phase page pool so the Prototype rung is a
          // populated picker the moment the user gets there.
          await this.emit({ t: "panel.pages", pages: this.realPages });
          // Persist so a reopen (/?run=<id>) restores the demo (variants, pages,
          // and the demo flag) and keeps the ladder offline.
          await this.persistResult();
        });
      });
    });
  }

  /* ---- demo (scripted) simulators: the prototype/deploy/rollout ladder,
     played entirely offline — no containers, no runner, no DA. They mutate the
     same state + emit the same panels as the live paths, so the screens are
     identical; only the work is faked with timers + the bundled demo artifact. ---- */

  private demoWait(ms: number): Promise<void> {
    return new Promise((res) => { this.timers.push(setTimeout(res, ms) as unknown as number); });
  }

  /** Demo artifact reused as every prototyped/deployed page's preview. */
  private demoPageSrc(): string { return `${ART}/home-C-cinematic.html`; }

  /** Prototype selected pages — queued → running → done, in the pinned variant. */
  private async demoTemplates(slugs: string[]): Promise<void> {
    const pick = slugs.length ? slugs : this.realPages.map((p) => p.slug);
    const targets = this.realPages.filter((p) => pick.includes(p.slug)
      && !this.realTemplates.some((t) => t.slug === p.slug && (t.status === "done" || t.status === "running")));
    if (!targets.length) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Nothing new to prototype — pick other pages." } }); return; }
    const variant = this.protoVariant ?? "C";
    for (const t of targets) this.upsertTemplate({ slug: t.slug, title: t.title, url: t.url, variant, status: "queued" });
    await this.emitTemplates();
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Prototyping ${targets.length} page${targets.length > 1 ? "s" : ""} in variant **${variant}**… (demo)` } });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", busy: true, clock: `⏱ prototyping ${targets.length} page(s)` }) });
    for (const t of targets) {
      this.upsertTemplate({ slug: t.slug, title: t.title, url: t.url, variant, status: "running" });
      await this.emitTemplates();
      await this.demoWait(1100);
      this.upsertTemplate({ slug: t.slug, title: t.title, url: t.url, variant, status: "done", src: this.demoPageSrc() });
      await this.emitTemplates();
      await this.emit({ t: "message.append", message: { id: `tpl-${t.slug}-${this.seq}`, role: "agent", lead: `Page **${t.title}** prototyped in variant ${variant}.` } });
    }
    await this.emit({ t: "busy", value: false });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", clock: "⏱ pages ready" }) });
  }

  private demoDeployState(pages: { slug: string; title: string }[]): void {
    const prev = this.deployState;
    const merged: DeployPage[] = [...(prev?.pages ?? [])];
    for (const p of pages) {
      const row: DeployPage = { slug: p.slug, title: p.title, status: "converting" };
      const i = merged.findIndex((x) => x.slug === p.slug);
      if (i >= 0) merged[i] = { ...merged[i], ...row }; else merged.push(row);
    }
    this.deployState = { ...KNACK_EDS, variant: this.protoVariant ?? "C", live: prev?.live ?? false, busy: true, rollout: prev?.rollout ?? false, pages: merged };
  }

  /** Convert → push → preview (→ live), all faked with timers. */
  private async demoDeploy(slugs: string[], opts: { live?: boolean; fromRollout?: boolean } = {}): Promise<void> {
    const want = slugs.length ? slugs : ["home"];
    const pages = want.map((s) => s === "home"
      ? { slug: "home", title: "Home" }
      : { slug: s, title: this.realTemplates.find((t) => t.slug === s)?.title ?? this.realPages.find((p) => p.slug === s)?.title ?? s })
      .filter((p) => p.slug === "home" || this.realTemplates.some((t) => t.slug === p.slug && t.status === "done"));
    if (!pages.length) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Nothing deployable yet — prototype the pages first." } }); return; }
    this.demoDeployState(pages);
    if (opts.fromRollout && this.deployState) this.deployState.rollout = true;
    await this.emitDeploy();
    const d = this.deployState!;
    await this.emit({ t: "message.append", message: { id: `dp-${this.seq}`, role: "agent", lead: `Converting **${pages.length} page${pages.length > 1 ? "s" : ""}** of variant ${d.variant} into Edge Delivery blocks — branch \`${d.branch}\`, folder \`/${d.project}\`. (demo)` } });
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", busy: true, clock: "⏱ converting to EDS" }) });
    await this.demoWait(1200);
    for (const p of pages) { this.setDeployPage(p.slug, { status: "pushing" }); }
    await this.emitDeploy();
    await this.emit({ t: "message.append", message: { id: `dp2-${this.seq}`, role: "agent", lead: `Blocks ready — pushing code to \`${d.branch}\` and content to DA…` } });
    await this.demoWait(1400);
    for (const p of pages) {
      this.setDeployPage(p.slug, { status: "previewed", previewUrl: this.demoPageSrc() });
      await this.emitDeploy();
      await this.demoWait(400);
    }
    if (opts.live) {
      for (const p of pages) { this.setDeployPage(p.slug, { status: "live", liveUrl: this.demoPageSrc() }); }
      d.live = true;
      await this.emitDeploy();
    }
    d.busy = false;
    if (opts.fromRollout) d.rollout = false;
    await this.emitDeploy();
    await this.emit({ t: "busy", value: false });
    const home = `${d.previewHost}/${d.project}/`;
    await this.emit({ t: "message.append", message: { id: `dpd-${this.seq}`, role: "agent", md: opts.live
      ? `✓ **Live** — the site is published. (demo)\n\n- Preview: ${home}\n- Live: ${home.replace(".aem.page", ".aem.live")}`
      : `✓ **Deployed to preview** — ${home} (demo)\n\nSay "go live" or hit the button to publish.` } });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", clock: opts.live ? "⏱ live" : "⏱ previewed" }) });
  }

  private async demoGoLive(): Promise<void> {
    const d = this.deployState;
    if (!d || !d.pages.some((p) => p.status === "previewed" || p.status === "live")) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Deploy to preview first — then I can take it live." } });
      return;
    }
    await this.demoDeploy(d.pages.map((p) => p.slug), { live: true });
  }

  /** Whole-site rollout: prototype every remaining page, then deploy all live. */
  private async demoRollout(): Promise<void> {
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Rolling out **the whole site** — prototyping the remaining pages in variant ${this.protoVariant ?? "C"}, then deploying everything live. (demo)` } });
    if (this.deployState) this.deployState.rollout = true; else this.demoDeployState([]);
    await this.emitDeploy();
    await this.demoTemplates(this.realPages.map((p) => p.slug));
    const slugs = ["home", ...this.realTemplates.filter((t) => t.status === "done").map((t) => t.slug)];
    await this.demoDeploy(slugs, { live: true, fromRollout: true });
  }

  private async demoAddVariant(instruction: string): Promise<void> {
    const id = this.nextVariantId();
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `On it — a new direction (variant **${id}**): ${instruction} (demo)` } });
    await this.demoWait(1400);
    const base = this.realVariants!.variants.find((v) => v.recommended) ?? this.realVariants!.variants[0];
    const card: VariantCard = { ...base, id, title: instruction.slice(0, 32) || `Direction ${id}`, recommended: false, segLabel: `${id} · ${base.segWord}`, whatif: instruction, faithful: undefined };
    this.realVariants = { sharedFixes: this.realVariants!.sharedFixes, variants: [...this.realVariants!.variants, card] };
    await this.emit({ t: "panel.variants", sharedFixes: this.realVariants.sharedFixes, variants: this.realVariants.variants });
    await this.emit({ t: "message.append", message: { id: `nv-${id}-${this.seq}`, role: "agent", lead: `New direction ready — variant **${id}**.` } });
    await this.emit({ t: "busy", value: false });
  }

  private async demoIterate(text: string): Promise<void> {
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `On it — variant **${this.activeVariant ?? "C"}**: ${text} (demo)` } });
    await this.demoWait(1500);
    await this.emit({ t: "busy", value: false });
    await this.emit({ t: "message.append", message: { id: `it-${this.seq}`, role: "agent", lead: `Done — re-rendered variant **${this.activeVariant ?? "C"}**. Ask for another change.` } });
  }

  /* ---- New-architecture run: open-loop runtime in the sandbox. backend selects
     the model provider (cerebras/Gemma or bedrock/Opus). The DO mints the ingest
     token, shows the working screen, asks the host runner to docker-run the
     runtime, then drives the screens purely from ingest (no SSE). Completion
     arrives via the agent's {"phase":"done"} milestone. ---- */
  private async runRuntime(url: string, backend: "cerebras" | "bedrock"): Promise<void> {
    this.uplift = true;
    this.tasks = UPLIFT_TASKS.map((t) => ({ ...t }));
    this.tasks[0].status = "run";
    // Implementation details (model/provider names) never reach the user.
    const clock = "⏱ live";
    await this.emit({ t: "run.started", runId: this.runId, url, projectName: this.project, seed: "—" });
    await this.emit({ t: "phase", phase: "prototype" });
    await this.emit({ t: "tasks.init", tasks: this.tasks });
    await this.bumpProgress(5);
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock } });
    // Echo the director's brief as the opening user bubble — it persists in
    // run_events, so it also reappears when the run is reopened.
    if (this.directions) await this.emit({ t: "message.append", message: { id: "brief", role: "user", text: `${this.project} — ${this.directions}` } });
    await this.emit({ t: "message.append", message: { id: "intro", role: "agent", lead: `On it — reading **${this.project}**, learning the brand, and composing directions.`, body: ["This normally takes a few minutes. I'll show the snapshot the moment it's ready."] } });
    await this.emit({ t: "screen", screen: "working" });
    void this.primeEta(url).catch(() => {});

    const token = crypto.randomUUID().replace(/-/g, "");
    await this.env.DB.prepare("UPDATE runs SET ingest_token = ? WHERE id = ?").bind(token, this.runId).run();

    try {
      // Parallel pipeline (bedrock): phase 1 stops after direct + bundles the
      // workspace; the DO fans out one build worker per variant on bundle_ready.
      // Cerebras (demo model) keeps the single-container serial run.
      const stage = backend === "bedrock" ? "direct" : "";
      this.parallelUplift = stage === "direct";
      await this.triggerRuntime({ runId: this.runId, url, token, backend, ...(stage ? { stage } : {}), ...(this.directions ? { directions: this.directions } : {}) });
      await this.emit({ t: "message.append", message: { id: "sess", role: "agent", lead: `Studio started — reading ${this.project}…` } });
    } catch (e) {
      await this.emit({ t: "message.append", message: { id: "no-runner", role: "agent", lead: "Couldn't start the runtime sandbox." } });
      await this.fail(`sandbox unreachable: ${String((e as Error).message ?? e)}`);
    }
  }

  /** Trigger the hands: a Cloudflare Container in prod (env.SANDBOX), else the
   *  host runner (local dev). The body carries per-job params; iterations include
   *  mode:"iterate". Both server.mjs and runner.mjs handle /run by the body. */
  private async triggerRuntime(body: Record<string, unknown>): Promise<void> {
    if (this.env.SANDBOX) {
      // Secrets don't reach the Container DO's env (only vars do), so pass the
      // model keys + ingest origin from THIS DO's env (which has them) in the body.
      const job = { ...body, modelEnv: this.modelEnv() };
      // One container instance PER JOB (keyed by runId+jobId), not one per run:
      // a standard-2 is 1 vCPU, so co-locating the parallel build/template jobs
      // on a single instance would serialize them (CPU-bound) and risk OOM from
      // concurrent Chromium. Distinct ids give each its own instance (the local
      // runner already isolates jobs into separate docker containers).
      const jobId = typeof body.jobId === "string" ? body.jobId : "";
      const key = jobId ? `${this.runId}-${jobId}` : this.runId;
      const c = getContainer(this.env.SANDBOX, key);
      const r = await c.fetch(new Request("http://sandbox/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(job) }));
      if (!r.ok) throw new Error(`container ${r.status}`);
      return;
    }
    const runner = this.env.RUNNER_URL ?? "http://localhost:8790/run";
    const r = await fetch(runner, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(`runner ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }

  /** Model keys + ingest origin from this DO's env, to hand to the container
   *  (its own env doesn't carry secrets). */
  private modelEnv(): Record<string, string> {
    const e: Record<string, string> = {};
    if (this.env.PUBLIC_ORIGIN) e.INGEST_BASE = this.env.PUBLIC_ORIGIN;
    if (this.env.BEDROCK_API_KEY) {
      e.BEDROCK_API_KEY = this.env.BEDROCK_API_KEY;
      e.BEDROCK_MODEL = this.env.BEDROCK_MODEL ?? "us.anthropic.claude-opus-4-8";
      e.BEDROCK_REGION = this.env.BEDROCK_REGION ?? "us-east-1";
    }
    if (this.env.CEREBRAS_API_KEY) {
      e.CEREBRAS_API_KEY = this.env.CEREBRAS_API_KEY;
      e.CEREBRAS_MODEL = this.env.CEREBRAS_MODEL ?? "gemma-4-31b";
    }
    return e;
  }

  /** Stop the hands for this run (cancel). */
  private async stopHands(token: string | null): Promise<void> {
    if (this.env.SANDBOX) {
      try { await getContainer(this.env.SANDBOX, this.runId).destroy(); } catch { /* ignore */ }
      return;
    }
    const cancelUrl = (this.env.RUNNER_URL ?? "http://localhost:8790/run").replace(/\/run$/, "/cancel");
    try { await fetch(cancelUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: this.runId, token }) }); } catch { /* ignore */ }
  }

  /** R2-served URL for an artifact this run uploaded, by its relative path. */
  private art(p: string): string {
    return `/api/artifacts/${this.runId}/${String(p).replace(/^\/+/, "")}`;
  }

  /** The artifact file name behind a card's src URL (strips the ?v= cache
   *  buster). Single home for a parse repeated across job dispatch paths. */
  private static fileOfSrc(src: string): string {
    return (src.split("?")[0].split("/").pop() ?? "").trim();
  }

  private mapVariants(arr: unknown[]): VariantCard[] {
    return (arr ?? []).map((raw) => {
      const m = raw as { id: VariantId; title?: string; pitch?: string; whatif?: string; role?: string; file: string; thumb: string };
      const segWord = String(m.role ?? m.title ?? m.id).split(/[ ·]/)[0].toLowerCase();
      return {
        id: m.id,
        title: m.title ?? `Variant ${m.id}`,
        pitch: m.pitch ?? "",
        thumb: this.art(m.thumb),
        src: this.art(m.file),
        segLabel: `${m.id} · ${segWord}`,
        segWord,
        role: m.role ?? "",
        recommended: m.id === "C",
        whatif: m.id === "A" ? undefined : m.whatif,
        faithful: m.id === "A" ? m.pitch : undefined,
      } satisfies VariantCard;
    });
  }

  /** Called by the Worker when the sandbox agent POSTs a milestone. The tasks
   *  list (this.tasks) is the source of truth; we mutate it and re-emit
   *  tasks.init so labels/details reflect the real run, not canned demo copy. */
  async ingestEvent(runId: string, ev: unknown): Promise<void> {
    if (!this.runId) this.runId = runId;
    const e = (ev ?? {}) as { type?: string; text?: string; name?: string; phase?: string; event?: string; seed?: string; items?: { n: string; text: string }[]; brandReview?: string; sharedFixes?: string[]; variants?: unknown[]; variant?: string; file?: string; message?: string; palette?: string[]; pages?: PageCandidate[]; card?: unknown; slug?: string; title?: string; thumb?: string };

    // User-facing message (reply_to_user) → prominent, markdown-rendered.
    // Scrubbed: implementation details (models/providers/skill names) stay internal.
    if (e.type === "reply" && e.text) {
      await this.emit({ t: "message.append", message: { id: `r-${this.seq}`, role: "agent", md: scrubInternals(e.text) } });
      return;
    }
    // Model reasoning → "thinking" narration (internal, not a user-facing reply).
    if (e.type === "narration" && e.text) {
      await this.emit({ t: "message.append", message: { id: `m-${this.seq}`, role: "agent", lead: scrubInternals(e.text), thinking: true } });
      return;
    }
    if (e.type === "tool") {
      await this.emit({ t: "message.append", message: { id: `t-${this.seq}`, role: "agent", tool: scrubInternals(e.name ?? "tool") } });
      return;
    }

    // The plugin's own run contract (stardust/status.jsonl), relayed by the
    // runtime tailer: deterministic phase boundaries drive the status line,
    // coarse board progress, and honest blocked surfacing. Panel payloads
    // still come from the emit_milestone events below.
    if (e.phase === "runstatus") {
      const r = ev as { skill?: string; step?: string; event?: string; detail?: string };
      const skill = (r.skill ?? "").replace(/^stardust:/, "");
      const step = r.step ?? "";
      if (r.event === "blocked") {
        await this.emit({ t: "status", text: `blocked — ${r.detail || step || skill}` });
        await this.emit({ t: "message.append", message: { id: `blk-${this.seq}`, role: "agent", lead: `⚠ ${skill} blocked${step ? ` at ${step}` : ""}${r.detail ? ` — ${r.detail}` : ""}.` } });
        return;
      }
      if (r.event === "start" && step) await this.emit({ t: "status", text: `${skill} · ${step}` });
      if (r.event === "end") {
        if (r.detail) await this.emit({ t: "status", text: `${skill} · ${step} — ${r.detail}` });
        // Coarse, monotonic board advancement per skill boundary (markers +
        // milestones refine it; bumpProgress dedupes regressions).
        if (skill === "extract") await this.taskAdvance("crawl", "read", 30);
        if (skill === "direct") await this.taskAdvance("analyze", "generate", 70);
      }
      return;
    }

    // M6: an iteration finished. Failure must NOT fail the (already-done) run —
    // just report it and leave the variant usable; success hot-swaps the preview.
    if (e.phase === "iterate") {
      if (e.event === "failed") {
        this.iterating = false;
        await this.persistResult();
        await this.emit({ t: "busy", value: false });
        await this.emit({ t: "message.append", message: { id: `iterr-${this.seq}`, role: "agent", lead: `Couldn't apply that change${e.message ? ` — ${e.message}` : ""}. The variant is unchanged — try rephrasing.` } });
        const card = this.realVariants?.variants.find((v) => v.id === this.activeVariant) ?? this.realVariants?.variants.slice(-1)[0];
        await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", variant: card?.segLabel ?? "—", clock: "⏱ ready to iterate" }) });
        return;
      }
      if (e.event === "answer") {
        // A question, not a change — the answer already streamed as narration.
        // Just clear the spinner; no hot-swap, no duration recorded.
        this.iterating = false;
        this.iterateStart = 0;
        await this.persistResult();
        await this.emit({ t: "busy", value: false });
        const card = this.realVariants?.variants.find((v) => v.id === this.activeVariant) ?? this.realVariants?.variants.slice(-1)[0];
        await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", variant: card?.segLabel ?? "—", clock: "⏱ ready to iterate" }) });
        return;
      }
      if (!this.iterating) return; // change already completed on artifact arrival (dedupe)
      this.iterating = false;
      await this.hotSwapVariant(e.variant, e.file);
      return;
    }

    // The run itself crashed (runtime reported, or the runner backstop did).
    if (e.phase === "failed") {
      await this.fail(e.message || "the run failed");
      return;
    }

    // Post-run jobs (extra directions + the prototype/deploy/audit phases)
    // arrive after the run is done; a cold/evicted DO needs its result restored
    // first so the variant list / pages / templates / deploy state aren't
    // clobbered.
    if (e.phase === "variant" || e.phase === "template" || e.phase === "deploy" || e.phase === "audit" || (e.phase === "extract" && e.event === "pages")) {
      await this.rehydrateResult(runId);
    }

    // Audit results (mode=audit job).
    if (e.phase === "audit") {
      const a = ev as { event?: string; report?: string; json?: string; overall?: number; scores?: Record<string, number>; message?: string };
      if (!this.auditState) return;
      if (a.event === "done") {
        this.auditState = {
          ...this.auditState,
          status: "done",
          overall: typeof a.overall === "number" ? a.overall : undefined,
          scores: a.scores,
          reportUrl: a.report ? this.art(a.report) : this.auditState.reportUrl,
          jsonUrl: a.json ? this.art(a.json) : this.auditState.jsonUrl,
        };
        await this.persistResult();
        await this.emit({ t: "panel.audit", audit: this.auditState });
        await this.emit({ t: "message.append", message: { id: `au-${this.seq}`, role: "agent", lead: `✓ Audit done${typeof a.overall === "number" ? ` — **${a.overall}/100**` : ""}. Open the audit rung for the full scored report.` } });
        await this.emit({ t: "busy", value: false });
        await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", clock: "⏱ audit scored" }) });
      } else if (a.event === "failed") {
        this.auditState = { ...this.auditState, status: "failed", message: a.message };
        await this.persistResult();
        await this.emit({ t: "panel.audit", audit: this.auditState });
        await this.emit({ t: "message.append", message: { id: `auerr-${this.seq}`, role: "agent", lead: `Audit failed${a.message ? ` — ${a.message}` : ""}.` } });
        await this.emit({ t: "busy", value: false });
      }
      return;
    }

    // Deploy/rollout progress from the conversion job + the host publisher.
    if (e.phase === "deploy") {
      await this.onDeployEvent(e as { event?: string; slug?: string; url?: string; message?: string; pages?: string[]; live?: boolean; ok?: boolean; flags?: string });
      return;
    }

    // Discovered pages (prototype phase pool) — deterministic, from the runtime.
    if (e.phase === "extract" && e.event === "pages") {
      this.realPages = (e.pages ?? []).filter((p) => p && p.slug && p.url);
      await this.persistResult();
      await this.emit({ t: "panel.pages", pages: this.realPages });
      return;
    }

    // An extra direction (variant D, E, …) — a question, a new card, or a failure.
    if (e.phase === "variant") {
      if (e.event === "answer") { await this.finishVariant(); return; }
      if (e.event === "failed") {
        await this.emit({ t: "message.append", message: { id: `verr-${this.seq}`, role: "agent", lead: `Couldn't generate that direction${e.message ? ` — ${e.message}` : ""}. Try rephrasing.` } });
        await this.finishVariant();
        return;
      }
      if (e.event === "added" && e.card) {
        const card = this.mapVariants([e.card])[0];
        if (card) {
          const list = this.realVariants?.variants ?? [];
          if (!list.some((v) => v.id === card.id)) {
            this.realVariants = { sharedFixes: this.realVariants?.sharedFixes ?? [], variants: [...list, card] };
            await this.persistResult();
            await this.emit({ t: "panel.variants", sharedFixes: this.realVariants.sharedFixes, variants: this.realVariants.variants });
            await this.emit({ t: "message.append", message: { id: `nv-${card.id}-${this.seq}`, role: "agent", lead: `New direction ready — variant **${card.id}**${card.segWord ? ` · ${card.segWord}` : ""}.` } });
            await this.emit({ t: "message.append", message: { id: `art-${card.id}-${this.seq}`, role: "agent", artifact: { kind: "variant", variant: card.id, label: `Variant ${card.id}${card.segWord ? ` — ${card.segWord}` : ""}` } } });
          }
        }
        await this.finishVariant();
        return;
      }
      return;
    }

    // The prototype phase — a page rendered in the chosen direction.
    if (e.phase === "template") {
      const slug = (e.slug ?? "").trim();
      if (e.event === "page_started") {
        if (slug) { this.upsertTemplate({ slug, title: e.title || slug, variant: this.protoVariant ?? "", status: "running" }); await this.emitTemplates(); }
        return;
      }
      if (e.event === "page_done") {
        if (slug) {
          this.upsertTemplate({ slug, title: e.title || slug, variant: this.protoVariant ?? "", status: "done", src: this.art(e.file ?? `${slug}-proposed.html`), thumb: e.thumb ? this.art(e.thumb) : undefined });
          await this.persistResult();
          await this.emitTemplates();
          await this.emit({ t: "message.append", message: { id: `tpl-${slug}-${this.seq}`, role: "agent", lead: `Page **${e.title || slug}** prototyped in variant ${this.protoVariant ?? ""}.` } });
        }
        await this.finishTemplate();
        return;
      }
      if (e.event === "page_failed") {
        if (slug) { this.upsertTemplate({ slug, title: e.title || slug, variant: this.protoVariant ?? "", status: "failed", message: e.message }); await this.persistResult(); await this.emitTemplates(); }
        await this.emit({ t: "message.append", message: { id: `tperr-${this.seq}`, role: "agent", lead: `Couldn't prototype ${e.title || slug || "that page"}${e.message ? ` — ${e.message}` : ""}.` } });
        await this.finishTemplate();
        return;
      }
      if (e.event === "answer") { await this.finishTemplate(); return; }
      return;
    }

    // Long prod runs can evict + reconstruct the DO between milestones, resetting
    // the in-memory accumulators (realBrand/realVariants/realPalette/uplift). A
    // milestone on a cold DO would otherwise lose prior state and clobber
    // result_json. Restore from the persisted result first; persistResult also
    // merges, so partial state never nulls out what's already saved.
    if (!this.uplift) await this.rehydrateResult(runId);

    const set = this.taskSet.bind(this);
    const advance = this.taskAdvance.bind(this);

    // Deterministic phase markers from the runtime's workspace watcher — advance
    // the board the moment a phase's artifact lands instead of waiting for the
    // model to emit its milestone (it batches them late). Board-only: the panel
    // payloads still come from the real milestones.
    if (e.phase === "watch" && e.event === "marker") {
      const m = (ev as { marker?: string }).marker ?? "";
      if (m === "rendered") await advance("crawl", "read", 20, "page captured");
      else if (m === "brand_extracted") await advance("read", "extract", 35, "brand read");
      else if (m === "brand_built") await advance("extract", "analyze", 52, "brand surface built");
      else if (m === "directions") await advance("analyze", "generate", 70, "composing directions");
      else if (m === "designs") {
        set("generate", undefined, "A · B · C");
        if (this.tasks.length) await this.emit({ t: "tasks.init", tasks: this.tasks });
        await this.bumpProgress(78);
        await this.emit({ t: "status", text: "three design systems written" });
      }
      return;
    }

    if (e.phase === "extract" && e.event === "started") {
      await this.emit({ t: "status", text: "reading the site" });
    } else if (e.phase === "extract" && e.event === "seed") {
      await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock: `⏱ seed ${e.seed ?? ""}` } });
      await advance("crawl", "read", 22, "reading the brand");
    } else if (e.phase === "extract" && e.event === "tensions") {
      this.realTensions = e.items ?? [];
      set("analyze", undefined, `${this.realTensions.length} tensions`);
      await advance("read", "extract", 40, "identifying tensions");
    } else if (e.phase === "extract" && e.event === "brand_ready") {
      this.realBrand = { brandReviewUrl: this.art(e.brandReview ?? "brand-review.html"), tensions: this.realTensions };
      if (Array.isArray(e.palette) && e.palette.length) this.realPalette = e.palette.slice(0, 6);
      await this.persistResult();
      // Push the brand panel eagerly so the Brand view/tab populates live (the
      // client owns nav now and no longer sends a nav command to pull it).
      await this.emit({ t: "panel.brand", brandReviewUrl: this.realBrand.brandReviewUrl, tensions: this.realBrand.tensions });
      await this.reestimateEta("brand_ready");
      await advance("extract", "analyze", 58, "brand surface captured");
      await this.emit({ t: "message.append", message: { id: `brand-${this.seq}`, role: "agent", lead: "Brand surface captured — open the snapshot." } });
      await this.emit({ t: "message.append", message: { id: "art-brand", role: "agent", artifact: { kind: "brand", label: "Brand review" } } });
      await this.emit({ t: "snapshot.ready" });
    } else if (e.phase === "direct" && e.event === "variants_ready") {
      this.realVariants = { sharedFixes: e.sharedFixes ?? [], variants: this.mapVariants(e.variants ?? []) };
      const ids = this.realVariants.variants.map((v) => v.id).join(" · ");
      set("generate", undefined, ids || "3 directions");
      await this.persistResult();
      // Push the variants gallery eagerly so the Directions/Workspace tabs enable
      // and variant chips open (the client no longer pulls it via a nav command).
      await this.emit({ t: "panel.variants", sharedFixes: this.realVariants.sharedFixes, variants: this.realVariants.variants });
      await this.reestimateEta("variants_ready");
      await advance("analyze", "generate", 74, "three directions composed");
      await this.emit({ t: "message.append", message: { id: `var-${this.seq}`, role: "agent", lead: "Three directions ready." } });
    } else if (e.phase === "direct" && e.event === "bundle_ready") {
      // Phase 1's deterministic handoff: the workspace bundle is in R2 — fan
      // out one build worker per direction (the parallel pipeline's phase 2).
      await this.fanOutBuilds();
    } else if (e.phase === "prototype" && e.event === "variant_done") {
      set("generate", "done");
      set("validate", "run");
      await this.emit({ t: "tasks.init", tasks: this.tasks });
      await this.emit({ t: "status", text: `variant ${e.variant ?? ""} rendered` });
      const total = this.buildsSucceeded + this.pendingBuilds.length;
      await this.bumpProgress(total > 0 ? Math.min(98, 80 + Math.round((18 * (this.buildsSucceeded + 1)) / total)) : 88);
      await this.reestimateEta("variant_done");
      const vc = this.realVariants?.variants.find((v) => v.id === e.variant);
      if (e.variant && vc) {
        await this.emit({ t: "message.append", message: { id: `art-${e.variant}`, role: "agent", artifact: { kind: "variant", variant: e.variant as VariantId, label: `Variant ${e.variant} — ${vc.segWord}` } } });
      }
      await this.buildSettled(e.variant, true);
    } else if (e.phase === "prototype" && e.event === "variant_failed") {
      await this.emit({ t: "message.append", message: { id: `bferr-${this.seq}`, role: "agent", lead: `Variant ${e.variant ?? ""}'s build failed${e.message ? ` — ${e.message}` : ""}.` } });
      await this.buildSettled(e.variant, false);
    } else if (e.phase === "done") {
      // A parallel run finishes ONLY when its build fan-out drains — a stray
      // `done` from a worker or phase 1 must not complete it early.
      if (this.parallelUplift && (this.pendingBuilds.length > 0 || this.buildsSucceeded === 0)) return;
      await this.completeRun();
    }
  }

  /** Terminal success — reached via the serial pipeline's `done` milestone OR
   *  when the parallel build fan-out drains with ≥1 variant delivered. */
  private async completeRun(): Promise<void> {
    if (this.finished) return;
    // Parallel builds: never finish showing a variant whose page 404s. Verify
    // each gallery variant's page is in R2; re-craft a missing one once, then
    // drop it if the retry also fails.
    if (this.parallelUplift && this.realVariants?.variants.length) {
      const missing: VariantCard[] = [];
      for (const v of this.realVariants.variants) {
        const key = `artifacts/${this.runId}/${RunSession.fileOfSrc(v.src)}`;
        if (!(await this.env.BUCKET.head(key).catch(() => null))) missing.push(v);
      }
      if (missing.length) {
        const creds = await this.jobCreds();
        const retriable = creds ? missing.filter((v) => (this.buildRetries[v.id] ?? 0) < 1) : [];
        if (retriable.length) {
          for (const v of retriable) { this.buildRetries[v.id] = (this.buildRetries[v.id] ?? 0) + 1; this.pendingBuilds.push(v.id); }
          await this.persistResult();
          await this.emit({ t: "busy", value: true });
          await this.emit({ t: "message.append", message: { id: `bretry-${this.seq}`, role: "agent", lead: `Re-crafting variant ${retriable.map((v) => v.id).join(", ")} — the first build didn't land.` } });
          for (const v of retriable) {
            try {
              await this.triggerRuntime({ runId: this.runId, token: creds!.token, backend: creds!.backend, mode: "build", jobId: `bld-${v.id}-r${this.buildRetries[v.id]}`, variantId: v.id, variantFile: RunSession.fileOfSrc(v.src) });
            } catch { await this.buildSettled(v.id, false); }
          }
          return; // completeRun runs again when the retries settle
        }
        // Retry exhausted (or no creds): drop the broken variants so none 404s.
        const keep = this.realVariants.variants.filter((v) => !missing.includes(v));
        this.realVariants = { ...this.realVariants, variants: keep };
        await this.emit({ t: "message.append", message: { id: `bdrop-${this.seq}`, role: "agent", lead: `Couldn't build variant ${missing.map((v) => v.id).join(", ")} — showing the ${keep.length} that rendered.` } });
        await this.emit({ t: "panel.variants", sharedFixes: this.realVariants.sharedFixes, variants: keep });
      }
    }

    // Honest empty state: a real run that produced no variants (bot-wall /
    // too-sparse brand) should say so, not fall back to demo cards.
    const n = this.realVariants?.variants?.length ?? 0;
    if (this.uplift && !n) {
      await this.emit({ t: "message.append", message: { id: `empty-${this.seq}`, role: "agent", lead: "I couldn't read enough of the brand to produce variants — the site may block crawlers or be too sparse. Try another URL." } });
      return this.fail("No variants were produced.");
    }
    this.finished = true;
    this.timings.done = Date.now() - (await this.runStartTs()); // total (learner reads this)
    this.taskSet("generate", "done");
    this.taskSet("validate", "done");
    await this.persistResult();
    if (this.tasks.length) await this.emit({ t: "tasks.init", tasks: this.tasks });
    await this.bumpProgress(100);
    await this.emit({ t: "snapshot.ready" });
    await this.emit({ t: "message.append", message: { id: `done-${this.seq}`, role: "agent", lead: `✓ Done — ${n === 1 ? "the variant is" : `${n} variants`} ready. Open the snapshot.` } });
    await this.emit({ t: "busy", value: false });
    await this.emit({ t: "run.done" });
    await this.env.DB.prepare("UPDATE runs SET status = 'done' WHERE id = ?").bind(this.runId).run();
  }

  /** Parallel uplift phase 2: start one build worker per direction. Idempotent
   *  (a re-delivered bundle_ready won't double-spawn). */
  private async fanOutBuilds(): Promise<void> {
    if (this.finished || this.pendingBuilds.length || this.buildsSucceeded > 0) return;
    const cards = this.realVariants?.variants ?? [];
    if (!cards.length) return this.fail("The directions never arrived — can't build variants.");
    const creds = await this.jobCreds();
    if (!creds) return this.fail("runtime token missing for the build fan-out");
    this.parallelUplift = true; // fan-out implies the split pipeline (survives eviction via builds.parallel)
    this.pendingBuilds = cards.map((c) => c.id);
    // A-first canon freeze (plugin contract): the canon variant builds alone
    // first and re-snapshots the bundle; the siblings fan out when it settles,
    // restoring the refreshed bundle so they fork consistent structure.
    const first = cards.find((c) => c.id === "A") ?? cards[0];
    this.stagedBuilds = cards.filter((c) => c.id !== first.id).map((c) => c.id);
    await this.persistResult();
    this.taskSet("generate", "done");
    this.taskSet("validate", "run");
    if (this.tasks.length) await this.emit({ t: "tasks.init", tasks: this.tasks });
    await this.emit({ t: "status", text: `crafting variant ${first.id} (canon first)` });
    await this.bumpProgress(76);
    await this.emit({ t: "message.append", message: { id: `fan-${this.seq}`, role: "agent", lead: this.stagedBuilds.length
      ? `Directions locked — crafting variant **${first.id}** first (it freezes the canon), then **${this.stagedBuilds.join(" + ")}** in parallel.`
      : `Directions locked — crafting variant **${first.id}**.` } });
    try {
      await this.triggerRuntime({ runId: this.runId, token: creds.token, backend: creds.backend, mode: "build", jobId: `bld-${first.id}`, variantId: first.id, variantFile: RunSession.fileOfSrc(first.src) });
    } catch (err) {
      await this.emit({ t: "message.append", message: { id: `bstart-${this.seq}`, role: "agent", lead: `Couldn't start variant ${first.id}'s build (${(err as Error).message}) — falling back to parallel.` } });
      await this.buildSettled(first.id, false); // also releases the staged siblings
    }
  }

  /** Fan out the builds that waited for the canon variant to settle. */
  private async dispatchStaged(): Promise<void> {
    const ids = this.stagedBuilds;
    if (!ids.length) return;
    this.stagedBuilds = [];
    await this.persistResult();
    const creds = await this.jobCreds();
    const cards = (this.realVariants?.variants ?? []).filter((c) => ids.includes(c.id));
    if (!creds || !cards.length) {
      for (const id of ids) await this.buildSettled(id, false);
      return;
    }
    await this.emit({ t: "status", text: `building ${cards.length} sibling variants in parallel` });
    for (const c of cards) {
      try {
        await this.triggerRuntime({ runId: this.runId, token: creds.token, backend: creds.backend, mode: "build", jobId: `bld-${c.id}`, variantId: c.id, variantFile: RunSession.fileOfSrc(c.src) });
      } catch (err) {
        await this.emit({ t: "message.append", message: { id: `bstart-${this.seq}`, role: "agent", lead: `Couldn't start variant ${c.id}'s build (${(err as Error).message}).` } });
        await this.buildSettled(c.id, false);
      }
    }
  }

  /** A build worker finished (or failed): drain the pending set; complete the
   *  run when it empties — with whatever variants actually delivered. */
  private async buildSettled(variant: string | undefined, ok: boolean): Promise<void> {
    if (!this.pendingBuilds.length) return; // serial pipeline (or already drained)
    // Deterministic truth: a "done" only counts if the variant's page actually
    // landed in R2 — a worker can terminate with a bogus/placeholder milestone
    // (observed: variant "__none__", nothing uploaded).
    const card = this.realVariants?.variants.find((v) => v.id === variant);
    let delivered = ok && !!card;
    if (delivered && card) {
      const key = `artifacts/${this.runId}/${RunSession.fileOfSrc(card.src)}`;
      delivered = !!(await this.env.BUCKET.head(key).catch(() => null));
    }
    // Drain by id when the worker identified itself; otherwise count-based
    // (exactly one worker settled) so an unknown id can't wedge the run.
    this.pendingBuilds = variant && this.pendingBuilds.includes(variant)
      ? this.pendingBuilds.filter((v) => v !== variant)
      : this.pendingBuilds.slice(1);
    if (delivered) this.buildsSucceeded += 1;
    else if (ok) await this.emit({ t: "message.append", message: { id: `bmiss-${this.seq}`, role: "agent", lead: `A build worker finished without delivering its page${variant ? ` (variant ${variant})` : ""} — not counting it.` } });
    await this.persistResult();
    // The canon build settled (delivered or not) — release the staged siblings.
    if (this.stagedBuilds.length) await this.dispatchStaged();
    if (this.pendingBuilds.length) return;
    if (this.buildsSucceeded > 0) return this.completeRun();
    return this.fail("None of the variant builds delivered.");
  }

  /** Mutate one board row (monotonic: a `done` task never regresses — milestones
   *  and markers can arrive out of order). */
  private taskSet(id: string, status?: TaskItem["status"], detail?: string): void {
    const t = this.tasks.find((x) => x.id === id);
    if (!t) return;
    if (status && t.status !== "done") t.status = status;
    if (detail) t.detail = detail;
  }

  private async taskAdvance(doneId: string, nextId: string | null, progress: number, status?: string): Promise<void> {
    this.taskSet(doneId, "done");
    if (nextId) this.taskSet(nextId, "run");
    if (this.tasks.length) await this.emit({ t: "tasks.init", tasks: this.tasks });
    await this.bumpProgress(progress);
    if (status) await this.emit({ t: "status", text: status });
  }

  /** Persist the real result (brand + variants) so a finished run can be
   *  reopened (/?run=<id>) and its brand/variants screens rebuilt. */
  private async persistResult(): Promise<void> {
    // Read-modify-write (merge): only update fields we currently hold in memory,
    // so a cold/evicted DO handling a late milestone can't null out brand /
    // variants / palette that an earlier handler already saved.
    const row = await this.env.DB.prepare("SELECT result_json, mode FROM runs WHERE id = ?").bind(this.runId).first<{ result_json: string | null; mode: string | null }>();
    if (!this.mode && row?.mode) this.mode = row.mode; // survive eviction (start() may not have run this DO instance)
    let cur: { brand?: unknown; variants?: unknown; palette?: unknown; startedAt?: number; timings?: unknown; iterMs?: unknown; pages?: unknown; templates?: unknown; protoVariant?: unknown; finished?: boolean; tasks?: unknown; builds?: unknown; iter?: unknown } = {};
    try { if (row?.result_json) cur = JSON.parse(row.result_json); } catch { /* ignore */ }
    // Fold the ETA timings in on completion (total present) → the learner reads
    // these; keep any prior timings for a mid-run persist.
    const timings = this.finished && this.timings.done
      ? { byLabel: this.timings, total: this.timings.done, pipelineVersion: PIPELINE_VERSION, mode: this.mode }
      : cur.timings;
    const result = JSON.stringify({
      uplift: true,
      brand: this.realBrand ?? cur.brand ?? null,
      variants: this.realVariants ?? cur.variants ?? null,
      palette: this.realPalette ?? cur.palette ?? null,
      startedAt: this.startTs || cur.startedAt || null,
      timings,
      iterMs: cur.iterMs ?? undefined, // preserved; appended by persistIterTiming
      pages: this.realPages.length ? this.realPages : (cur.pages ?? null),
      templates: this.realTemplates.length ? this.realTemplates : (cur.templates ?? null),
      protoVariant: this.protoVariant ?? cur.protoVariant ?? null,
      // Eviction-survival state: terminal flag, the board rows, the parallel
      // build fan-out, and an in-flight iteration (so a late milestone/artifact
      // on a cold DO still completes correctly instead of double-finishing).
      finished: this.finished || cur.finished || false,
      tasks: this.tasks.length ? this.tasks : (cur.tasks ?? null),
      builds: this.parallelUplift || this.pendingBuilds.length || this.buildsSucceeded > 0
        ? { pending: this.pendingBuilds, ok: this.buildsSucceeded, parallel: this.parallelUplift, staged: this.stagedBuilds }
        : (cur.builds ?? null),
      deploy: this.deployState ?? (cur as { deploy?: unknown }).deploy ?? null,
      audit: this.auditState ?? (cur as { audit?: unknown }).audit ?? null,
      demo: this.demo || (cur as { demo?: boolean }).demo || false,
      iter: this.iterating
        ? { v: this.iterateVariant ?? null, f: this.iterateFile ?? null, start: this.iterateStart || 0 }
        : null,
    });
    await this.env.DB.prepare("UPDATE runs SET result_json = ? WHERE id = ?").bind(result, this.runId).run();
  }

  private async rehydrateResult(runId: string): Promise<void> {
    const row = await this.env.DB.prepare("SELECT result_json FROM runs WHERE id = ?").bind(runId).first<{ result_json: string | null }>();
    if (!row?.result_json) return;
    try {
      const r = JSON.parse(row.result_json) as {
        uplift?: boolean;
        brand?: { brandReviewUrl: string; tensions: { n: string; text: string }[] } | null;
        variants?: { sharedFixes: string[]; variants: VariantCard[] } | null;
        palette?: string[] | null;
        startedAt?: number | null;
        timings?: { byLabel?: Record<string, number>; mode?: string } | null;
        pages?: PageCandidate[] | null;
        templates?: TemplatePage[] | null;
        protoVariant?: string | null;
        finished?: boolean;
        tasks?: TaskItem[] | null;
        builds?: { pending?: string[]; ok?: number; parallel?: boolean; staged?: string[] } | null;
        iter?: { v?: string | null; f?: string | null; start?: number } | null;
        deploy?: DeployState | null;
        audit?: AuditState | null;
        demo?: boolean;
      };
      this.uplift = !!r.uplift;
      if (r.brand) this.realBrand = r.brand;
      if (r.variants) this.realVariants = r.variants;
      if (r.palette?.length) this.realPalette = r.palette;
      if (typeof r.startedAt === "number") this.startTs = r.startedAt;
      if (r.timings?.byLabel && !Object.keys(this.timings).length) this.timings = r.timings.byLabel;
      if (r.timings?.mode && !this.mode) this.mode = r.timings.mode;
      if (r.pages?.length && !this.realPages.length) this.realPages = r.pages;
      if (r.templates?.length && !this.realTemplates.length) this.realTemplates = r.templates;
      if (r.protoVariant && !this.protoVariant) this.protoVariant = r.protoVariant;
      if (r.finished) this.finished = true;
      if (Array.isArray(r.tasks) && r.tasks.length && !this.tasks.length) this.tasks = r.tasks;
      if (r.builds && !this.pendingBuilds.length && !this.buildsSucceeded) {
        this.pendingBuilds = r.builds.pending ?? [];
        this.buildsSucceeded = r.builds.ok ?? 0;
        if (r.builds.parallel) this.parallelUplift = true;
        if (r.builds.staged?.length && !this.stagedBuilds.length) this.stagedBuilds = r.builds.staged;
      }
      if (r.iter && !this.iterating) {
        this.iterating = true;
        this.iterateVariant = (r.iter.v ?? undefined) as VariantId | undefined;
        this.iterateFile = r.iter.f ?? undefined;
        this.iterateStart = r.iter.start ?? 0;
      }
      if (r.deploy && !this.deployState) this.deployState = r.deploy;
      if (r.audit && !this.auditState) this.auditState = r.audit;
      if (r.demo) this.demo = true;
    } catch {
      /* ignore malformed */
    }
  }

  /** Called by the Worker when the sandbox agent uploads an artifact. */
  async ingestArtifact(runId: string, rel: string, _contentType: string): Promise<void> {
    if (!this.runId) this.runId = runId;
    // A cold DO must restore the in-flight iteration (and variants) before it
    // can recognize this artifact as an iteration completing.
    if (!this.uplift) await this.rehydrateResult(runId);
    // R2 write is done by the Worker; if a proposed variant arrives while its
    // workspace is open, hot-swap the preview (M6 leans on this). For M5 we just
    // note the brand surface / variants landing.
    if (/(proposed|cinematic)\.html$/.test(rel) || /brand-review\.html$/.test(rel)) {
      // An in-flight iteration completes the instant its updated variant lands —
      // don't wait for the terminal iterate.done milestone (the agent can exit
      // without emitting it, which would strand the UI in "loading").
      if (this.iterating && /(proposed|cinematic)\.html$/.test(rel) && (!this.iterateFile || rel.includes(this.iterateFile))) {
        this.iterating = false;
        await this.hotSwapVariant(this.iterateVariant, this.iterateFile);
        return;
      }
      await this.emit({ t: "rail", rail: { swatches: this.realPalette ?? [], busy: true, clock: `⏱ received ${rel.split("/").pop()}` } });
    }
  }

  private async fail(reason: string): Promise<void> {
    if (this.finished) return; // a completed/failed/canceled run is terminal
    this.finished = true;
    this.clearTimers();
    await this.emit({ t: "busy", value: false });
    await this.emit({ t: "error", message: reason });
    await this.emit({ t: "run.done" });
    await this.env.DB.prepare("UPDATE runs SET status = 'error' WHERE id = ?").bind(this.runId).run();
  }

  /** Stop the current activity. During the main run this cancels the run
   *  (terminal). After the run is done it stops the in-flight post-run job
   *  (iterate/variant/template/audit) but keeps the run's done state, so the
   *  user can interrupt and keep chatting. */
  private async cancel(): Promise<void> {
    const row = await this.env.DB.prepare("SELECT ingest_token AS token FROM runs WHERE id = ?").bind(this.runId).first<{ token: string | null }>();
    if (this.finished) {
      // Post-run activity: kill the job containers, clear job state, stay done.
      await this.stopHands(row?.token ?? null);
      this.iterating = false;
      this.iterateStart = 0;
      this.addingVariant = false;
      this.variantQueue = [];
      this.templateInflight = 0;
      this.realTemplates = this.realTemplates.map((t) => (t.status === "running" ? { ...t, status: "failed", message: "stopped" } : t));
      if (this.auditState?.status === "running") this.auditState = { ...this.auditState, status: "failed", message: "stopped" };
      await this.persistResult();
      await this.emit({ t: "message.append", message: { id: `cx-${this.seq}`, role: "agent", lead: "Stopped. Tell me what you'd like instead." } });
      await this.emit({ t: "busy", value: false });
      return;
    }
    this.finished = true;
    this.clearTimers();
    await this.stopHands(row?.token ?? null);
    await this.emit({ t: "message.append", message: { id: `cx-${this.seq}`, role: "agent", lead: "Run canceled." } });
    await this.emit({ t: "busy", value: false });
    await this.emit({ t: "error", message: "Run canceled." });
    await this.emit({ t: "run.done" });
    await this.env.DB.prepare("UPDATE runs SET status = 'canceled' WHERE id = ?").bind(this.runId).run();
  }

  private async toBrand(): Promise<void> {
    this.clearTimers();
    const url = this.realBrand?.brandReviewUrl ?? brandReviewUrl;
    const tensions = this.realBrand?.tensions?.length ? this.realBrand.tensions : KNACK_TENSIONS;
    const messages: Message[] = this.uplift
      ? [
          { id: "brand-lead", role: "agent", lead: "Here's the brand surface, captured from a live render of the site.", body: ["Open the full audit for the scorecard, or move on to directions."] },
          { id: "brand-tensions", role: "agent", plan: { tag: `${tensions.length} tensions`, steps: tensions } },
        ]
      : [
          {
            id: "brand-lead",
            role: "agent",
            lead: "Here's your brand surface, captured from a live render.",
            body: [
              "Magenta leads the palette but barely shows on screen, the type scale is flat, and there are 21 different CTA labels. A solid product, under-showing itself.",
              "Open the full **audit** for the scorecard and findings, or move on to directions.",
            ],
            seed: KNACK_SEED,
          },
          { id: "brand-tensions", role: "agent", plan: { tag: "3 tensions", steps: KNACK_TENSIONS } },
        ];
    for (const m of messages) await this.emit({ t: "message.append", message: m });
    await this.emit({ t: "panel.brand", brandReviewUrl: url, tensions });
    await this.emit({ t: "rail", rail: this.railState({ note: "brand surface captured", tensions: tensions.length, clock: "⏱ captured" }) });
    await this.emit({ t: "screen", screen: "brand" });
  }

  private async toVariants(): Promise<void> {
    this.clearTimers();
    const cards = this.realVariants?.variants?.length ? this.realVariants.variants : variants;
    const sharedFixes = this.realVariants?.sharedFixes?.length ? this.realVariants.sharedFixes : KNACK_SHARED_FIXES;
    const messages: Message[] = this.uplift
      ? [{ id: "var-lead", role: "agent", lead: "Three directions, all brand-faithful — the shared tensions fixed in each.", body: ["They differ in their bet. Open any card to iterate on it."] }]
      : [
          {
            id: "var-lead",
            role: "agent",
            lead: "Three directions, all brand-faithful — palette and Inter kept, the 5 tensions fixed in each.",
            body: [
              "They differ in their **bet**: A plays it safe, B amplifies the magenta, C makes motion the identity. My pick is **C**.",
              "Each card shows what's fixed and the “what if” behind it. Open any to iterate.",
            ],
            seed: KNACK_SEED,
          },
        ];
    for (const m of messages) await this.emit({ t: "message.append", message: m });
    await this.emit({ t: "panel.variants", sharedFixes, variants: cards });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", tensions: sharedFixes.length, clock: "⏱ 3 directions ready" }) });
    await this.emit({ t: "screen", screen: "variants" });
  }

  private async toWorkspace(id: VariantId): Promise<void> {
    this.clearTimers();
    const cards = this.realVariants?.variants?.length ? this.realVariants.variants : variants;
    const card = cards.find((v) => v.id === id) ?? cards[cards.length - 1];
    this.activeVariant = card.id;
    const messages: Message[] = [
      {
        id: "ws-lead",
        role: "agent",
        lead: `Variant **${id}** — ${card.title.toLowerCase()}. Switch variants in the toolbar, or tell me a change.`,
        body: ["When it's right, hit Deploy."],
      },
    ];
    await this.emit({ t: "panel.workspace", activeVariant: id, variants: cards });
    for (const m of messages) await this.emit({ t: "message.append", message: m });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", variant: card.segLabel, clock: "⏱ ready to iterate" }) });
    await this.emit({ t: "screen", screen: "workspace" });
    await this.env.DB.prepare("UPDATE runs SET status = 'done' WHERE id = ?").bind(this.runId).run();
  }

  private async onCommand(cmd: ClientCommand): Promise<void> {
    if (cmd.t === "nav") {
      if (cmd.to === "brand") return this.toBrand();
      if (cmd.to === "variants") return this.toVariants();
      if (cmd.to === "working") return void this.emit({ t: "screen", screen: "working" });
      return;
    }
    if (cmd.t === "open") return this.toWorkspace(cmd.variant);
    if (cmd.t === "select") { this.activeVariant = cmd.variant; return; }
    if (cmd.t === "cancel") return this.cancel();
    if (cmd.t === "send") return this.onSend(cmd.screen, cmd.text);
    if (cmd.t === "addVariant") {
      await this.emit({ t: "message.append", message: { id: `u-${this.seq}`, role: "user", text: cmd.instruction } });
      return this.demo ? this.demoAddVariant(cmd.instruction) : this.runAddVariant(cmd.instruction);
    }
    if (cmd.t === "setProtoVariant") { this.protoVariant = cmd.variant; await this.emitTemplates(); return; }
    // The action rungs — simulated offline in the demo, real jobs otherwise.
    if (cmd.t === "prototype") return this.demo ? this.demoTemplates(cmd.slugs) : this.runTemplates(cmd.slugs);
    if (cmd.t === "deploy") return this.demo ? this.demoDeploy(cmd.slugs) : this.runDeploy(cmd.slugs);
    if (cmd.t === "golive") return this.demo ? this.demoGoLive() : this.runGoLive();
    if (cmd.t === "rollout") return this.demo ? this.demoRollout() : this.runRollout();
    if (cmd.t === "audit") return this.demo ? this.demoAudit(cmd.target) : this.runAudit(cmd.target);
  }

  /** Run stardust:audit on the original site or the deployed preview. */
  private async runAudit(target: "original" | "deployed"): Promise<void> {
    if (this.auditState?.status === "running") {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "An audit is already running." } });
      return;
    }
    const creds = await this.jobCreds();
    if (!creds) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "I can't audit on this run — its runtime token is missing." } }); return; }
    let url = "";
    if (target === "deployed") {
      const d = this.deployState;
      const home = d?.pages.find((p) => p.slug === "home");
      url = home?.liveUrl ?? home?.previewUrl ?? "";
      if (!url) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Deploy to preview first — then I can audit the deployed site." } }); return; }
    } else {
      const row = await this.env.DB.prepare("SELECT url FROM runs WHERE id = ?").bind(this.runId).first<{ url: string }>();
      url = row?.url ?? "";
      if (!url) return;
    }
    this.auditState = { target, url, status: "running" };
    await this.persistResult();
    await this.emit({ t: "panel.audit", audit: this.auditState });
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Auditing **${target === "deployed" ? "the deployed site" : deriveProject(url)}** — design, SEO, and AI-visibility, scored.` } });
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "eta", seconds: 10 * 60, startedAt: Date.now() });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", busy: true, clock: "⏱ auditing" }) });
    try {
      await this.triggerRuntime({ runId: this.runId, token: creds.token, backend: creds.backend, mode: "audit", jobId: "audit", url });
    } catch (err) {
      this.auditState = { ...this.auditState, status: "failed", message: (err as Error).message };
      await this.persistResult();
      await this.emit({ t: "panel.audit", audit: this.auditState });
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Couldn't start the audit (${(err as Error).message}).` } });
      await this.emit({ t: "busy", value: false });
    }
  }

  /** Demo audit — offline, canned scorecard on the bundled report artifact. */
  private async demoAudit(target: "original" | "deployed"): Promise<void> {
    this.auditState = { target, url: "https://www.knack.com/", status: "running" };
    await this.emit({ t: "panel.audit", audit: this.auditState });
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Auditing **knack.com** — design, SEO, and AI-visibility. (demo)` } });
    await this.demoWait(1600);
    this.auditState = {
      ...this.auditState, status: "done", overall: 72,
      scores: { design: 68, hierarchy: 64, accessibility: 78, performance: 81, seo: 74, "llm-visibility": 61, brand: 79 },
      reportUrl: `${ART}/review/brand-review.html`,
    };
    await this.persistResult();
    await this.emit({ t: "panel.audit", audit: this.auditState });
    await this.emit({ t: "message.append", message: { id: `au-${this.seq}`, role: "agent", lead: "✓ Audit done — **72/100**. Open the audit rung for the scored report. (demo)" } });
    await this.emit({ t: "busy", value: false });
  }

  private async onSend(screen: ScreenId, text: string): Promise<void> {
    await this.emit({ t: "message.append", message: { id: `u-${this.seq}`, role: "user", text } });
    if (this.demo) {
      if (screen === "workspace") return this.demoIterate(text);
      if (screen === "variants") return this.demoAddVariant(text);
      if (screen === "prototype" || screen === "deploy") {
        await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "In the demo, use the page picker and the Deploy / Roll out buttons to drive this step." } });
        return;
      }
      return;
    }
    if (screen === "workspace") return this.iterate(text);
    // Directions chat → explore a new direction; Prototype chat → render/ask about a page.
    if (screen === "variants") return this.runAddVariant(text);
    if (screen === "prototype" || screen === "deploy") return this.runTemplateChat(text);
    this.schedule(550, () =>
      this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "On it — folding that into the work." } }),
    );
  }

  /** M6: a "tell me a change" in the workspace re-renders the active variant.
   *  We spawn an iteration container (via the runner) that re-opens the run's
   *  persisted workspace, applies the change through impeccable, and re-uploads
   *  the variant; ingestEvent(phase:"iterate") then hot-swaps the preview. */
  private async iterate(text: string): Promise<void> {
    const cards = this.realVariants?.variants ?? [];
    const card = cards.find((v) => v.id === this.activeVariant) ?? cards[cards.length - 1];
    // No real variants (scripted demo) → keep a light acknowledgement.
    if (!card) {
      this.schedule(550, () =>
        this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "On it — folding that into the work.", seed: KNACK_SEED } }),
      );
      return;
    }

    const file = RunSession.fileOfSrc(card.src);
    const creds = await this.jobCreds();
    if (!creds) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "I can't re-render this run — its runtime token is missing. Try a fresh run." } });
      return;
    }

    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `On it — variant **${card.id}**: ${text}` } });
    await this.emit({ t: "busy", value: true });
    this.iterateStart = Date.now();
    // Pooled-median iterate ETA (LLM-free), anchored at the iterate start.
    void this.learnIterateEta().then((m) => this.emit({ t: "eta", seconds: Math.round(Math.min(m.p90, Math.max(m.p10, m.median))), startedAt: this.iterateStart })).catch(() => {});
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", variant: card.segLabel, busy: true, clock: `⏱ re-rendering ${card.id}` }) });

    this.iterating = true;
    this.iterateVariant = card.id;
    this.iterateFile = file;
    await this.persistResult(); // survives eviction — completion still hot-swaps
    try {
      await this.triggerRuntime({ runId: this.runId, token: creds.token, backend: creds.backend, mode: "iterate", instruction: text, variantId: card.id, variantFile: file });
    } catch (e) {
      this.iterating = false;
      await this.persistResult();
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Couldn't start the re-render (${(e as Error).message}).` } });
      await this.emit({ t: "busy", value: false });
      await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", variant: card.segLabel, clock: "⏱ ready to iterate" }) });
    }
  }

  /** Re-render finished — bump the active variant's src to force an iframe
   *  reload (R2 serves with a 5-min cache; a ?v= buster defeats it). */
  private async hotSwapVariant(id?: string, file?: string): Promise<void> {
    if (!this.realVariants?.variants?.length) return;
    this.iterVersion += 1;
    const variants = this.realVariants.variants.map((c) => {
      const match = (id && c.id === id) || (file && c.src.includes(file));
      return match ? { ...c, src: `${c.src.split("?")[0]}?v=${this.iterVersion}` } : c;
    });
    this.realVariants = { ...this.realVariants, variants };
    const active = (id as VariantId | undefined) ?? this.activeVariant ?? variants[variants.length - 1].id;
    const card = variants.find((c) => c.id === active) ?? variants[variants.length - 1];
    await this.persistResult(); // clears the persisted in-flight iteration
    await this.emit({ t: "panel.workspace", activeVariant: active, variants });
    await this.emit({ t: "busy", value: false });
    // Record this iteration's wall-clock so the pooled iterate ETA self-calibrates.
    if (this.iterateStart) { await this.persistIterTiming(Date.now() - this.iterateStart); this.iterateStart = 0; }
    await this.emit({ t: "message.append", message: { id: `it-${this.seq}`, role: "agent", lead: `Done — re-rendered variant **${active}**. Switch variants or ask for another change.` } });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", variant: card.segLabel, clock: "⏱ re-rendered" }) });
  }

  /* ---- extra directions (variant D, E, …) + the prototype phase ---- */

  /** Backend + ingest token for a post-run job. Null when the run can't spawn
   *  one (e.g. a legacy run with no token). */
  private async jobCreds(): Promise<{ backend: "cerebras" | "bedrock"; token: string } | null> {
    const row = await this.env.DB.prepare("SELECT mode, ingest_token AS token FROM runs WHERE id = ?").bind(this.runId).first<{ mode: string | null; token: string | null }>();
    if (!row?.token) return null;
    return { backend: row.mode === "cerebras" ? "cerebras" : "bedrock", token: row.token };
  }

  /** The next free variant id (A→Z), skipping ones already in the gallery. */
  private nextVariantId(): string {
    const used = new Set((this.realVariants?.variants ?? []).map((v) => v.id.trim().toUpperCase()));
    for (let c = 65; c <= 90; c++) { const l = String.fromCharCode(c); if (!used.has(l)) return l; }
    return `V${used.size + 1}`;
  }

  /** Generate an additional direction by forking a base variant and re-crafting
   *  it. Sequential (one at a time; extra requests queue). */
  private async runAddVariant(instruction: string): Promise<void> {
    const cards = this.realVariants?.variants ?? [];
    if (!cards.length) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Generate the first directions before adding more." } });
      return;
    }
    if (this.addingVariant) {
      this.variantQueue.push(instruction);
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Queued — I'll explore that direction next." } });
      return;
    }
    const creds = await this.jobCreds();
    if (!creds) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "I can't add a direction to this run — its runtime token is missing. Try a fresh run." } });
      return;
    }
    // Fork the variant the user is looking at (else the recommended, else last).
    const base = cards.find((v) => v.id === this.activeVariant) ?? cards.find((v) => v.recommended) ?? cards[cards.length - 1];
    const baseFile = RunSession.fileOfSrc(base.src);
    const name = this.nextVariantId();
    this.addingVariant = true;
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `On it — a new direction (variant **${name}**), forked from ${base.id}: ${instruction}` } });
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "eta", seconds: VARIANT_ETA, startedAt: Date.now() });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", busy: true, clock: `⏱ crafting variant ${name}` }) });
    try {
      await this.triggerRuntime({ runId: this.runId, token: creds.token, backend: creds.backend, mode: "variant", jobId: "var", instruction, variantName: name, variantFile: baseFile });
    } catch (e) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Couldn't start that (${(e as Error).message}).` } });
      await this.finishVariant();
    }
  }

  /** Clear the extra-direction busy state and start the next queued request. */
  private async finishVariant(): Promise<void> {
    this.addingVariant = false;
    await this.emit({ t: "busy", value: false });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", clock: "⏱ directions ready" }) });
    const next = this.variantQueue.shift();
    if (next) return this.runAddVariant(next);
  }

  private upsertTemplate(t: TemplatePage): void {
    const i = this.realTemplates.findIndex((x) => x.slug === t.slug);
    if (i >= 0) this.realTemplates[i] = { ...this.realTemplates[i], ...t };
    else this.realTemplates = [...this.realTemplates, t];
  }

  private async emitTemplates(): Promise<void> {
    await this.emit({ t: "panel.templates", protoVariant: this.protoVariant ?? "", templates: this.realTemplates });
  }

  /** Decrement the in-flight page count; clear busy when the batch drains. */
  private async finishTemplate(): Promise<void> {
    this.templateInflight = Math.max(0, this.templateInflight - 1);
    if (this.templateInflight === 0) {
      await this.emit({ t: "busy", value: false });
      await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", clock: "⏱ pages ready" }) });
    }
  }

  /** Resolve the direction (variant) the prototype phase renders in. */
  private protoVariantFile(): { variant: string; file: string } | null {
    const cards = this.realVariants?.variants ?? [];
    if (!cards.length) return null;
    const variant = this.protoVariant ?? this.activeVariant ?? cards.find((v) => v.recommended)?.id ?? cards[0].id;
    const card = cards.find((v) => v.id === variant) ?? cards[0];
    this.protoVariant = card.id;
    return { variant: card.id, file: RunSession.fileOfSrc(card.src) };
  }

  /** Prototype selected pages (from the picker) in the chosen direction — one
   *  parallel job per page. */
  private async runTemplates(slugs: string[]): Promise<void> {
    const pin = this.protoVariantFile();
    if (!pin) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Pick a variant direction first." } }); return; }
    const targets = slugs.map((s) => this.realPages.find((p) => p.slug === s)).filter((p): p is PageCandidate => !!p)
      // skip pages already prototyped or in flight
      .filter((p) => !this.realTemplates.some((t) => t.slug === p.slug && (t.status === "done" || t.status === "running" || t.status === "queued")));
    if (!targets.length) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Nothing new to prototype — pick other pages." } }); return; }
    const creds = await this.jobCreds();
    if (!creds) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "I can't prototype pages on this run — its runtime token is missing." } }); return; }
    for (const t of targets) this.upsertTemplate({ slug: t.slug, title: t.title, url: t.url, variant: pin.variant, status: "queued" });
    await this.persistResult();
    await this.emitTemplates();
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Prototyping ${targets.length} page${targets.length > 1 ? "s" : ""} in variant **${pin.variant}**…` } });
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "eta", seconds: TEMPLATE_ETA, startedAt: Date.now() });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", busy: true, clock: `⏱ prototyping ${targets.length} page(s)` }) });
    for (const t of targets) {
      this.templateInflight += 1;
      try {
        await this.triggerRuntime({ runId: this.runId, token: creds.token, backend: creds.backend, mode: "template", jobId: `tpl-${t.slug}`, variantId: pin.variant, variantFile: pin.file, slug: t.slug, pageUrl: t.url, pageTitle: t.title });
      } catch (e) {
        this.upsertTemplate({ slug: t.slug, title: t.title, url: t.url, variant: pin.variant, status: "failed", message: (e as Error).message });
        await this.emitTemplates();
        await this.finishTemplate();
      }
    }
  }

  /** Prototype-phase chat: a free-text request the runtime resolves to a page
   *  (or answers as a question). */
  private async runTemplateChat(text: string): Promise<void> {
    const pin = this.protoVariantFile();
    if (!pin) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Generate the directions first, then pick one to prototype other pages in." } }); return; }
    const creds = await this.jobCreds();
    if (!creds) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "I can't prototype pages on this run — its runtime token is missing." } }); return; }
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `On it — in variant **${pin.variant}**: ${text}` } });
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "eta", seconds: TEMPLATE_ETA, startedAt: Date.now() });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", busy: true, clock: `⏱ prototyping in ${pin.variant}` }) });
    this.templateInflight += 1;
    try {
      await this.triggerRuntime({ runId: this.runId, token: creds.token, backend: creds.backend, mode: "template", jobId: `tpl-chat-${this.seq}`, variantId: pin.variant, variantFile: pin.file, instruction: text });
    } catch (e) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Couldn't start that (${(e as Error).message}).` } });
      await this.finishTemplate();
    }
  }

  /* ---- deploy / rollout: AEM Edge Delivery via DA -------------------------
     One project = one code branch of the EDS repo + one DA content folder.
     A "deploy" job (LLM, in the sandbox) converts prototypes → an _eds/ bundle;
     the deterministic host publisher (runner /publish) pushes code + content,
     previews, verifies, and optionally publishes live. -------------------- */

  /** Per-site EDS conventions. The branch-host label <branch>--<site>--<org>
   *  must fit DNS's 63 chars, so the project slug is trimmed to fit. */
  private async edsConfig(): Promise<{ project: string; org: string; site: string; branch: string; previewHost: string }> {
    const org = this.env.DA_ORG ?? "paolomoz";
    const site = this.env.DA_SITE ?? "stardust-app-fable";
    const row = await this.env.DB.prepare("SELECT url FROM runs WHERE id = ?").bind(this.runId).first<{ url: string }>();
    const host = deriveProject(row?.url ?? "");
    const raw = host.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
    const project = raw.slice(0, Math.max(8, 63 - (site.length + org.length + 4)));
    return { project, org, site, branch: project, previewHost: `https://${project}--${site}--${org}.aem.page` };
  }

  private async emitDeploy(): Promise<void> {
    if (!this.deployState) return;
    await this.persistResult();
    await this.emit({ t: "panel.deploy", deploy: this.deployState });
  }

  private setDeployPage(slug: string | undefined, patch: Partial<DeployPage>): void {
    if (!this.deployState || !slug) return;
    this.deployState.pages = this.deployState.pages.map((p) => (p.slug === slug ? { ...p, ...patch } : p));
  }

  /** Convert + push the selected pages ("home" + prototyped template slugs). */
  private async runDeploy(slugs: string[], opts: { fromRollout?: boolean } = {}): Promise<void> {
    if (this.deployState?.busy && !opts.fromRollout) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "A deploy is already in flight — I'll be done shortly." } });
      return;
    }
    const pin = this.protoVariantFile();
    if (!pin) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Pick a direction first — deploy ships the selected variant." } }); return; }
    const creds = await this.jobCreds();
    if (!creds) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "I can't deploy this run — its runtime token is missing." } }); return; }
    if (this.env.SANDBOX) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Deploy currently runs on the local environment only." } }); return; }

    const cfg = await this.edsConfig();
    const want = slugs.length ? slugs : ["home"];
    const jobPages: { slug: string; title: string; file: string }[] = [];
    for (const s of want) {
      if (s === "home") jobPages.push({ slug: "home", title: "Home", file: pin.file });
      else {
        const t = this.realTemplates.find((x) => x.slug === s && x.status === "done");
        if (t?.src) jobPages.push({ slug: s, title: t.title, file: RunSession.fileOfSrc(t.src) });
      }
    }
    if (!jobPages.length) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Nothing deployable yet — prototype the pages first." } }); return; }

    const prev = this.deployState;
    const merged: DeployPage[] = [...(prev?.pages ?? [])];
    for (const p of jobPages) {
      const i = merged.findIndex((x) => x.slug === p.slug);
      const row: DeployPage = { slug: p.slug, title: p.title, status: "converting" };
      if (i >= 0) merged[i] = { ...merged[i], ...row };
      else merged.push(row);
    }
    this.deployState = {
      ...cfg,
      variant: pin.variant,
      live: prev?.live ?? false,
      busy: true,
      rollout: opts.fromRollout ? true : (prev?.rollout ?? false),
      pages: merged,
    };
    await this.emitDeploy();
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Converting **${jobPages.length} page${jobPages.length > 1 ? "s" : ""}** of variant ${pin.variant} into Edge Delivery blocks — branch \`${cfg.branch}\`, folder \`/${cfg.project}\`.` } });
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "eta", seconds: 8 * 60 + 90 * jobPages.length, startedAt: Date.now() });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", busy: true, clock: `⏱ converting to EDS` }) });
    try {
      await this.triggerRuntime({
        runId: this.runId, token: creds.token, backend: creds.backend, mode: "deploy", jobId: "deploy",
        project: cfg.project, org: cfg.org, site: cfg.site, branch: cfg.branch, previewHost: cfg.previewHost, pages: jobPages,
      });
    } catch (e) {
      await this.onDeployEvent({ event: "failed", message: (e as Error).message });
    }
  }

  /** Publish the already-deployed pages to aem.live. */
  private async runGoLive(): Promise<void> {
    if (this.env.SANDBOX) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Publishing to AEM currently runs on the local environment only." } }); return; }
    const d = this.deployState;
    if (!d || !d.pages.some((p) => p.status === "previewed" || p.status === "live")) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Deploy to preview first — then I can take it live." } });
      return;
    }
    d.busy = true;
    for (const p of d.pages) if (p.status === "previewed") this.setDeployPage(p.slug, { status: "pushing" });
    await this.emitDeploy();
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Publishing **${d.project}** to aem.live…` } });
    await this.emit({ t: "busy", value: true });
    await this.triggerPublish(true);
  }

  /** Whole-site rollout — the plugin's native migrate chain: ONE long job runs
   *  hands-off prepare-migration → migrate → rollout AUTHORING (no transport),
   *  exports the whole site into the same _eds/ contract deploy uses, and the
   *  existing publish → preview → live → verify pipeline ships it. */
  private async runRollout(): Promise<void> {
    if (this.env.SANDBOX) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Whole-site rollout currently runs on the local environment only." } }); return; }
    if (this.deployState?.busy) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "A deploy is already in flight — rollout will have to wait for it." } });
      return;
    }
    const pin = this.protoVariantFile();
    if (!pin) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "Pick a direction first." } }); return; }
    const creds = await this.jobCreds();
    if (!creds) { await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "I can't roll out this run — its runtime token is missing." } }); return; }
    const cfg = await this.edsConfig();
    this.deployState = {
      ...cfg,
      variant: pin.variant,
      live: this.deployState?.live ?? false,
      busy: true,
      rollout: true,
      pages: this.deployState?.pages ?? [],
    };
    await this.emitDeploy();
    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Rolling out **the whole site** in variant ${pin.variant} — the full migration chain (typed inventory → migrate with fidelity tiers → site authoring), then everything ships live. This is the long one.` } });
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "eta", seconds: 60 * 60, startedAt: Date.now() });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", busy: true, clock: "⏱ migrating the site" }) });
    try {
      await this.triggerRuntime({
        runId: this.runId, token: creds.token, backend: creds.backend, mode: "migrate", jobId: "migrate",
        url: (await this.env.DB.prepare("SELECT url FROM runs WHERE id = ?").bind(this.runId).first<{ url: string }>())?.url ?? "",
        project: cfg.project, org: cfg.org, site: cfg.site, branch: cfg.branch, previewHost: cfg.previewHost,
        variantId: pin.variant, pages: [],
      });
    } catch (e) {
      await this.onDeployEvent({ event: "failed", message: (e as Error).message });
    }
  }

  /** Post-preview fidelity verify: the deploy skill's Step 10 (stardust:diff)
   *  + computed-layout gate, run in a sandbox job against the live preview. */
  private async runVerify(): Promise<void> {
    const d = this.deployState;
    if (!d) return;
    const creds = await this.jobCreds();
    if (!creds) return;
    const homeCard = this.realVariants?.variants.find((v) => v.id === d.variant);
    const pages = d.pages
      .filter((p) => p.status === "previewed" || p.status === "live")
      .map((p) => ({
        slug: p.slug,
        title: p.title,
        file: p.slug === "home" ? (homeCard ? RunSession.fileOfSrc(homeCard.src) : "home-C-cinematic.html") : `${p.slug}-proposed.html`,
        daPath: `${d.project}/${p.slug === "home" ? "index" : p.slug}`,
      }));
    if (!pages.length) return;
    await this.emit({ t: "status", text: "verifying fidelity vs the prototypes" });
    try {
      await this.triggerRuntime({
        runId: this.runId, token: creds.token, backend: creds.backend, mode: "verify", jobId: "verify",
        project: d.project, org: d.org, site: d.site, branch: d.branch, previewHost: d.previewHost, pages,
      });
    } catch (e) {
      await this.emit({ t: "message.append", message: { id: `dverr-${this.seq}`, role: "agent", lead: `Couldn't start the fidelity verify (${(e as Error).message}) — the preview is up regardless.` } });
    }
  }

  /** Ask the host runner to run the deterministic EDS publisher. */
  private async triggerPublish(live: boolean): Promise<void> {
    const creds = await this.jobCreds();
    if (!creds) return this.onDeployEvent({ event: "failed", message: "runtime token missing" });
    const url = (this.env.RUNNER_URL ?? "http://localhost:8790/run").replace(/\/run$/, "/publish");
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: this.runId, token: creds.token, live }) });
      if (!r.ok) throw new Error(`publisher ${r.status}: ${(await r.text()).slice(0, 200)}`);
    } catch (e) {
      await this.onDeployEvent({ event: "failed", message: (e as Error).message });
    }
  }

  /** deploy.* progress from the conversion job, the host publisher, and the
   *  fidelity-verify job. */
  private async onDeployEvent(e: { event?: string; slug?: string; url?: string; message?: string; pages?: string[]; live?: boolean; ok?: boolean; flags?: string }): Promise<void> {
    const d = this.deployState;
    if (!d) return;
    if (e.event === "page_converted") {
      // A rollout's migration discovers pages the ledger hasn't seen — grow a
      // row on first sight instead of dropping the event.
      if (e.slug && !d.pages.some((p) => p.slug === e.slug)) d.pages.push({ slug: e.slug, title: e.slug, status: "converted" });
      else this.setDeployPage(e.slug, { status: "converted" });
      await this.emitDeploy();
      await this.emit({ t: "status", text: `converted ${e.slug}` });
      return;
    }
    if (e.event === "bundle_ready") {
      for (const s of e.pages ?? []) if (!d.pages.some((p) => p.slug === s)) d.pages.push({ slug: s, title: s, status: "converted" });
      for (const p of d.pages) if (p.status === "converting" || p.status === "converted") this.setDeployPage(p.slug, { status: "pushing" });
      await this.emitDeploy();
      await this.emit({ t: "message.append", message: { id: `dp-${this.seq}`, role: "agent", lead: `Blocks ready — pushing ${d.pages.length} page${d.pages.length > 1 ? "s" : ""} of code + content…` } });
      await this.triggerPublish(d.rollout || d.live);
      return;
    }
    if (e.event === "code_pushed") { await this.emit({ t: "status", text: `code pushed to ${d.branch}` }); return; }
    if (e.event === "page_pushed") { this.setDeployPage(e.slug, { status: "pushing" }); await this.emitDeploy(); return; }
    if (e.event === "page_previewed") {
      const cur = d.pages.find((p) => p.slug === e.slug);
      this.setDeployPage(e.slug, { status: cur?.status === "live" ? "live" : "previewed", previewUrl: e.url });
      await this.emitDeploy();
      return;
    }
    if (e.event === "page_live") {
      this.setDeployPage(e.slug, { status: "live", liveUrl: e.url });
      d.live = true;
      await this.emitDeploy();
      return;
    }
    if (e.event === "published") {
      d.busy = false;
      if (d.rollout && e.live) d.rollout = false; // the rollout completed
      await this.emitDeploy();
      await this.emit({ t: "busy", value: false });
      const home = `${d.previewHost}/${d.project}/`;
      const liveHome = home.replace(".aem.page", ".aem.live");
      await this.emit({ t: "message.append", message: { id: `dp-${this.seq}`, role: "agent", md: e.live
        ? `✓ **Live** — the site is published.\n\n- Preview: ${home}\n- Live: ${liveHome}`
        : `✓ **Deployed to preview** — ${home}\n\nRunning the fidelity verify (diff vs the prototypes)… Say "go live" (or hit the button) to publish.` } });
      await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", clock: e.live ? "⏱ live" : "⏱ previewed" }) });
      // Step 10: fidelity verify against the real preview (diff probes +
      // computed-layout gate, in the sandbox). Preview-time only — go-live
      // re-publishes already-verified pages.
      if (!e.live) void this.runVerify().catch(() => {});
      return;
    }
    if (e.event === "verify_page") {
      const cur = d.pages.find((p) => p.slug === e.slug);
      if (cur) this.setDeployPage(e.slug, { verified: e.ok !== false, message: e.flags || cur.message });
      await this.emitDeploy();
      return;
    }
    if (e.event === "verified") {
      const flagged = d.pages.filter((p) => p.verified === false).length;
      await this.emit({ t: "message.append", message: { id: `dv-${this.seq}`, role: "agent", lead: e.ok === false && e.message
        ? `⚠ Fidelity verify didn't complete — ${e.message}.`
        : flagged
          ? `Fidelity verify done — **${flagged} page${flagged > 1 ? "s" : ""} flagged** (see the ledger); the rest match the prototypes.`
          : `✓ Fidelity verified — the deployed pages match their prototypes (diff + computed-layout gates).` } });
      await this.emitDeploy();
      return;
    }
    if (e.event === "failed") {
      for (const p of d.pages) if (p.status !== "previewed" && p.status !== "live") this.setDeployPage(p.slug, { status: "failed", message: e.message });
      d.busy = false;
      d.rollout = false;
      await this.emitDeploy();
      await this.emit({ t: "busy", value: false });
      await this.emit({ t: "message.append", message: { id: `dperr-${this.seq}`, role: "agent", lead: `Deploy failed${e.message ? ` — ${e.message}` : ""}.` } });
      await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", clock: "⏱ deploy failed" }) });
      return;
    }
  }
}

