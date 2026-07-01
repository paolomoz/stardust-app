/* ===========================================================================
   RunSession Durable Object — one per run, the run's source of truth. Accepts
   WebSocket connections, scripts the knack uplift run (M2: timed events; M5: the
   same events derived from the agent), persists the timeline to D1, and
   re-emits any screen's payload on a client nav command.
   =========================================================================== */
import { DurableObject } from "cloudflare:workers";
import { getContainer } from "@cloudflare/containers";
import type { Env } from "./index";
import type { Message, RailState, ScreenId, TaskItem, VariantCard, VariantId } from "../state";
import type { ClientCommand, ServerEvent } from "../shared/protocol";
import { createSession, sendUserMessage, streamEvents, type MaCreds } from "./managedAgents";
import { callHaiku } from "./haiku";
import {
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
const PIPELINE_VERSION = "serial-1";
type EtaModel = { f: Record<string, number>; meanTotal: number; p10: number; p90: number; hasHistory: boolean };
// Fallback when there's no matching history — fractions (elapsed_at(label)/total)
// + bounds seeded from the measured hirslanden.ch prod run (~29 min, 2026-07-01).
const ETA_DEFAULTS: EtaModel = {
  f: { brand_ready: 0.23, variants_ready: 0.92, variant_done: 0.97 },
  meanTotal: 1740, p10: 12 * 60, p90: 45 * 60, hasHistory: false,
};
// Iterate ETA: pooled median of past iteration durations (LLM-free, no similarity
// index — one bucket per backend). Default until history accrues (seconds).
const ITER_ETA_DEFAULT = { median: 90, p10: 30, p90: 360 };

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
  // Dynamic ETA state (see PIPELINE_VERSION / ETA_DEFAULTS above).
  private etaModel: EtaModel | null = null;
  private startTs = 0;                            // run start (ms epoch) = MIN(run_events.ts)
  private lastEta = 0;                            // last emitted TOTAL seconds (EMA glide)
  private timings: Record<string, number> = {};  // milestone label -> elapsed ms (this run)
  private mode = "";

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
    // Stored rail events bake in run-time swatches; if we know the real palette,
    // resend the last rail corrected (display-only, not persisted).
    if (this.realPalette?.length) {
      const lastRail = [...this.events].reverse().find((ev) => ev.t === "rail");
      if (lastRail && lastRail.t === "rail") {
        server.send(JSON.stringify({ t: "rail", rail: { ...lastRail.rail, swatches: this.realPalette } }));
      }
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
    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        this.sockets.delete(ws);
      }
    }
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

  /** Quick LLM time estimate (Haiku) for the in-flight task, in seconds. Runs
   *  in parallel with the real work, clamped to a sane range, with a heuristic
   *  fallback when the model/key is unavailable. */
  private async estimateEta(kind: "run" | "iterate", detail: string): Promise<number> {
    const fallback = kind === "run" ? 22 * 60 : 3 * 60;
    const prompt = kind === "run"
      ? `A design studio will fully redesign the homepage at ${detail} into three polished, brand-faithful variants: read the live brand, identify tensions, then build three production-quality HTML pages with in-browser visual QA. Estimate the wall-clock time in MINUTES for a thorough job. Reply with ONLY an integer.`
      : `A designer will apply this single change to an existing prototype web page, including in-browser QA: "${detail}". Estimate the wall-clock time in MINUTES. Reply with ONLY an integer.`;
    const text = await callHaiku(this.env, prompt, 8);
    const mins = parseInt(text.match(/\d+/)?.[0] ?? "", 10);
    if (!Number.isFinite(mins)) return fallback;
    const clamped = kind === "run" ? Math.min(45, Math.max(8, mins)) : Math.min(12, Math.max(1, mins));
    return clamped * 60;
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

  /** Learn the milestone-fraction model from recent completed REAL runs. Reads
   *  result_json.timings (folded in on done); filters to the current pipeline
   *  version; falls back to ETA_DEFAULTS when there's no matching history. */
  private async learnEta(): Promise<EtaModel> {
    try {
      // Backend-aware: opus (bedrock/uplift) ≈29m vs cerebras ≈minutes — never
      // blend their totals. Learn only from the current run's timing class.
      const cls = this.mode === "bedrock" || this.mode === "uplift" ? ["bedrock", "uplift"]
        : this.mode ? [this.mode] : ["bedrock", "uplift"];
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
      const cls = this.mode === "bedrock" || this.mode === "uplift" ? ["bedrock", "uplift"]
        : this.mode ? [this.mode] : ["bedrock", "uplift"];
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

  /** t=0 prior: historical mean (LLM-free) when we have history, else the Haiku
   *  guess as a weak fallback. Emits the initial ETA anchored at run start. */
  private async primeEta(detail: string): Promise<void> {
    const m = (this.etaModel = await this.learnEta());
    const start = await this.runStartTs();
    let seconds = m.meanTotal;
    if (!m.hasHistory) { const h = await this.estimateEta("run", detail).catch(() => 0); if (h) seconds = h; }
    seconds = Math.round(Math.min(m.p90, Math.max(m.p10, seconds)));
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
    if (this.lastEta > 0) est = 0.5 * est + 0.5 * this.lastEta; // glide, don't jerk
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
    const row = await this.env.DB.prepare("SELECT url, mode FROM runs WHERE id = ?")
      .bind(runId)
      .first<{ url: string; mode: string }>();
    const url = row?.url ?? "https://www.knack.com/";
    this.mode = row?.mode ?? "";
    this.project = deriveProject(url);
    await this.env.DB.prepare("UPDATE runs SET status = 'running', project = ? WHERE id = ?")
      .bind(this.project, runId)
      .run();

    if (row?.mode === "cerebras") return this.runRuntime(url, "cerebras");
    if (row?.mode === "bedrock") return this.runRuntime(url, "bedrock");
    if (row?.mode === "uplift") return this.runUplift(url);
    if (row?.mode === "agent" || row?.mode === "probe") return this.runAgent(url, row.mode === "probe");
    return this.runScripted(url, runId);
  }

  /* ---- M2 scripted demo run ---- */

  private async runScripted(url: string, runId: string): Promise<void> {
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
        this.schedule(1000, () => this.toWorkspace("C"));
      });
    });
  }

  /* ---- M3+ real run: a Managed Agents session, streamed to the UI ---- */

  private async runAgent(url: string, probe = false): Promise<void> {
    const { ANTHROPIC_API_KEY, STARDUST_AGENT_ID, STARDUST_ENVIRONMENT_ID } = this.env;
    await this.emit({ t: "run.started", runId: this.runId, url, projectName: this.project, seed: KNACK_SEED });
    await this.emit({ t: "phase", phase: "prototype" });
    await this.emit({ t: "tasks.init", tasks: [] });
    await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock: "⏱ agent session · live" } });
    await this.emit({ t: "screen", screen: "working" });

    if (!ANTHROPIC_API_KEY || !STARDUST_AGENT_ID || !STARDUST_ENVIRONMENT_ID) {
      await this.emit({
        t: "message.append",
        message: { id: "no-creds", role: "agent", lead: "Managed Agents not configured. Run agent/setup.mjs and restart dev (see agent/README.md)." },
      });
      await this.fail("missing Managed Agents credentials");
      return;
    }
    const creds: MaCreds = { apiKey: ANTHROPIC_API_KEY, agentId: STARDUST_AGENT_ID, environmentId: STARDUST_ENVIRONMENT_ID };

    // M3 connectivity check — proves session + tools + SSE relay without skills.
    // M5 swaps this for: `Redesign ${url}. Run stardust:uplift <URL> to completion…`
    const connectivityPrompt =
      "Connectivity check from the stardust web app. In one short sentence, confirm you're running. " +
      "Then create the file /mnt/session/outputs/hello.txt containing 'stardust online' and stop.";

    // Skill-load probe (/?mode=probe) — cheap: just reads the baked SKILL.md and
    // reports. No Playwright, no URL fetch, no redesign. Proves the brain can
    // find, read, and understand the stardust skill before a full uplift.
    const probePrompt =
      "Skill-load probe — DO NOT run a redesign, DO NOT launch Playwright, DO NOT fetch any URL. " +
      "The stardust skills are baked at /workspace/skills. Do exactly this:\n" +
      "1) Run `ls /workspace/skills/stardust` to see the available skills.\n" +
      "2) Read /workspace/skills/stardust/uplift/SKILL.md.\n" +
      "3) Read the first heading of /workspace/skills/impeccable/SKILL.md.\n" +
      "Then, as your FINAL message (this is required — write it as plain text in the chat, " +
      "do not skip it), report your findings in this exact shape:\n" +
      "• Skills found: <comma-separated list from step 1>\n" +
      "• uplift: <2–3 sentences on what stardust:uplift does and the exact phase chain it runs>\n" +
      "• impeccable: present — \"<the first heading text>\"\n" +
      "Keep it tight, then stop.";

    const prompt = probe ? probePrompt : connectivityPrompt;

    try {
      const sessionId = await createSession(creds, `stardust · ${this.project}`, { url });
      await this.emit({ t: "message.append", message: { id: "sess", role: "agent", lead: `Session started — **${sessionId.slice(0, 8)}**. Working…` } });
      await sendUserMessage(creds, sessionId, prompt);

      for await (const ev of streamEvents(creds, sessionId)) {
        if (ev.type === "agent.message") {
          const content = (ev as { content?: { text?: string }[] }).content ?? [];
          const text = content.map((b) => b.text ?? "").join("").trim();
          if (text) await this.emit({ t: "message.append", message: { id: `m-${this.seq}`, role: "agent", lead: text } });
        } else if (ev.type === "agent.tool_use") {
          const name = (ev as { name?: string }).name ?? "tool";
          await this.emit({ t: "message.append", message: { id: `t-${this.seq}`, role: "agent", lead: `› tool: **${name}**` } });
        } else if (ev.type === "session.status_idle") {
          await this.emit({ t: "message.append", message: { id: "fin", role: "agent", lead: "✓ Agent finished." } });
          await this.emit({ t: "rail", rail: { swatches: KNACK_PALETTE, note: "session idle", clock: "⏱ done" } });
          await this.emit({ t: "run.done" });
          await this.env.DB.prepare("UPDATE runs SET status = 'done' WHERE id = ?").bind(this.runId).run();
          break;
        } else if (ev.type === "session.error") {
          await this.fail(`session error: ${JSON.stringify((ev as { error?: unknown }).error ?? ev)}`);
          break;
        }
      }
    } catch (e) {
      await this.emit({ t: "message.append", message: { id: "err", role: "agent", lead: `Run error: ${String((e as Error).message ?? e)}` } });
      await this.fail(String(e));
    }
  }

  /* ---- M5 real uplift run: stardust:uplift in the sandbox, screens driven by
     milestones + artifacts the agent pushes to the ingest endpoints. The SSE
     stream feeds only the conversation narration. ---- */

  private async runUplift(url: string): Promise<void> {
    this.uplift = true;
    const { ANTHROPIC_API_KEY, STARDUST_AGENT_ID, STARDUST_ENVIRONMENT_ID } = this.env;

    this.tasks = UPLIFT_TASKS.map((t) => ({ ...t }));
    this.tasks[0].status = "run";
    await this.emit({ t: "run.started", runId: this.runId, url, projectName: this.project, seed: "—" });
    await this.emit({ t: "phase", phase: "prototype" });
    await this.emit({ t: "tasks.init", tasks: this.tasks });
    await this.emit({ t: "progress", value: 5 });
    await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock: "⏱ uplift · live" } });
    await this.emit({ t: "screen", screen: "working" });

    if (!ANTHROPIC_API_KEY || !STARDUST_AGENT_ID || !STARDUST_ENVIRONMENT_ID) {
      await this.emit({ t: "message.append", message: { id: "no-creds", role: "agent", lead: "Managed Agents not configured. Run agent/setup.mjs and restart dev." } });
      return this.fail("missing Managed Agents credentials");
    }
    const creds: MaCreds = { apiKey: ANTHROPIC_API_KEY, agentId: STARDUST_AGENT_ID, environmentId: STARDUST_ENVIRONMENT_ID };

    // Per-run ingest token — the agent authorizes its pushes with it.
    const token = crypto.randomUUID().replace(/-/g, "");
    await this.env.DB.prepare("UPDATE runs SET ingest_token = ? WHERE id = ?").bind(token, this.runId).run();

    const base = this.env.INGEST_BASE ?? "http://host.docker.internal:5173";
    const ingest = `${base}/api/ingest/${this.runId}`;
    const prompt =
      `Redesign ${url} for presales. Run stardust:uplift to completion, non-interactively.\n\n` +
      `INGEST — push progress + deliverables here so the web UI updates live. ` +
      `Add this header to every ingest call: Authorization: Bearer ${token}\n` +
      `1) Milestones — POST ${ingest}/event with content-type application/json, one JSON object per ` +
      `milestone, exactly the shapes defined in your system prompt (extract.started/seed/tensions/` +
      `brand_ready, direct.variants_ready, prototype.variant_done, done). Send each the moment it happens.\n` +
      `2) Deliverables — PUT ${ingest}/artifact/<relative-path> with the file bytes and a correct ` +
      `content-type, preserving paths relative to /mnt/session/outputs (so brand-review.html, its ` +
      `assets/*, the three home-*-proposed.html, and assets/thumb-{A,B,C}.png all resolve). Upload the ` +
      `brand surface as soon as it exists, each variant as it finishes.\n` +
      `Paths in milestone JSON must match the artifact paths you upload. Begin now.`;

    try {
      const sessionId = await createSession(creds, `stardust uplift · ${this.project}`, { url, runId: this.runId });
      await this.emit({ t: "message.append", message: { id: "sess", role: "agent", lead: `Session started — **${sessionId.slice(0, 8)}**. Reading ${this.project}…` } });
      await sendUserMessage(creds, sessionId, prompt);

      for await (const ev of streamEvents(creds, sessionId)) {
        if (ev.type === "agent.message") {
          const content = (ev as { content?: { text?: string }[] }).content ?? [];
          const text = content.map((b) => b.text ?? "").join("").trim();
          if (text) await this.emit({ t: "message.append", message: { id: `m-${this.seq}`, role: "agent", lead: text } });
        } else if (ev.type === "agent.tool_use") {
          const name = (ev as { name?: string }).name ?? "tool";
          await this.emit({ t: "message.append", message: { id: `t-${this.seq}`, role: "agent", lead: `› ${name}` } });
        } else if (ev.type === "session.status_idle") {
          // A turn boundary — NOT necessarily completion. The agent runs many
          // turns; finish only once its {"phase":"done"} milestone has arrived
          // (which sets this.finished via ingestEvent). Otherwise keep streaming.
          if (this.finished) break;
        } else if (ev.type === "session.error") {
          await this.fail(`session error: ${JSON.stringify((ev as { error?: unknown }).error ?? ev)}`);
          break;
        }
      }
      // Stream closed (worker stopped) without an explicit done milestone — finalize.
      if (!this.finished) {
        await this.emit({ t: "message.append", message: { id: "fin", role: "agent", lead: "✓ stardust finished." } });
        await this.emit({ t: "run.done" });
        await this.env.DB.prepare("UPDATE runs SET status = 'done' WHERE id = ?").bind(this.runId).run();
      }
    } catch (e) {
      await this.emit({ t: "message.append", message: { id: "err", role: "agent", lead: `Run error: ${String((e as Error).message ?? e)}` } });
      await this.fail(String(e));
    }
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
    const clock = backend === "bedrock" ? "⏱ bedrock · opus · live" : "⏱ cerebras · gemma · live";
    const label = backend === "bedrock" ? "Bedrock/Opus" : "Cerebras";
    await this.emit({ t: "run.started", runId: this.runId, url, projectName: this.project, seed: "—" });
    await this.emit({ t: "phase", phase: "prototype" });
    await this.emit({ t: "tasks.init", tasks: this.tasks });
    await this.emit({ t: "progress", value: 5 });
    await this.emit({ t: "busy", value: true });
    await this.emit({ t: "rail", rail: { swatches: [], busy: true, clock } });
    await this.emit({ t: "message.append", message: { id: "intro", role: "agent", lead: `On it — reading **${this.project}**, learning the brand, and composing directions.`, body: ["This normally takes a few minutes. I'll show the snapshot the moment it's ready."] } });
    await this.emit({ t: "screen", screen: "working" });
    void this.primeEta(url).catch(() => {});

    const token = crypto.randomUUID().replace(/-/g, "");
    await this.env.DB.prepare("UPDATE runs SET ingest_token = ? WHERE id = ?").bind(token, this.runId).run();

    try {
      await this.triggerRuntime({ runId: this.runId, url, token, backend });
      await this.emit({ t: "message.append", message: { id: "sess", role: "agent", lead: `${label} runtime started — reading ${this.project}…` } });
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
      const c = getContainer(this.env.SANDBOX, this.runId);
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
    const e = (ev ?? {}) as { type?: string; text?: string; name?: string; phase?: string; event?: string; seed?: string; items?: { n: string; text: string }[]; brandReview?: string; sharedFixes?: string[]; variants?: unknown[]; variant?: string; file?: string; message?: string; palette?: string[] };

    // Narration / tool activity from the open-loop runtime → conversation thread.
    if (e.type === "narration" && e.text) {
      await this.emit({ t: "message.append", message: { id: `m-${this.seq}`, role: "agent", lead: e.text } });
      return;
    }
    if (e.type === "tool") {
      await this.emit({ t: "message.append", message: { id: `t-${this.seq}`, role: "agent", tool: e.name ?? "tool" } });
      return;
    }

    // M6: an iteration finished. Failure must NOT fail the (already-done) run —
    // just report it and leave the variant usable; success hot-swaps the preview.
    if (e.phase === "iterate") {
      if (e.event === "failed") {
        this.iterating = false;
        await this.emit({ t: "busy", value: false });
        await this.emit({ t: "message.append", message: { id: `iterr-${this.seq}`, role: "agent", lead: `Couldn't apply that change${e.message ? ` — ${e.message}` : ""}. The variant is unchanged — try rephrasing.` } });
        const card = this.realVariants?.variants.find((v) => v.id === this.activeVariant) ?? this.realVariants?.variants.slice(-1)[0];
        await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", variant: card?.segLabel ?? "—", clock: "⏱ ready to iterate" }) });
        return;
      }
      if (!this.iterating) return; // already completed on artifact arrival (dedupe)
      this.iterating = false;
      await this.hotSwapVariant(e.variant, e.file);
      return;
    }

    // The run itself crashed (runtime reported, or the runner backstop did).
    if (e.phase === "failed") {
      await this.fail(e.message || "the run failed");
      return;
    }

    // Long prod runs can evict + reconstruct the DO between milestones, resetting
    // the in-memory accumulators (realBrand/realVariants/realPalette/uplift). A
    // milestone on a cold DO would otherwise lose prior state and clobber
    // result_json. Restore from the persisted result first; persistResult also
    // merges, so partial state never nulls out what's already saved.
    if (!this.uplift) await this.rehydrateResult(runId);

    const set = (id: string, status?: TaskItem["status"], detail?: string) => {
      const t = this.tasks.find((x) => x.id === id);
      if (!t) return;
      // Monotonic: a `done` task never regresses. Milestones can arrive out of
      // order (e.g. the agent emits `tensions` after `brand_ready`), which would
      // otherwise flip an already-completed row back to spinning and strand it.
      if (status && t.status !== "done") t.status = status;
      if (detail) t.detail = detail;
    };
    const advance = async (doneId: string, nextId: string | null, progress: number, status?: string) => {
      set(doneId, "done");
      if (nextId) set(nextId, "run");
      if (this.tasks.length) await this.emit({ t: "tasks.init", tasks: this.tasks });
      await this.emit({ t: "progress", value: progress });
      if (status) await this.emit({ t: "status", text: status });
    };

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
    } else if (e.phase === "prototype" && e.event === "variant_done") {
      set("generate", "run");
      await this.emit({ t: "tasks.init", tasks: this.tasks });
      await this.emit({ t: "status", text: `variant ${e.variant ?? ""} rendered` });
      await this.emit({ t: "progress", value: 88 });
      await this.reestimateEta("variant_done");
      if (e.variant) {
        const vc = this.realVariants?.variants.find((v) => v.id === e.variant);
        await this.emit({ t: "message.append", message: { id: `art-${e.variant}`, role: "agent", artifact: { kind: "variant", variant: e.variant as VariantId, label: `Variant ${e.variant}${vc ? ` — ${vc.segWord}` : ""}` } } });
      }
    } else if (e.phase === "done") {
      if (this.finished) return;
      // Honest empty state: a real run that produced no variants (bot-wall /
      // too-sparse brand) should say so, not fall back to demo cards.
      if (this.uplift && !this.realVariants?.variants?.length) {
        await this.emit({ t: "message.append", message: { id: `empty-${this.seq}`, role: "agent", lead: "I couldn't read enough of the brand to produce variants — the site may block crawlers or be too sparse. Try another URL." } });
        return this.fail("No variants were produced.");
      }
      this.finished = true;
      this.timings.done = Date.now() - (await this.runStartTs()); // total (learner reads this)
      set("generate", "done");
      set("validate", "done");
      await this.persistResult();
      if (this.tasks.length) await this.emit({ t: "tasks.init", tasks: this.tasks });
      await this.emit({ t: "progress", value: 100 });
      await this.emit({ t: "snapshot.ready" });
      await this.emit({ t: "message.append", message: { id: `done-${this.seq}`, role: "agent", lead: "✓ Done — three variants ready. Open the snapshot." } });
      await this.emit({ t: "busy", value: false });
      await this.emit({ t: "run.done" });
      await this.env.DB.prepare("UPDATE runs SET status = 'done' WHERE id = ?").bind(this.runId).run();
    }
  }

  /** Persist the real result (brand + variants) so a finished run can be
   *  reopened (/?run=<id>) and its brand/variants screens rebuilt. */
  private async persistResult(): Promise<void> {
    // Read-modify-write (merge): only update fields we currently hold in memory,
    // so a cold/evicted DO handling a late milestone can't null out brand /
    // variants / palette that an earlier handler already saved.
    const row = await this.env.DB.prepare("SELECT result_json, mode FROM runs WHERE id = ?").bind(this.runId).first<{ result_json: string | null; mode: string | null }>();
    if (!this.mode && row?.mode) this.mode = row.mode; // survive eviction (start() may not have run this DO instance)
    let cur: { brand?: unknown; variants?: unknown; palette?: unknown; startedAt?: number; timings?: unknown; iterMs?: unknown } = {};
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
      };
      this.uplift = !!r.uplift;
      if (r.brand) this.realBrand = r.brand;
      if (r.variants) this.realVariants = r.variants;
      if (r.palette?.length) this.realPalette = r.palette;
      if (typeof r.startedAt === "number") this.startTs = r.startedAt;
      if (r.timings?.byLabel && !Object.keys(this.timings).length) this.timings = r.timings.byLabel;
      if (r.timings?.mode && !this.mode) this.mode = r.timings.mode;
    } catch {
      /* ignore malformed */
    }
  }

  /** Called by the Worker when the sandbox agent uploads an artifact. */
  async ingestArtifact(runId: string, rel: string, _contentType: string): Promise<void> {
    if (!this.runId) this.runId = runId;
    // R2 write is done by the Worker; if a proposed variant arrives while its
    // workspace is open, hot-swap the preview (M6 leans on this). For M5 we just
    // note the brand surface / variants landing.
    if (/proposed\.html$/.test(rel) || /brand-review\.html$/.test(rel)) {
      // An in-flight iteration completes the instant its updated variant lands —
      // don't wait for the terminal iterate.done milestone (the agent can exit
      // without emitting it, which would strand the UI in "loading").
      if (this.iterating && /proposed\.html$/.test(rel) && (!this.iterateFile || rel.includes(this.iterateFile))) {
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

  /** Stop an in-flight run: kill its container (via the runner) and mark it
   *  canceled. No-op once the run is terminal. */
  private async cancel(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.clearTimers();
    const row = await this.env.DB.prepare("SELECT ingest_token AS token FROM runs WHERE id = ?").bind(this.runId).first<{ token: string | null }>();
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
  }

  private async onSend(screen: ScreenId, text: string): Promise<void> {
    await this.emit({ t: "message.append", message: { id: `u-${this.seq}`, role: "user", text } });
    if (screen === "workspace") return this.iterate(text);
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

    const file = (card.src.split("?")[0].split("/").pop() ?? "").trim();
    const row = await this.env.DB.prepare("SELECT mode, ingest_token AS token FROM runs WHERE id = ?")
      .bind(this.runId)
      .first<{ mode: string | null; token: string | null }>();
    const backend = row?.mode === "cerebras" ? "cerebras" : "bedrock";
    const token = row?.token;
    if (!token) {
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: "I can't re-render this run — its runtime token is missing. Try a fresh run." } });
      return;
    }

    await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `On it — re-rendering variant **${card.id}**: ${text}` } });
    await this.emit({ t: "busy", value: true });
    this.iterateStart = Date.now();
    // Pooled-median iterate ETA (LLM-free), anchored at the iterate start.
    void this.learnIterateEta().then((m) => this.emit({ t: "eta", seconds: Math.round(Math.min(m.p90, Math.max(m.p10, m.median))), startedAt: this.iterateStart })).catch(() => {});
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", variant: card.segLabel, busy: true, clock: `⏱ re-rendering ${card.id}` }) });

    this.iterating = true;
    this.iterateVariant = card.id;
    this.iterateFile = file;
    try {
      await this.triggerRuntime({ runId: this.runId, token, backend, mode: "iterate", instruction: text, variantId: card.id, variantFile: file });
    } catch (e) {
      this.iterating = false;
      await this.emit({ t: "message.append", message: { id: `a-${this.seq}`, role: "agent", lead: `Couldn't start the re-render (${(e as Error).message}).` } });
      await this.emit({ t: "busy", value: false });
      await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", variant: card.segLabel, clock: "⏱ ready to iterate" }) });
    }
  }

  /** Re-render finished — bump the active variant's src to force an iframe
   *  reload (R2 serves with a 5-min cache; a ?v= buster defeats it). */
  private async hotSwapVariant(id?: string, file?: string): Promise<void> {
    if (!this.realVariants) return;
    this.iterVersion += 1;
    const variants = this.realVariants.variants.map((c) => {
      const match = (id && c.id === id) || (file && c.src.includes(file));
      return match ? { ...c, src: `${c.src.split("?")[0]}?v=${this.iterVersion}` } : c;
    });
    this.realVariants = { ...this.realVariants, variants };
    const active = (id as VariantId | undefined) ?? this.activeVariant ?? variants[variants.length - 1].id;
    const card = variants.find((c) => c.id === active) ?? variants[variants.length - 1];
    await this.emit({ t: "panel.workspace", activeVariant: active, variants });
    await this.emit({ t: "busy", value: false });
    // Record this iteration's wall-clock so the pooled iterate ETA self-calibrates.
    if (this.iterateStart) { await this.persistIterTiming(Date.now() - this.iterateStart); this.iterateStart = 0; }
    await this.emit({ t: "message.append", message: { id: `it-${this.seq}`, role: "agent", lead: `Done — re-rendered variant **${active}**. Switch variants or ask for another change.` } });
    await this.emit({ t: "rail", rail: this.railState({ signature: "watch it build", variant: card.segLabel, clock: "⏱ re-rendered" }) });
  }
}

