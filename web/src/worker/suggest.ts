/* Cheap LLM next-step suggestions. Given a run's recent narration + result
   (brand tensions, variant titles), ask a fast model for two specific, useful
   things the designer could ask for next — 1 per line. Owner-gated by the caller.

   Uses Bedrock Haiku (same funded account as the runs) and falls back to the
   direct Anthropic API. Returns [] on any miss so the UI keeps its static chips. */
import type { Env } from "./index";

const VIEW: Record<string, string> = {
  working: "the project overview",
  brand: "the brand audit",
  variants: "the three directions",
  workspace: "a chosen variant in the workspace",
};

/** One-shot completion via Bedrock Haiku (preferred) or the Anthropic API. */
async function callHaiku(env: Env, prompt: string): Promise<string> {
  const bedKey = (env.BEDROCK_API_KEY || "").replace(/^AWS_BEARER_TOKEN_BEDROCK=/, "").trim();
  if (bedKey) {
    const region = env.BEDROCK_REGION || "us-east-1";
    const model = env.BEDROCK_HAIKU_MODEL || "us.anthropic.claude-haiku-4-5-20251001";
    try {
      const r = await fetch(`https://bedrock-runtime.${region}.amazonaws.com/model/${model}/invoke`, {
        method: "POST",
        headers: { authorization: `Bearer ${bedKey}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ anthropic_version: "bedrock-2023-05-31", max_tokens: 80, messages: [{ role: "user", content: prompt }] }),
      });
      if (r.ok) { const j = (await r.json()) as { content?: { text?: string }[] }; return (j.content?.[0]?.text ?? "").trim(); }
      console.error("[suggest] bedrock", r.status, (await r.text()).slice(0, 150));
    } catch (e) { console.error("[suggest] bedrock err", String(e)); }
  }
  const antKey = env.ANTHROPIC_API_KEY;
  if (antKey) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": antKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 80, messages: [{ role: "user", content: prompt }] }),
      });
      if (r.ok) { const j = (await r.json()) as { content?: { text?: string }[] }; return (j.content?.[0]?.text ?? "").trim(); }
      console.error("[suggest] anthropic", r.status, (await r.text()).slice(0, 150));
    } catch (e) { console.error("[suggest] anthropic err", String(e)); }
  }
  return "";
}

export async function suggestNextSteps(env: Env, runId: string, screen: string): Promise<string[]> {
  // Recent agent narration (most-recent-first, capped), then chronological.
  const ev = await env.DB.prepare(
    "SELECT payload FROM run_events WHERE run_id = ? ORDER BY seq DESC LIMIT 50",
  ).bind(runId).all<{ payload: string }>();
  const leads: string[] = [];
  for (const r of ev.results ?? []) {
    if (leads.length >= 8) break;
    try {
      const p = JSON.parse(r.payload) as { t?: string; message?: { role?: string; lead?: string } };
      if (p.t === "message.append" && p.message?.role === "agent" && p.message.lead) leads.push(p.message.lead);
    } catch { /* skip */ }
  }
  leads.reverse();

  const row = await env.DB.prepare("SELECT url, result_json FROM runs WHERE id = ?")
    .bind(runId).first<{ url: string; result_json: string | null }>();
  let variants = "", tensions = "";
  try {
    const rj = row?.result_json ? JSON.parse(row.result_json) : {};
    const vs = rj?.variants?.variants;
    if (Array.isArray(vs)) variants = vs.map((v: { id: string; title: string }) => `${v.id}: ${v.title}`).join("; ");
    const ts = rj?.brand?.tensions;
    if (Array.isArray(ts)) tensions = ts.map((t: { text: string }) => t.text).join("; ");
  } catch { /* ignore */ }

  const prompt =
    `A designer is redesigning ${row?.url ?? "a website"} with an AI design studio, currently viewing ${VIEW[screen] ?? screen}.\n` +
    (variants ? `The three variants: ${variants}.\n` : "") +
    (tensions ? `Brand tensions found in the audit: ${tensions}.\n` : "") +
    (leads.length ? `Recent activity:\n- ${leads.join("\n- ")}\n` : "") +
    `\nSuggest exactly TWO specific, useful things the designer could ask you to do next from here. ` +
    `Reference the real brand/variant/tension where it sharpens the idea. ` +
    `Each ≤ 7 words, imperative, concrete. Output ONLY the two lines — no numbering, no quotes, no preamble.`;

  const text = await callHaiku(env, prompt);
  return text.split("\n").map((l) => l.replace(/^[-*\d.)\s]+/, "").trim()).filter(Boolean).slice(0, 2);
}
