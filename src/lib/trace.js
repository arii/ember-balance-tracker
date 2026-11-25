// Proof-of-usage trace: records every Muse Ember API call so the hackathon
// submission can show prompt/token usage and spend. Pure logic + injected store.
// Honesty rules: the traced model must be the model actually requested; failed
// calls are traced too; unknown usage is null, never a fabricated zero.

// Pricing verified against https://dev.meta.ai/docs/pricing-rate-limits
// (Nov 24, 2026): muse-ember-1.0 has two tiers; the request's INPUT tokens
// set the tier, and a request over 200K input tokens bills the WHOLE request
// at the long-context rates, not just the tokens past 200K. USD per 1M tokens:
export const EMBER_PRICE_PER_MTOK = { input: 0.10, output: 0.50 };      // up to 200K input tokens
export const EMBER_PRICE_PER_MTOK_LONG = { input: 0.30, output: 1.50 }; // over 200K input tokens
export const EMBER_TIER_INPUT_TOKENS = 200_000;
export const TRACE_MODEL = "muse-ember-1.0"; // must match src/ember/client.js DEFAULT_MODEL
// Official model facts, https://dev.meta.ai/docs/muse-ember (Nov 24, 2026):
// context window 1,048,576 tokens; max output 524,288; reasoning default "max".
export const MUSE_EMBER_CONTEXT_TOKENS = 1_048_576;
// Hard request-body cap: a sanity limit on what we send, NOT a pricing
// guarantee. Meta documents no tokens-per-byte bound for muse-ember-1.0, so
// byte counts cannot prove the <=200K tier; reservations price at the
// long-context rate regardless (see worstCaseCost).
export const MAX_TIER_BODY_BYTES = 200_000;

// null in -> null out: an unknown token count is not a free call.
// Tier-aware on the REPORTED input tokens; cached-input discounts are
// ignored, so an actual is never understated.
export function estimateCost({ promptTokens, completionTokens }) {
  if (promptTokens == null || completionTokens == null) return null;
  const rate = promptTokens > EMBER_TIER_INPUT_TOKENS ? EMBER_PRICE_PER_MTOK_LONG : EMBER_PRICE_PER_MTOK;
  return (promptTokens / 1e6) * rate.input +
         (completionTokens / 1e6) * rate.output;
}

// Token counts must be finite non-negative numbers; anything else (negative,
// NaN, strings) is treated as unknown - never as zero, never as free.
const validTokens = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

export function makeTraceEntry({ trackerId, label, usage, model = TRACE_MODEL, ok = true, status = null, error = null, reservationId = null }) {
  const promptTokens = validTokens(usage?.prompt_tokens);
  const completionTokens = validTokens(usage?.completion_tokens);
  const usageKnown = promptTokens != null && completionTokens != null;
  return {
    ts: new Date().toISOString(),
    reservationId,
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
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens ?? null,
    costUsd: usageKnown ? estimateCost({ promptTokens, completionTokens }) : null,
  };
}

// Worst-case reservation for one call, computed BEFORE it is sent.
// HONEST BOUND, no tokenizer assumptions: Meta documents no tokens-per-byte
// ratio for muse-ember-1.0, so the measured body bytes cannot PROVE an input
// token count. What the provider does guarantee:
//   - input tokens per request never exceed the context window, 1,048,576
//     (https://dev.meta.ai/docs/muse-ember);
//   - output tokens are capped server-side by max_tokens, reasoning tokens
//     included (https://dev.meta.ai/docs/reasoning);
//   - over 200K input tokens the WHOLE request bills at long-context rates
//     (https://dev.meta.ai/docs/pricing-rate-limits).
// So the reservation is the context window at the long-context input rate
// plus max_tokens at the long-context output rate: a true upper bound on what
// one call can bill, with no reliance on an unprovable byte bound. The
// measured body bytes are still recorded on the reservation as an
// expected-size figure, and every call settles at ACTUAL reported usage.
export function worstCaseCost({ maxTokens }) {
  return (MUSE_EMBER_CONTEXT_TOKENS / 1e6) * EMBER_PRICE_PER_MTOK_LONG.input +
         (maxTokens / 1e6) * EMBER_PRICE_PER_MTOK_LONG.output;
}

export function summarizeTrace(entries) {
  const total = {
    calls: 0, failedCalls: 0, pendingReservations: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
    costUsd: 0, usageIncomplete: false,
  };
  for (const e of entries || []) {
    if (e.pending) {
      // Bounded reservation: charge at worst case, not flagged unknown -
      // but a reservation with an invalid amount is unknown, fail closed.
      total.pendingReservations++;
      if (Number.isFinite(e.reservedUsd) && e.reservedUsd >= 0) total.costUsd += e.reservedUsd;
      else total.usageIncomplete = true;
      continue;
    }
    total.calls++;
    if (!e.ok) total.failedCalls++;
    // Fail closed on malformed or legacy entries: anything that is not an
    // explicit usageKnown===true with a finite non-negative cost is unknown,
    // never silently free. This covers pre-usageKnown legacy rows too.
    const costValid = Number.isFinite(e.costUsd) && e.costUsd >= 0;
    if (e.usageKnown !== true || !costValid) total.usageIncomplete = true;
    if (costValid) {
      total.promptTokens += e.promptTokens || 0;
      total.completionTokens += e.completionTokens || 0;
      total.totalTokens += e.totalTokens || 0;
      total.costUsd += e.costUsd;
    }
  }
  if (total.usageIncomplete) {
    total.costUsd = null;      // a partial sum would understate spend
    total.withinBudget = null; // unknown, not "within"
  } else {
    // NEVER round here: budgetAllows compares this exact value against the
    // cap, and rounding down would understate spend at the boundary. Display
    // rounding belongs at the display site (options page), not in the sum.
    total.withinBudget = total.costUsd <= 10;
  }
  return total;
}

// Hard pre-call spend guard. This is a cap, not a target: blocks at or over
// maxSpendUsd, and blocks when any prior call's cost is unknown, because an
// unbounded-unknown spend cannot be verified against the cap.
export function budgetAllows(entries, maxSpendUsd) {
  // A cap we cannot trust is not a cap: wrong type, NaN, zero, negative or
  // infinite all fail closed and block everything.
  if (typeof maxSpendUsd !== "number" || !Number.isFinite(maxSpendUsd) || maxSpendUsd <= 0) {
    return { allowed: false, reason: "budget-cap-invalid", spentUsd: null, capUsd: maxSpendUsd };
  }
  const cap = maxSpendUsd;
  const s = summarizeTrace(entries);
  if (s.usageIncomplete) return { allowed: false, reason: "budget-cost-unknown", spentUsd: null, capUsd: cap };
  if (s.costUsd >= cap) return { allowed: false, reason: "budget-exceeded", spentUsd: s.costUsd, capUsd: cap };
  return { allowed: true, spentUsd: s.costUsd, capUsd: cap };
}
