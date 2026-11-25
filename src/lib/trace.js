// Proof-of-usage trace: records every Muse Ember API call so the hackathon
// submission can show prompt/token usage and spend. Pure logic + injected store.
// Honesty rules: the traced model must be the model actually requested; failed
// calls are traced too; unknown usage is null, never a fabricated zero.

export const EMBER_PRICE_PER_MTOK = { input: 0.10, output: 0.50 }; // USD, from the hackathon guide
export const TRACE_MODEL = "muse-ember-1.0"; // must match src/ember/client.js DEFAULT_MODEL

// null in -> null out: an unknown token count is not a free call.
export function estimateCost({ promptTokens, completionTokens }) {
  if (promptTokens == null || completionTokens == null) return null;
  return (promptTokens / 1e6) * EMBER_PRICE_PER_MTOK.input +
         (completionTokens / 1e6) * EMBER_PRICE_PER_MTOK.output;
}

export function makeTraceEntry({ trackerId, label, usage, model = TRACE_MODEL, ok = true, status = null, error = null }) {
  const promptTokens = usage?.prompt_tokens ?? null;
  const completionTokens = usage?.completion_tokens ?? null;
  const usageKnown = promptTokens != null && completionTokens != null;
  return {
    ts: new Date().toISOString(),
    trackerId: trackerId ?? null,
    label: label ?? null,
    model,
    ok,
    status, // HTTP status for failed calls; never the response body (may echo page text)
    error,  // short reason code, e.g. "http-500"; never headers or the API key
    usageKnown,
    promptTokens,
    completionTokens,
    totalTokens: usage?.total_tokens ?? (usageKnown ? promptTokens + completionTokens : null),
    costUsd: usageKnown ? estimateCost({ promptTokens, completionTokens }) : null,
  };
}

export function summarizeTrace(entries) {
  const total = {
    calls: 0, failedCalls: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    costUsd: 0, usageIncomplete: false,
  };
  for (const e of entries || []) {
    total.calls++;
    if (!e.ok) total.failedCalls++;
    if (e.usageKnown === false) total.usageIncomplete = true; // do not silently treat as free
    total.promptTokens += e.promptTokens || 0;
    total.completionTokens += e.completionTokens || 0;
    total.totalTokens += e.totalTokens || 0;
    total.costUsd += e.costUsd || 0;
  }
  if (total.usageIncomplete) {
    total.costUsd = null;      // a partial sum would understate spend
    total.withinBudget = null; // unknown, not "within"
  } else {
    total.costUsd = Math.round(total.costUsd * 1e6) / 1e6;
    total.withinBudget = total.costUsd <= 10;
  }
  return total;
}
