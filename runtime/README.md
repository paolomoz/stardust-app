# stardust open-loop runtime (Cerebras / Gemma 4)

An **alternative brain** to Anthropic Managed Agents: our own agent loop, with a
swappable model provider. Default backend = **Cerebras `gemma-4-31b`**. Runs
*inside the sandbox* (next to the skills + Playwright), executes tools locally,
and pushes progress/deliverables to the **same ingest bridge** the Managed Agents
path uses — so the Worker/DO/R2/UI are unchanged. Managed Agents stays intact and
selectable.

```
DO (create run, ingest token) ──trigger──▶ sandbox: node runtime/agent.mjs
                                              ├─ provider.step → Cerebras (Gemma 4)   [swap via CEREBRAS_BASE_URL → AI Gateway]
                                              ├─ tools: run_bash/read/write/edit (local)
                                              └─ emit_milestone / upload_artifact ──▶ /api/ingest/<runId>/* ──▶ R2 + DO + UI
```

## Files
- `provider.mjs` — the model adapter (OpenAI-compatible `step()`); Cerebras default.
- `tools.mjs` — tool specs + executors. `emit_milestone`/`upload_artifact` are
  **structured** tools the loop forwards to ingest (reliable — no "forgot to curl").
- `loop.mjs` — model-agnostic agent loop (tool dispatch, nudges, usage totals).
- `ingest.mjs` — the milestone/artifact HTTP client.
- `agent.mjs` — entrypoint (reads env, runs the loop).
- `system-prompt.md` — the stardust-engine prompt for the structured tools.

## Run (env)
```
RUN_ID, INGEST_BASE, INGEST_TOKEN     # from the Durable Object
TARGET_URL                            # site to redesign
CEREBRAS_API_KEY [, CEREBRAS_MODEL=gemma-4-31b, CEREBRAS_BASE_URL]
OUTPUTS_DIR=/mnt/session/outputs, WORKDIR=/workspace
TASK                                  # optional override (smoke tests)
node runtime/agent.mjs
```

## Status
- ✅ **Verified** (cheap, no skills): provider + loop + tools + ingest end-to-end
  — Gemma 4 emitted a tool call, ran it, emitted the `done` milestone; narration,
  tool line, and completion all flowed to the DO/UI.
- ✅ Baked into the sandbox image (`sandbox/build.sh` stages it; `Dockerfile`
  copies it to `/workspace/runtime`).

## Remaining wiring (next increment)
1. **Host runner** (`runtime/runner.mjs`): tiny HTTP service the Worker calls to
   `docker run` the image with `node /workspace/runtime/agent.mjs` + env + the
   outputs/workspace mounts (mirrors `sandbox/spawn.sh`, minus Managed Agents).
2. **DO `runCerebras(url)`** + a new `mode: "cerebras"` (keep `uplift` =
   Managed Agents): mint the ingest token, show the working screen, POST the run
   to the runner, then rely on ingest (no SSE). Add the mode to
   `main.ts` / `liveDriver` / `worker/index.ts`.
3. **First full Gemma uplift** end-to-end (cheap on Cerebras) — the real
   capability test vs the Opus baseline.
4. **(Optional) AI Gateway**: set `CEREBRAS_BASE_URL` to the Cloudflare AI
   Gateway endpoint for caching/observability/fallback — no code change.
