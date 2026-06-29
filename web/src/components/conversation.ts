/* Conversation column: message bubbles (agent + user), plan blocks, seed chips,
   and the composer. Renders HTML strings; the screen wires the composer. */
import { esc } from "../dom";
import type { Message, PlanBlock } from "../state";
import { sendArrow } from "./icons";

export function seedChip(hash: string, note: string): string {
  return `<div class="seed"><span class="k">seed</span> <span class="h">${esc(hash)}</span> · ${esc(note)}</div>`;
}

export function planBlock(p: PlanBlock): string {
  const steps = p.steps
    .map((s) => `<li><span class="b">${esc(s.n)}</span><span>${esc(s.text)}</span></li>`)
    .join("");
  const status = p.status ? `<div class="status"><span>✓</span> ${esc(p.status)}</div>` : "";
  const acts = p.acts?.length
    ? `<div class="acts">${p.acts.map((a) => `<button class="mini">${esc(a)}</button>`).join("")}</div>`
    : "";
  return `<div class="plan"><div class="tag">${esc(p.tag)}</div><ul class="steps">${steps}</ul>${status}${acts}</div>`;
}

/** A single message. `seedNote` supplies the md5(...) suffix for seed chips. */
export function message(m: Message, seedNote: string): string {
  if (m.role === "user") {
    return `<div class="msg user"><div class="bubble">${esc(m.text ?? "")}</div></div>`;
  }
  const parts: string[] = [];
  if (m.lead) parts.push(`<div class="lead"><span class="star">✦</span> ${m.lead}</div>`);
  for (const p of m.body ?? []) parts.push(`<p>${p}</p>`);
  if (m.plan) parts.push(planBlock(m.plan));
  if (m.seed) parts.push(seedChip(m.seed, seedNote));
  return `<div class="msg fade">${parts.join("")}</div>`;
}

export function thread(messages: Message[], seedNote: string): string {
  return `<div class="conv-thread">${messages.map((m) => message(m, seedNote)).join("")}</div>`;
}

export function composer(placeholder: string, hint: string): string {
  return `<div class="composer">
    <div class="field"><input type="text" placeholder="${esc(placeholder)}" aria-label="message" /><button class="send" aria-label="send">${sendArrow}</button></div>
    <div class="hint">${hint}</div>
  </div>`;
}

export function convHead(projectName: string, right = ""): string {
  return `<div class="conv-head"><div class="who"><span class="proj"><b>${esc(projectName)}</b> · redesign</span></div>${right}</div>`;
}
