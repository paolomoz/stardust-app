/* Shared cheap-reasoning call. One-shot Haiku completion via Bedrock (preferred;
   funded like the runs) or the direct Anthropic API. Returns "" on any miss, so
   callers fall back to a heuristic/static value. Used by ETA + suggestions. */
import type { Env } from "./index";

export async function callHaiku(env: Env, prompt: string, maxTokens = 80): Promise<string> {
  const bedKey = (env.BEDROCK_API_KEY || "").replace(/^AWS_BEARER_TOKEN_BEDROCK=/, "").trim();
  if (bedKey) {
    const region = env.BEDROCK_REGION || "us-east-1";
    const model = env.BEDROCK_HAIKU_MODEL || "us.anthropic.claude-3-haiku-20240307-v1:0";
    try {
      const r = await fetch(`https://bedrock-runtime.${region}.amazonaws.com/model/${model}/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${bedKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      });
      if (r.ok) { const j = (await r.json()) as { content?: { text?: string }[] }; return (j.content?.[0]?.text ?? "").trim(); }
      console.error("[haiku] bedrock", r.status, (await r.text()).slice(0, 150));
    } catch (e) { console.error("[haiku] bedrock err", String(e)); }
  }
  const antKey = env.ANTHROPIC_API_KEY;
  if (antKey) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": antKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
      });
      if (r.ok) { const j = (await r.json()) as { content?: { text?: string }[] }; return (j.content?.[0]?.text ?? "").trim(); }
    } catch { /* ignore */ }
  }
  return "";
}
