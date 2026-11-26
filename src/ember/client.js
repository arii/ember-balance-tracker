// Muse Ember (Meta Model API) client. Optional fallback only.
// The API key lives in chrome.storage.local (entered on the Options page),
// is never bundled, and calls happen only when the user enabled the fallback
// AND a deterministic read failed. Every call is trace-logged for the
// hackathon's proof-of-usage requirement.

import { makeTraceEntry } from "../lib/trace.js";

// Verified against dev.meta.ai docs (Nov 24, 2026): base URL, bearer key, model id.
export const DEFAULT_API_BASE = "https://api.meta.ai/v1";
export const DEFAULT_MODEL = "muse-ember-1.0";

// Hard input cap: a sanity limit on request size (the background guard's
// reservation is priced from the official context-window bound, not from
// body bytes - Meta documents no tokens-per-byte ratio).
// muse-ember-1.0 is a reasoning model whose completion_tokens include its
// private reasoning, and whose DEFAULT reasoning_effort is "max" - first live
// contact deliberated away the whole output cap and returned content: null
// (finish_reason: "length"). These tasks are direct-answer lookups, for which
// the docs prescribe "low" (dev.meta.ai/docs/reasoning). The remaining caps
// are headroom for the answer plus light reasoning, not deliberation room.
export const MAX_INPUT_CHARS = 4000;
export const MAX_LABEL_CHARS = 200; // user-entered; capped so prompts stay bounded
const capInput = (s) => (typeof s === "string" && s.length > MAX_INPUT_CHARS ? s.slice(0, MAX_INPUT_CHARS) : s);
const capLabel = (s) => (typeof s === "string" && s.length > MAX_LABEL_CHARS ? s.slice(0, MAX_LABEL_CHARS) : s);

const PROMPT = (label, pageText) => [
  {
    role: "system",
    content:
      "You find a single account balance or credit amount in page text. " +
      "Answer with only the amount and unit, e.g. \"$100.05\" or \"4000 credits\". If none is present, answer NONE.",
  },
  {
    role: "user",
    content: `The user tracks "${capLabel(label)}". Page text:\n\n${capInput(pageText)}`,
  },
];

const REGEX_PROMPT = (label, sampleText) => [
  {
    role: "system",
    content:
      "You write one JavaScript-compatible regular expression that extracts an account balance " +
      "or credit amount from page text. The amount itself must be in capture group 1. " +
      "Keep it under 120 characters. No nested quantified groups, no backreferences, no quantifier above {64}. " +
      "Answer with only the regex, no explanation, no backticks.",
  },
  {
    role: "user",
    content: `The user tracks "${capLabel(label)}". Example page text containing the current value:\n\n${capInput(sampleText)}`,
  },
];

// Shared transport. The exact request body is serialized FIRST and measured;
// the injected preSend gate (the background budget guard) sees the real
// UTF-8 byte count and output cap before any request leaves, and a denial
// means no HTTP happens at all. On failure returns a reason + HTTP status
// only: the error body is never read into the result, and the API key never
// leaves the header.
async function chat({ apiBase, apiKey, messages, maxTokens, preSend }) {
  const body = JSON.stringify({ model: DEFAULT_MODEL, messages, max_tokens: maxTokens, temperature: 0, reasoning_effort: "low" });
  const bodyBytes = new TextEncoder().encode(body).length;
  let reservationId = null;
  if (preSend) {
    const gate = await preSend({ bodyBytes, maxTokens });
    if (!gate.allowed) return { ok: false, reason: gate.reason || "budget-denied", status: null, budget: gate, noRequest: true };
    reservationId = gate.reservationId ?? null;
  }
  let res;
  try {
    res = await fetch(`${apiBase.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
      body,
    });
  } catch {
    return { ok: false, reason: "network-error", status: null, reservationId };
  }
  if (!res.ok) return { ok: false, reason: `http-${res.status}`, status: res.status, reservationId };
  const data = await res.json();
  return { ok: true, text: data?.choices?.[0]?.message?.content?.trim() || "", finishReason: data?.choices?.[0]?.finish_reason ?? null, usage: data?.usage, reservationId };
}

// A trace exists IFF a request was actually sent. Budget-denied calls carry
// noRequest and produce no trace entry - they never reached the API.
const traceFor = (label, r) =>
  r.noRequest ? undefined : makeTraceEntry(r.ok
    ? { label, model: DEFAULT_MODEL, usage: r.usage, reservationId: r.reservationId }
    : { label, model: DEFAULT_MODEL, ok: false, status: r.status, error: r.reason, reservationId: r.reservationId });

/**
 * Training-time step (per the extension's click-to-train design): ask Muse
 * Ember once how to extract the amount, as a deterministic regex usable for
 * later reads without AI calls.
 */
// Output budget for the derive call. completion_tokens include private
// reasoning even at reasoning_effort "low" (dev.meta.ai/docs/reasoning), and a
// live call at 2000 returned no visible text (1998 reasoning tokens). 4000
// leaves headroom for the short regex after light reasoning.
export const DERIVE_MAX_TOKENS = 4000;

export async function deriveRegexWithEmber({ apiBase = DEFAULT_API_BASE, apiKey, label, sampleText, preSend }) {
  if (!apiKey) return { ok: false, reason: "no-api-key" };
  const r = await chat({ apiBase, apiKey, messages: REGEX_PROMPT(label, sampleText), maxTokens: 4000 /* = DERIVE_MAX_TOKENS, asserted in test */, preSend });
  const trace = traceFor(label, r);
  if (!r.ok) return { ok: false, reason: r.reason, trace };
  const pattern = r.text.replace(/^`+|`+$/g, "").trim();
  if (!pattern) return { ok: false, reason: r.finishReason === "length" ? "model-empty-output-limit" : "model-empty", trace };
  return { ok: true, pattern, trace };
}

export async function findBalanceWithEmber({ apiBase = DEFAULT_API_BASE, apiKey, label, pageText, preSend }) {
  if (!apiKey) return { ok: false, reason: "no-api-key" };
  const r = await chat({ apiBase, apiKey, messages: PROMPT(label, pageText), maxTokens: 1000, preSend });
  const trace = traceFor(label, r);
  if (!r.ok) return { ok: false, reason: r.reason, trace };
  if (!r.text || /^NONE\b/i.test(r.text)) return { ok: false, reason: "model-none", trace };
  return { ok: true, text: r.text, trace };
}
