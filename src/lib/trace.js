// Proof-of-usage trace: records every Muse Ember API call so the hackathon
// submission can show prompt/token usage and spend. Pure logic + injected store.

export const EMBER_PRICE_PER_MTOK = { input: 0.10, output: 0.50 }; // USD, from the hackathon guide

export function estimateCost({ promptTokens = 0, completionTokens = 0 }) {
  return (promptTokens / 1e6) * EMBER_PRICE_PER_MTOK.input +
         (completionTokens / 1e6) * EMBER_PRICE_PER_MTOK.output;
}

export function makeTraceEntry({ trackerId, label, usage, model = "muse-ember", ok = true }) {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const completionTokens = usage?.completion_tokens ?? 0;
  return {
    ts: new Date().toISOString(),
    trackerId: trackerId ?? null,
    label: label ?? null,
    model,
    ok,
    promptTokens,
    completionTokens,
    totalTokens: usage?.total_tokens ?? promptTokens + completionTokens,
    costUsd: estimateCost({ promptTokens, completionTokens }),
  };
}

export function summarizeTrace(entries) {
  const total = { calls: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  for (const e of entries || []) {
    total.calls++;
    total.promptTokens += e.promptTokens || 0;
    total.completionTokens += e.completionTokens || 0;
    total.costUsd += e.costUsd || 0;
  }
  total.costUsd = Math.round(total.costUsd * 1e6) / 1e6;
  total.withinBudget = total.costUsd <= 10;
  return total;
}
