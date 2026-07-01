/* ===========================================================================
   Amazon Bedrock provider — Claude (Opus 4.8) via the Anthropic Messages API on
   bedrock-runtime, bearer-API-key auth (no SigV4). Same step() interface as the
   Cerebras provider, so loop.mjs is unchanged: it keeps its OpenAI-shaped message
   history and this provider translates OpenAI<->Anthropic at the boundary.

   Lets us run the SAME open-loop runtime with a frontier model — isolating model
   capability from the harness when judging output quality.
   =========================================================================== */
const DEFAULT_REGION = process.env.BEDROCK_REGION || "us-east-1";
const DEFAULT_MODEL = process.env.BEDROCK_MODEL || "us.anthropic.claude-opus-4-8";

// Tolerate a key pasted as "AWS_BEARER_TOKEN_BEDROCK=ABSK…".
const cleanKey = (k) => (k || "").replace(/^AWS_BEARER_TOKEN_BEDROCK=/, "").trim();

export function makeBedrockProvider({ region = DEFAULT_REGION, model = DEFAULT_MODEL, key = cleanKey(process.env.BEDROCK_API_KEY) } = {}) {
  if (!key) throw new Error("BEDROCK_API_KEY is not set");
  const url = `https://bedrock-runtime.${region}.amazonaws.com/model/${model}/invoke`;
  return {
    name: "bedrock",
    model,
    async step(messages, tools) {
      const { system, msgs } = toAnthropic(messages);
      const body = {
        anthropic_version: "bedrock-2023-05-31",
        // High cap: a single write_file of a full HTML page is emitted as tool-call
        // arguments and must not be truncated, or the file lands empty.
        max_tokens: 32000,
        ...(system ? { system } : {}),
        messages: msgs,
        ...(tools?.length ? { tools: tools.map(toAnthropicTool) } : {}),
      };
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`bedrock ${res.status}: ${(await res.text()).slice(0, 500)}`);
      return fromAnthropic(await res.json());
    },
  };
}

function toAnthropicTool(t) {
  const f = t.function ?? t;
  return { name: f.name, description: f.description ?? "", input_schema: f.parameters ?? { type: "object", properties: {} } };
}

/** OpenAI-shaped history -> { system, messages[] } in Anthropic shape.
 *  Consecutive role:"tool" results are merged into one user turn of
 *  tool_result blocks (Anthropic requires tool results in a user message). */
function toAnthropic(messages) {
  let system = "";
  const msgs = [];
  let pendingResults = null;
  const flush = () => {
    if (pendingResults) { msgs.push({ role: "user", content: pendingResults }); pendingResults = null; }
  };
  for (const m of messages) {
    if (m.role === "system") { system += (system ? "\n\n" : "") + (m.content ?? ""); continue; }
    if (m.role === "tool") {
      (pendingResults ??= []).push({ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") });
      continue;
    }
    flush();
    if (m.role === "user") {
      msgs.push({ role: "user", content: typeof m.content === "string" ? m.content : (m.content ?? "") });
    } else if (m.role === "assistant") {
      const content = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || "{}"); } catch { /* tolerate */ }
        content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
      }
      msgs.push({ role: "assistant", content: content.length ? content : "(working)" });
    }
  }
  flush();
  return { system, msgs };
}

/** Anthropic Messages response -> the provider's internal {message, finish, usage}. */
function fromAnthropic(d) {
  let text = "";
  const tool_calls = [];
  for (const b of d.content ?? []) {
    if (b.type === "text") text += b.text ?? "";
    else if (b.type === "tool_use") tool_calls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
  }
  const u = d.usage ?? {};
  const inAll = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  return {
    message: { role: "assistant", content: text, tool_calls: tool_calls.length ? tool_calls : undefined },
    finish: d.stop_reason,
    usage: { prompt_tokens: inAll, completion_tokens: u.output_tokens || 0, total_tokens: inAll + (u.output_tokens || 0) },
  };
}
