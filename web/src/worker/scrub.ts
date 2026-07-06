/* User-visible text must never leak implementation details — model names,
   providers, or internal skill names. Applied at the single ingest choke point
   where agent output becomes chat messages (and to LLM suggestion chips), so
   both the live stream and the persisted run_events history stay clean. */

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
  let t = text;
  for (const [re, sub] of INTERNAL_TERMS) t = t.replace(re, sub);
  // Collapse compounds like "Bedrock/Opus" → "the engine/the model".
  t = t.replace(/\bthe engine\s*[/·-]\s*the model\b/gi, "the model");
  t = t.replace(/\bthe engine\s+the model\b/gi, "the model");
  t = t.replace(/\bpass pass\b/gi, "pass"); // "…critique pass" + our suffix
  return t;
}
