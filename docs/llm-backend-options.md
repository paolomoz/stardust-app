# stardust web app — LLM backend options & the harness fork

**Status:** design doc only. No implementation change. Written after the first
real Opus 4.8 uplift run on the Managed Agents + self-hosted-sandbox + Cloudflare
architecture.

Two questions prompted this:
1. Can we switch the model to **Gemma inferred by Cerebras**?
2. Can we use a different **AWS Bedrock** API key?

They look different but resolve to **one architectural fork**, so this doc treats
them together.

---

## 1. Where the model is bound today

```
Browser ─WS─ Cloudflare Worker + DO ──REST/SSE──▶ Anthropic Managed Agents (BRAIN)
                    │  (api.anthropic.com, sk-ant key)   model = claude-opus-4-8
                    │                                     agent loop + tools + sessions
              ingest │◀── HTTP push (milestones/artifacts) ── self-hosted sandbox (HANDS)
              R2/D1/UI                                          ant worker · skills · Playwright
```

The model is chosen **once**, at agent creation (`agent/setup.mjs`):
`POST /v1/agents { model: "claude-opus-4-8", tools: [agent_toolset_20260401] }`.

The critical fact: **Anthropic Managed Agents is a first-party Anthropic-platform
product.** The `model` field accepts **Claude models only**, billed/authenticated
through `api.anthropic.com` with an `sk-ant-…` key. The harness itself — the agent
loop, tool orchestration, session lifecycle, the durable event log, SSE
streaming, the `ant` environment worker that claims work — *is* Managed Agents.

### Direct answers

| Question | Answer | Why |
|---|---|---|
| Swap model to **Gemma/Cerebras** inside the current harness? | **No** | Managed Agents runs Claude only; Cerebras/Gemma is a different provider entirely. |
| Use an **AWS Bedrock** key inside the current harness? | **No** | Managed Agents authenticates against the Anthropic platform (`sk-ant`). Bedrock is a separate platform (AWS creds, `InvokeModel`/`Converse` API). You cannot point Managed Agents at Bedrock. |

So **either change means leaving Managed Agents** — i.e. replacing the *brain
plane*, not flipping a setting. That is the fork.

> Note the asymmetry: **Bedrock still gives you Claude** (same model family, same
> capability — it's a billing / hosting / data-residency change). **Cerebras
> gives you Gemma** (different, smaller model — a capability change). The *plumbing
> work* to leave Managed Agents is the same for both; the *risk* is not.

---

## 2. The fork: stay on Managed Agents vs. own the agent loop

### Option A — Stay on Managed Agents (today)
- **Model choice:** Claude only (Opus 4.8 / Sonnet / Haiku).
- **Billing/auth:** Anthropic platform (`sk-ant`).
- **You get for free:** the agent loop, tool execution protocol, **stateful
  append-only sessions** (resumable — the basis of M6 iterate-in-workspace), a
  **durable event log**, **SSE streaming**, the credential **vault**, and the
  `ant` self-hosted worker.
- **Can't do:** non-Claude models; non-Anthropic billing (Bedrock/Vertex).

### Option B — Own the agent loop (provider-agnostic)
Drop Managed Agents; run our **own agent runtime** that talks to a pluggable
model provider. This is the *only* path to Gemma **or** Bedrock.

```
Browser ─WS─ Worker + DO ──trigger──▶ self-hosted sandbox (HANDS)
                  ▲                       ├─ agent loop (our code)
            ingest │── HTTP push ─────────┤    └─ Model Provider Adapter ──▶ { Bedrock Claude | Cerebras Gemma | Vertex | … }
              R2/D1/UI                     └─ tool execution (skills · Playwright · git)
```

Once we own the loop, the model backend becomes a **one-interface adapter**, and
Bedrock vs Cerebras vs Vertex is a config choice — not an architecture change.

---

## 3. What's reusable vs. replaced (the blast radius)

The architecture's seams make Option B **contained**, because most planes are
already model-agnostic:

| Component | Under Option B |
|---|---|
| Sandbox image (baked skills, Playwright, git) | ✅ **Reuse as-is** |
| **Ingest bridge** (agent → Worker → R2; milestones/artifacts over HTTP) | ✅ **Reuse as-is** — this is the key decoupling; the UI never knew which model ran |
| Worker / Durable Object / D1 / R2 / SPA / engine→UI protocol | ✅ **Reuse** (DO simplifies — see below) |
| stardust + impeccable skills | ✅ **Reuse** |
| Anthropic Managed Agents (sessions, SSE, agent loop, `ant` worker, vault) | ❌ **Replace** |
| `agent/setup.mjs` (creates Anthropic agent/env) | ❌ **Replace** with provider config |
| `web/src/worker/managedAgents.ts` (REST/SSE client) | ❌ **Replace** with "trigger sandbox + receive ingest" |
| DO `runUplift` (creates MA session, tails SSE) | 🔁 **Simplify** to: create-run → trigger sandbox → receive ingest (milestones **and** narration now both arrive via ingest) |

Net: the **hands** and the **UI** survive; we build an **agent runtime** + a
**provider adapter**, and we **re-implement the few Managed Agents features we
actually use** (see §5).

---

## 4. The Model Provider Adapter

One interface, several backends. All three target providers expose
**tool/function-calling chat APIs**, so the adapter is thin:

```
interface ModelProvider {
  // one turn: given messages + tool schemas, return assistant text + tool calls
  step(messages, tools) -> { text, toolCalls[], usage }
}
```

| Provider | Model | API | Auth | Notes |
|---|---|---|---|---|
| **AWS Bedrock** | Claude (Opus/Sonnet) | `Converse` / `InvokeModel` (or `AnthropicBedrock` SDK) | AWS creds (access key/secret or bearer) | **Same model quality as today.** A billing/data-residency move. Tool-use supported. |
| **Cerebras** | Gemma (+ others) | OpenAI-compatible chat completions | Cerebras API key | Very fast + cheap. Capability is the open question. |
| Anthropic direct | Claude | Messages API | `sk-ant` | Fallback/dev; same model as Managed Agents but you run the loop. |
| (Vertex) | Claude/Gemini | Vertex API | GCP creds | Listed for completeness. |

The agent loop (tool dispatch, multi-turn, tool-result feeding, milestone/artifact
pushes to ingest) is **identical** across providers; only `step()` changes.

---

## 5. What we'd lose from Managed Agents (and must rebuild)

Be honest about what the hosted harness gives us:

1. **Stateful, resumable sessions** — the basis of M6 (iterate-in-workspace =
   append a turn to the same session). Own-loop: we persist conversation state
   ourselves (D1 already stores the event timeline; we'd also store the model
   message history per run).
2. **Durable event log + SSE** — we already mirror the UI timeline in D1 and
   stream over our own WebSocket; narration would move from MA's SSE to our
   ingest channel. Low risk.
3. **The `ant` worker** (claims work, executes tools, enforces the file-tool
   guardrails incl. `--unrestricted-paths`/`--max-idle` we just tuned) — replaced
   by our agent loop running in the sandbox. We re-own tool execution + the
   workdir/permission model.
4. **Credential vault** — for the (future) AEM/DA deploy token. We'd use Worker
   secrets / the sandbox env instead.
5. **Managed retries / backpressure / billing dashboards.**

None are blockers; all have straightforward replacements given what we've already
built. But it's real work — call it a **brain-plane rewrite**, scoped by the seams
above.

---

## 6. The real risk: model capability (Gemma only)

Uplift is a **hard, long, skill-heavy agentic task**: read thick SKILL.md docs,
extract a brand from a live render, compose 3 directions, write a lot of HTML/CSS,
run validation gates, fix responsive bugs. Opus 4.8 did it in 98 model calls and
still hit a self-inflicted edit loop.

- **Bedrock Claude:** capability **unchanged** (it's the same model). Risk ≈ 0 on
  quality; the work is purely the harness rewrite + AWS auth/region setup.
- **Cerebras Gemma:** **capability is the whole question.** Gemma is smaller and
  weaker at long multi-step tool use + instruction-following over big skill docs.
  Likely needs: tighter/decomposed prompts, more explicit step scaffolding,
  smaller sub-tasks, maybe a stronger model for the hard phases (direct/validate)
  and Gemma for cheap phases. Speed + cost would be a major win **iff** fidelity
  holds — which only a spike can tell us.

---

## 7. De-risking spike plan (cheap, before any commitment)

Run these **in order**; stop if a gate fails.

1. **Provider reachability (½ day).** Minimal script: one tool-calling round-trip
   to (a) Bedrock Claude and (b) Cerebras Gemma. Confirm auth, tool-call format,
   token/usage reporting. *Gate: both return a valid tool call.*
2. **Skill-comprehension probe (1 day).** Reuse the `/?mode=probe` idea offline:
   feed each model the uplift SKILL.md + ask it to produce the **phase plan + the
   first 5 concrete tool calls**. Compare against Opus. *Gate: Gemma produces a
   coherent, correct plan.* (Cheap — no full run.)
3. **One phase end-to-end (1–2 days).** Implement a thin agent loop in the sandbox
   for **extract only** (single page → brand-extraction JSON + brand-review.html),
   pushing via the existing ingest. Run it on Gemma and on Bedrock Claude.
   *Gate: brand surface is usable; for Gemma, compare quality vs Opus.*
4. **Full uplift on Bedrock Claude (1 day).** Lowest-risk full run (same model
   quality) — proves the harness rewrite independent of model capability.
5. **Full uplift on Gemma (1 day).** Only if (2)+(3) looked good. Measure
   quality, reliability, cost, latency vs the Opus baseline ($51 / 43 min).

Each step reuses the sandbox + ingest + UI; only the loop + adapter are new.

---

## 8. Recommendation

- **If the goal is cost / AWS billing / data residency with no quality loss →
  Bedrock (Claude).** Do the harness rewrite (Option B) with a Bedrock adapter
  first; it's the safe way to prove the own-loop architecture because the model
  stays as strong as today. Spike steps 1 → 4.
- **If the goal is cheap/fast inference → Cerebras/Gemma**, but treat it as
  **capability-gated**: do steps 1–3 before betting on it; expect prompt/loop
  work and possibly a hybrid (strong model for hard phases). 
- **Build the loop once, provider-agnostic** (the adapter in §4) so Bedrock,
  Cerebras, and Anthropic-direct are all config — and Managed Agents can remain a
  selectable backend for as long as it's the best Claude harness.

**Do not start the rewrite until M5/M6 are stable** — the current Managed Agents
path is our working baseline and the quality bar to beat.
