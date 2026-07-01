# Stateful agentic sessions — durable conversation, ephemeral compute (draft, not executed)

Goal: give workspace iteration a **true agentic session** that keeps context
between prompts, so "undo the last change", "make it more like before", "why did
you do X" work — without holding any compute open. Nothing here is executed yet.

## Problem today (stateless iterations)
Each adjustment spawns a fresh throwaway container (`docker run --rm`, new
`agent.mjs`) with a brand-new LLM conversation. It's handed only: the current
variant *file* (R2), the original design context (`_ctx/`), and the new
instruction. **No chat history, no record of prior instructions or what it
changed.** So "undo editing the hero title" made the agent *re-derive* the
original from the capture (inference, not memory); "undo the last 3 changes" or
"like before" would be unreliable/impossible. It also re-reads skills + redoes
setup every iteration.

Confirmed in code: `runSession.iterate()` → `triggerRuntime({mode:"iterate",
instruction, variantId, variantFile})` (no history); `agent.mjs` iterateTask =
just the instruction; `loop.mjs` builds a fresh `messages=[system,task]` each run.

## Recommended architecture: A — persist the conversation, restore-and-append
`loop.mjs` already builds a `messages` array (system → user → assistant/tool
turns) and throws it away on `--rm` exit. Instead:
- **End of each turn:** serialize `messages` (+ usage) to R2 — one blob per
  **session**.
- **Next prompt:** a fresh container **downloads the history, appends the new
  user turn, continues the loop.**

Container stays throwaway; the **session becomes stateful**. Fits Cloudflare
Containers' sleep/evict model perfectly (nothing kept alive). This is the
smallest change that yields a real agentic session.

### Session scope — per-variant default, project-scoped, multiple allowed
- **Not one-per-project:** a project-wide thread accumulates all 3 builds + every
  tweak → irrelevant noise when working on one variant, and unbounded token cost.
- **Per-variant is the natural unit:** bounded + relevant (A's build rationale +
  A's tweaks only), and it **aligns with parallel-craft (UPLIFT-PERF-PLAN Item 1)**
  — each build container → one variant → one conversation that *becomes* that
  variant's iteration session.
- **But `conversation` is a first-class object:** a project has **1..N**. Defaults:
  3 auto-created (A/B/C). User-created: "new chat" (fresh thread when one gets
  long/confused) or **branch/explore** ("what if A went dark-mode?" without
  polluting main A).

### Shared vs per-conversation
- **Shared across a project's conversations:** run foundation (`_ctx`: brand
  extraction, directions, design system) + the variant's current file (R2). Every
  conversation — even brand-new — is seeded with these, so it never re-derives the
  brand.
- **Per-conversation:** the message history (intent, decisions, prior tweaks) —
  the actual memory.

### Data model
```
conversations: id, run_id (project), variant?, title, created_at, updated_at,
               r2_key (messages blob)     -- messages+usage JSON in R2
```
- Migration for the `conversations` table (D1). Messages blob in R2
  (`sessions/<run>/<conversation>.json`) — can be large, keep out of D1.
- Workspace opening variant A → resume A's default conversation; "new chat" →
  fork a new one seeded with `_ctx` + current file.

### Restore/append mechanics (where it hooks in)
- `runSession.iterate()`: resolve/create the conversation for (run, variant),
  pass `conversationId` (+ its r2 key) in the iterate job body.
- `agent.mjs` (iterate mode): if a session blob exists, load it as the starting
  `messages`, append `{role:"user", content: instruction}`; else seed
  `[system, seedContext(_ctx+file)]`. After the loop, **persist** the updated
  `messages` back to the blob (via ingest/R2).
- `loop.mjs`: accept an optional `initialMessages` instead of always
  `[system, task]`.
- DO: track conversation ids per (run, variant); a `conversations` list API for
  the UI (threads per project).

### Cost mitigations (history grows each turn — the one real cost)
- **Prompt caching** (Bedrock/Anthropic) on the stable prefix (system + skills +
  early turns) — biggest lever (also on IMPROVEMENTS.md backlog).
- **Prune tool results:** old `read_file`/screenshot/bash dumps bloat history →
  replace with short summaries, keep the assistant's *decisions* ("changed H1 X→Y",
  not the full file). An iteration rarely needs the raw dump.
- **Compact** older turns periodically (same idea as context compaction).
- **Concurrency:** one active turn per session at a time (lock).

## Complementary: deterministic undo via R2 file versioning
Independent of the conversation: save each variant as `home-A-proposed.v1/v2/…`
per iteration. **"Undo" = restore the prior version** — exact, instant, no LLM
guessing; enables redo/history. Pair with the conversation (memory) so you get
*reliable revert* AND *contextual reasoning*.

## Alternatives (and why A)
- **B — stateful session service:** Anthropic **Managed Agents** (the original v1
  plan: append-only durable sessions + SSE — "iteration is a natural continuation")
  or the **Claude Agent SDK** (session resume). Purpose-built; adopt if you'd
  rather the platform own session lifecycle than hand-roll A. A ≈ hand-rolling B.
- **C — warm persistent container:** real live in-memory session, instant, but
  **costly** (a container held per active session) + **fragile** (Containers sleep
  ~45m → memory lost, needs A as fallback anyway). Doesn't scale. Not recommended.

## Execution phases
1. `conversations` D1 table + R2 blob format + DO wiring (resolve/create per
   run+variant).
2. `loop.mjs` `initialMessages` + `agent.mjs` load/seed/append/persist.
3. `iterate()` passes conversationId; persist history at turn end.
4. Tool-result pruning + prompt caching.
5. UI: thread list per project + "new chat"; resume default per variant.
6. (Complementary) R2 file versioning + undo/redo.

## Open decisions
- Seed a new conversation from the variant's **build** history (needs per-variant
  build persistence — comes free with parallel-craft) vs from `_ctx`+file only.
- Pruning rule (keep last N turns full; summarize older) + when to auto-compact.
- Managed Agents / Agent SDK (B) vs hand-rolled (A) — A recommended for control +
  Bedrock continuity, but revisit if session mgmt gets heavy.
- Session retention / R2 cleanup policy.

## Relation to other plans
- **UPLIFT-PERF-PLAN Item 1 (parallel craft)** produces per-variant build
  conversations → the seed for per-variant sessions. Do sessions after (or with) it.
- **ETA-PLAN** unaffected (iterate ETA already pooled-median).
- **IMPROVEMENTS.md** prompt-caching item is a prerequisite cost lever here.

## Current state
Nothing executed. Iterations are stateless (cold container + file + `_ctx`).
Recent iteration-reliability fixes (artifact-arrival completion, force-emit,
pooled-median ETA, reopen guard) are in `webapp-build` (commits e72c02a…f6582a5)
but are orthogonal to session state.
