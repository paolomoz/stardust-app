/* ===========================================================================
   fetch with retry + jittered backoff. Transient failures — network drops
   (fetch throws) and retryable HTTP (408/425/429/5xx) — otherwise throw away a
   whole run. This wraps them so a blip costs seconds, not a 25-min run. Observed
   2026-07-01: a bedrock 500 ("Try your request again") killed a run at 23 min,
   and an operator network blip killed 3 at t=0 — all preventable here.

   Returns the final Response (callers keep their own `!res.ok` handling for
   non-retryable 4xx). Rethrows only if a network error persists past all tries.
   =========================================================================== */
const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504, 529]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Backoff for attempt N (0-based): exponential from `base`, capped, +jitter. */
function backoff(attempt, base, cap) {
  const raw = Math.min(cap, base * 2 ** attempt);
  return Math.round(raw / 2 + Math.random() * (raw / 2)); // full-ish jitter
}

/** Parse a Retry-After header (delta-seconds or HTTP-date) → ms, or null. */
function retryAfterMs(res) {
  const h = res?.headers?.get?.("retry-after");
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

/**
 * @param {string} url
 * @param {RequestInit} opts
 * @param {{tries?:number, base?:number, cap?:number, label?:string, onRetry?:(info:{attempt:number,reason:string,waitMs:number})=>void}} [cfg]
 */
export async function fetchRetry(url, opts, cfg = {}) {
  const { tries = 4, base = 800, cap = 20000, label = "fetch", onRetry } = cfg;
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    const last = attempt === tries - 1;
    try {
      const res = await fetch(url, opts);
      if (!RETRYABLE.has(res.status) || last) return res;
      const wait = retryAfterMs(res) ?? backoff(attempt, base, cap);
      onRetry?.({ attempt, reason: `HTTP ${res.status}`, waitMs: wait });
      console.warn(`[retry] ${label}: HTTP ${res.status} — retrying in ${wait}ms (attempt ${attempt + 1}/${tries - 1})`);
      await sleep(wait);
    } catch (e) {
      lastErr = e;
      if (last) throw e; // network error persisted → surface it
      const wait = backoff(attempt, base, cap);
      onRetry?.({ attempt, reason: String(e?.message ?? e), waitMs: wait });
      console.warn(`[retry] ${label}: ${String(e?.message ?? e)} — retrying in ${wait}ms (attempt ${attempt + 1}/${tries - 1})`);
      await sleep(wait);
    }
  }
  throw lastErr ?? new Error(`${label}: exhausted retries`);
}
