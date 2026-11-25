// Muse Ember (Meta Model API) client. Optional fallback only.
// The API key lives in chrome.storage.local (entered on the Options page),
// is never bundled, and calls happen only when the user enabled the fallback
// AND a deterministic read failed. Every call is trace-logged for the
// hackathon's proof-of-usage requirement.

import { makeTraceEntry } from "../lib/trace.js";

// Verified against dev.meta.ai docs (Nov 24, 2026): base URL, bearer key, model id.
export const DEFAULT_API_BASE = "https://api.meta.ai/v1";
export const DEFAULT_MODEL = "muse-ember-1.0";

const PROMPT = (label, pageText) => [
  {
    role: "system",
    content:
      "You find a single account balance or credit amount in page text. " +
      "Answer with only the amount and unit, e.g. \"$100.05\" or \"4000 credits\". If none is present, answer NONE.",
  },
  {
    role: "user",
    content: `The user tracks "${label}". Page text:\n\n${pageText}`,
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
    content: `The user tracks "${label}". Example page text containing the current value:\n\n${sampleText}`,
  },
];

async function chat({ apiBase, apiKey, messages, maxTokens }) {
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: DEFAULT_MODEL, messages, max_tokens: maxTokens, temperature: 0 }),
  });
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  const data = await res.json();
  return { ok: true, text: data?.choices?.[0]?.message?.content?.trim() || "", usage: data?.usage };
}

/**
 * Training-time step (Ari's design): ask Muse Ember once how to extract the
 * amount, as a deterministic regex usable for later reads without AI calls.
 */
export async function deriveRegexWithEmber({ apiBase = DEFAULT_API_BASE, apiKey, label, sampleText }) {
  if (!apiKey) return { ok: false, reason: "no-api-key" };
  const r = await chat({ apiBase, apiKey, messages: REGEX_PROMPT(label, sampleText), maxTokens: 60 });
  if (!r.ok) return r;
  const trace = makeTraceEntry({ label, usage: r.usage });
  const pattern = r.text.replace(/^`+|`+$/g, "").trim();
  if (!pattern) return { ok: false, reason: "model-empty", trace };
  return { ok: true, pattern, trace };
}

export async function findBalanceWithEmber({ apiBase = DEFAULT_API_BASE, apiKey, label, pageText }) {
  if (!apiKey) return { ok: false, reason: "no-api-key" };
  const res = await fetch(`${apiBase.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: DEFAULT_MODEL, messages: PROMPT(label, pageText), max_tokens: 32, temperature: 0 }),
  });
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content?.trim() || "";
  const trace = makeTraceEntry({ label, usage: data?.usage });
  if (!text || /^NONE\b/i.test(text)) return { ok: false, reason: "model-none", trace };
  return { ok: true, text, trace };
}
