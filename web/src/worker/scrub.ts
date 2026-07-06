/* User-visible text must never leak implementation details — model names,
   providers, or internal skill names. Applied at the single emit() choke point
   (every user-visible event: chat messages, status, rail, errors) and to the
   LLM suggestion chips, so the live stream, the error paths, and the persisted
   run_events history all stay clean by construction. */
import type { ServerEvent } from "../shared/protocol";

// Cheap pre-test: emit() is the streaming hot path and the vast majority of
// strings contain no trigger term — one scan decides whether to run the battery.
const PRETEST = /impeccable|bedrock|anthropic|cerebras|opus|claude|gemma/i;

const INTERNAL_TERMS: [RegExp, string][] = [
  // internal skills (command compounds first: "impeccable craft" → "the craft pass")
  [/\bimpeccable(?:'s)?\s+(craft|polish|critique|typeset|colorize|compose|shape|adapt|audit|motion)\b/gi, "the $1 pass"],
  [/\bimpeccable(?:'s)?\b/gi, "the design craft"],
  // providers / runtimes
  [/\b(?:aws\s+)?bedrock\b/gi, "the engine"],
  [/\banthropic\b/gi, "the engine"],
  [/\bcerebras\b/gi, "the engine"],
  // models (compound forms first; "magnum opus" is plain English, keep it)
  [/\bclaude\s+opus(?:\s+[\d.]+)?\b/gi, "the model"],
  [/(?<!magnum\s)\bopus(?:\s+[\d.]+)?\b/gi, "the model"],
  [/\bclaude\b/gi, "the model"],
  [/\bgemma(?:[-\s]\d[\w.]*)*\b/gi, "the model"],
];

export function scrubInternals(text: string): string {
  if (!PRETEST.test(text)) return text;
  let t = text;
  for (const [re, sub] of INTERNAL_TERMS) t = t.replace(re, sub);
  // Collapse compounds like "Bedrock/Opus" → "the engine/the model".
  t = t.replace(/\bthe engine\s*[/·-]\s*the model\b/gi, "the model");
  t = t.replace(/\bthe engine\s+the model\b/gi, "the model");
  t = t.replace(/\bpass pass\b/gi, "pass"); // "…critique pass" + our suffix
  return t;
}

/** Scrub every user-visible text field of an outgoing event. Called once in
 *  emit(), so new message sites (failure bubbles, blocked notices, status/rail
 *  lines) are sanitized by construction instead of opting in per call site.
 *  User-authored bubbles are left verbatim — we never rewrite the director. */
export function scrubEvent(ev: ServerEvent): ServerEvent {
  if (ev.t === "message.append" && ev.message.role === "agent") {
    const m = ev.message;
    return {
      ...ev,
      message: {
        ...m,
        ...(m.lead ? { lead: scrubInternals(m.lead) } : {}),
        ...(m.md ? { md: scrubInternals(m.md) } : {}),
        ...(m.tool ? { tool: scrubInternals(m.tool) } : {}),
        ...(m.body ? { body: m.body.map(scrubInternals) } : {}),
      },
    };
  }
  if (ev.t === "status") return { ...ev, text: scrubInternals(ev.text) };
  if (ev.t === "error") return { ...ev, message: scrubInternals(ev.message) };
  if (ev.t === "rail" && ev.rail.clock) return { ...ev, rail: { ...ev.rail, clock: scrubInternals(ev.rail.clock) } };
  return ev;
}
