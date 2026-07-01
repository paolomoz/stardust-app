/* ===========================================================================
   The agent loop. Model-agnostic: call provider.step, execute tool calls, feed
   results back, repeat until the agent emits the `done` milestone (or stalls).
   Narration + tool activity are surfaced to the UI via callbacks. Accumulates
   token usage for cost reporting.
   =========================================================================== */
import { LOCAL_TOOLS } from "./tools.mjs";

export async function runLoop({ provider, tools, toolSpecs, system, task, onNarration, onTool, onUsage, maxSteps = 240, maxNudges = 3, doneHint, isDone, initialMessages }) {
  const nudge = doneHint || "Continue the uplift. When everything is finished and uploaded, call emit_milestone with phase \"done\".";
  // Terminal milestone: full run ends on phase "done"; an iteration ends on
  // iterate.done (a change) OR iterate.answer (a question — no edit).
  const terminal = isDone || ((name, args) => name === "emit_milestone" && (args?.phase === "done" || (args?.phase === "iterate" && (args?.event === "done" || args?.event === "answer"))));
  // Resume a persisted conversation when given (it already carries system + prior
  // turns + the new user turn); otherwise start fresh from system + task.
  const messages = initialMessages?.length
    ? initialMessages
    : [
        { role: "system", content: system },
        { role: "user", content: task },
      ];
  const usage = { prompt: 0, completion: 0, total: 0, calls: 0 };
  let done = false;
  let nudges = 0;

  for (let step = 0; step < maxSteps && !done; step++) {
    const { message, finish, usage: u } = await provider.step(messages, toolSpecs);
    usage.prompt += u.prompt_tokens || 0;
    usage.completion += u.completion_tokens || 0;
    usage.total += u.total_tokens || 0;
    usage.calls += 1;
    onUsage?.(usage);

    // Cerebras returns tool_calls alongside content; keep the assistant turn intact.
    messages.push({ role: "assistant", content: message.content ?? "", tool_calls: message.tool_calls });
    if (message.content?.trim()) await onNarration?.(message.content.trim());

    const calls = message.tool_calls || [];
    if (!calls.length) {
      // The agent ended a turn without acting. Nudge it back to work a few times
      // before giving up — the task is autonomous and ends via the done milestone.
      if (nudges++ < maxNudges) {
        messages.push({ role: "user", content: nudge });
        continue;
      }
      break;
    }

    for (const c of calls) {
      const name = c.function?.name ?? "";
      let args = {};
      let parseErr = false;
      try { args = JSON.parse(c.function?.arguments || "{}"); } catch { parseErr = true; }
      if (LOCAL_TOOLS.has(name)) await onTool?.(name, args);
      const fn = tools[name];
      const result = parseErr
        ? `[error] your ${name} arguments were not valid JSON — they were likely truncated because the output got too long. For a large file, write a first chunk with write_file then add the rest with append_file (or use run_bash with a heredoc).`
        : fn ? await fn(args) : `[error] unknown tool ${name}`;
      if (!parseErr && terminal(name, args)) done = true;
      messages.push({ role: "tool", tool_call_id: c.id, content: typeof result === "string" ? result : JSON.stringify(result) });
    }
  }

  return { usage, done, steps: messages };
}
