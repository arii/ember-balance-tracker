// Pure orchestration for consent-gated, teach-once Ember fallback.
import { deriveRegexWithEmber, findBalanceWithEmber } from "../ember/client.js";
import { extractWithPattern, validatePattern } from "./regexcheck.js";
import { parseBalance } from "./parse.js";

export async function learnPattern({ settings, label, trainingText, call = deriveRegexWithEmber }) {
  if (!settings?.emberEnabled || !settings.apiKey) return { ok: false, reason: "ember-disabled" };
  const expected = parseBalance(trainingText);
  const ai = await call({
    apiBase: settings.apiBase,
    apiKey: settings.apiKey,
    label,
    sampleText: trainingText,
  });
  if (!ai.ok) return ai;
  const check = validatePattern(ai.pattern, trainingText, expected.ok ? expected.value : null);
  if (!check.accepted) return { ok: false, reason: `pattern-rejected-${check.reason}`, pattern: ai.pattern, trace: ai.trace };
  return { ok: true, pattern: check.pattern, trace: ai.trace };
}

export async function readWithFallback({ text, pageText, getPageText, pattern, settings, label, call = findBalanceWithEmber }) {
  if (pattern) {
    const learned = extractWithPattern(text, pattern);
    if (learned.ok) return { ok: true, source: "pattern", parsed: learned };
  }
  const parsed = parseBalance(text);
  if (parsed.ok) return { ok: true, source: "dom", parsed };
  if (!settings?.emberEnabled || !settings.apiKey || !settings.allowPageText) {
    return { ok: false, reason: "unparseable" };
  }
  const sample = typeof getPageText === "function" ? await getPageText() : pageText;
  const ai = await call({ apiBase: settings.apiBase, apiKey: settings.apiKey, label, pageText: sample });
  if (!ai.ok) return ai;
  const fallback = parseBalance(ai.text);
  return fallback.ok
    ? { ok: true, source: "ember", parsed: fallback, trace: ai.trace }
    : { ok: false, reason: "ai-unparseable", trace: ai.trace };
}
