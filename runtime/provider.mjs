/* ===========================================================================
   Model provider adapter. One interface (step) over an OpenAI-compatible
   chat-completions API; default backend is Cerebras (Gemma 4). Point it at
   Cloudflare AI Gateway later by overriding CEREBRAS_BASE_URL — the agent loop
   doesn't change. This is the seam that makes the model swappable.
   =========================================================================== */
const DEFAULT_BASE = process.env.CEREBRAS_BASE_URL || "https://api.cerebras.ai/v1";
const DEFAULT_MODEL = process.env.CEREBRAS_MODEL || "gemma-4-31b";

export function makeProvider({ base = DEFAULT_BASE, model = DEFAULT_MODEL, key = process.env.CEREBRAS_API_KEY } = {}) {
  if (!key) throw new Error("CEREBRAS_API_KEY is not set");
  return {
    name: "cerebras",
    model,
    /** One turn: messages + tool schemas -> assistant message (+ tool_calls) + usage. */
    async step(messages, tools) {
      const res = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          tools,
          tool_choice: "auto",
          // High cap so a full-page write_file isn't truncated into an empty file.
          max_tokens: 16384,
          temperature: 0.4,
        }),
      });
      if (!res.ok) throw new Error(`cerebras ${res.status}: ${(await res.text()).slice(0, 500)}`);
      const d = await res.json();
      const choice = d.choices?.[0] ?? {};
      return { message: choice.message ?? { role: "assistant", content: "" }, finish: choice.finish_reason, usage: d.usage ?? {} };
    },
  };
}
