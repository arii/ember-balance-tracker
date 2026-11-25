// Service worker: storage CRUD, message routing, optional Ember fallback, trace log.

import { findBalanceWithEmber, deriveRegexWithEmber } from "./ember/client.js";
import { parseBalance } from "./lib/parse.js";
import { extractWithPattern, validatePattern } from "./lib/regexcheck.js";

const TRACKERS_KEY = "trackers"; // [{id,label,urlPattern,selector,createdAt,history:[{ts,value,unit,raw,source}]}]
const SETTINGS_KEY = "settings"; // {emberEnabled, apiBase, apiKey}
const TRACE_KEY = "emberTrace"; // [traceEntry]

async function getStore(key, fallback) {
  const o = await chrome.storage.local.get(key);
  return o[key] ?? fallback;
}
async function setStore(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

async function addTracker({ label, selector, url, pattern = null }) {
  const trackers = await getStore(TRACKERS_KEY, []);
  const tracker = {
    id: crypto.randomUUID(),
    label,
    selector,
    pattern, // model-derived deterministic extraction regex, validated at training time
    urlPattern: new URL(url).origin,
    createdAt: new Date().toISOString(),
    history: [],
  };
  trackers.push(tracker);
  await setStore(TRACKERS_KEY, trackers);
  return tracker;
}

// After training: if the Ember fallback is enabled, ask Muse Ember once for a
// deterministic extraction regex and keep it only if it reproduces the value
// the user just clicked. Later reads then need no AI call.
async function derivePattern(trackerId, trainingText) {
  const settings = await getStore(SETTINGS_KEY, {});
  if (!settings.emberEnabled || !settings.apiKey) return { ok: false, reason: "ember-disabled" };
  const trackers = await getStore(TRACKERS_KEY, []);
  const t = trackers.find((x) => x.id === trackerId);
  if (!t) return { ok: false, reason: "unknown-tracker" };
  const expected = parseBalance(trainingText);
  const ai = await deriveRegexWithEmber({
    apiBase: settings.apiBase, apiKey: settings.apiKey, label: t.label, sampleText: trainingText,
  });
  if (ai.trace) {
    const trace = await getStore(TRACE_KEY, []);
    trace.push({ ...ai.trace, trackerId, purpose: "derive-regex" });
    await setStore(TRACE_KEY, trace);
  }
  if (!ai.ok) return { ok: false, reason: ai.reason };
  const check = validatePattern(ai.pattern, trainingText, expected.ok ? expected.value : null);
  if (!check.accepted) return { ok: false, reason: "pattern-rejected-" + check.reason, pattern: ai.pattern };
  t.pattern = check.pattern;
  await setStore(TRACKERS_KEY, trackers);
  return { ok: true, pattern: check.pattern };
}

async function recordReading(trackerId, reading) {
  const trackers = await getStore(TRACKERS_KEY, []);
  const t = trackers.find((x) => x.id === trackerId);
  if (!t) return null;
  t.history.push({ ts: new Date().toISOString(), ...reading });
  if (t.history.length > 500) t.history = t.history.slice(-500);
  await setStore(TRACKERS_KEY, trackers);
  return t;
}

async function ensureContentScript(tabId) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["src/content/content.js"] });
}

async function readTracker(trackerId, tabId) {
  const trackers = await getStore(TRACKERS_KEY, []);
  const t = trackers.find((x) => x.id === trackerId);
  if (!t) return { ok: false, reason: "unknown-tracker" };

  await ensureContentScript(tabId);
  const res = await chrome.tabs.sendMessage(tabId, { type: "ebt:read", selector: t.selector });

  if (res?.ok) {
    // 1. Learned deterministic regex first (no AI call).
    if (t.pattern) {
      const viaPattern = extractWithPattern(res.text, t.pattern);
      if (viaPattern.ok) {
        await recordReading(trackerId, { value: viaPattern.value, unit: viaPattern.unit, raw: viaPattern.raw, source: "pattern" });
        return { ok: true, source: "pattern", parsed: viaPattern };
      }
    }
    // 2. Generic parser on the same element text.
    const parsed = parseBalance(res.text);
    if (parsed.ok) {
      await recordReading(trackerId, { value: parsed.value, unit: parsed.unit, raw: parsed.raw, source: "dom" });
      return { ok: true, source: "dom", parsed };
    }
  }

  // Deterministic read failed. Last-resort AI read sends visible page text and
  // needs BOTH the Ember key and the separate page-text consent (Ari's design:
  // teach-once generation is the norm, outbound page text is the exception).
  const settings = await getStore(SETTINGS_KEY, {});
  if (!settings.emberEnabled || !settings.apiKey || !settings.allowPageText) {
    return {
      ok: false,
      reason: res?.ok ? "unparseable" : res?.reason || "read-failed",
      needsRefresh: res?.reason === "selector-not-found",
    };
  }
  const sample = await chrome.tabs.sendMessage(tabId, { type: "ebt:page-text" });
  const ai = await findBalanceWithEmber({
    apiBase: settings.apiBase, apiKey: settings.apiKey, label: t.label, pageText: sample?.text || "",
  });
  if (ai.trace) {
    const trace = await getStore(TRACE_KEY, []);
    trace.push({ ...ai.trace, trackerId });
    await setStore(TRACE_KEY, trace);
  }
  if (!ai.ok) return { ok: false, reason: ai.reason || "ai-failed" };
  const parsed = parseBalance(ai.text);
  if (!parsed.ok) return { ok: false, reason: "ai-unparseable", raw: ai.text };
  await recordReading(trackerId, { value: parsed.value, unit: parsed.unit, raw: parsed.raw, source: "ember" });
  return { ok: true, source: "ember", parsed };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg?.type) {
      case "ebt:list":
        sendResponse({ ok: true, trackers: await getStore(TRACKERS_KEY, []) });
        break;
      case "ebt:arm-training": {
        // The popup closes right after arming so the user can click the page;
        // the whole flow completes here in the background.
        (async () => {
          await ensureContentScript(msg.tabId);
          const picked = await chrome.tabs.sendMessage(msg.tabId, { type: "ebt:start-training" });
          if (!picked) return; // user pressed Esc
          const tracker = await addTracker({ label: msg.label, selector: picked.selector, url: picked.url });
          await recordReading(tracker.id, {
            value: parseBalance(picked.text).value, unit: parseBalance(picked.text).unit,
            raw: picked.text, source: "training",
          });
          const derivation = await derivePattern(tracker.id, picked.text);
          await chrome.tabs.sendMessage(msg.tabId, {
            type: "ebt:trained", label: msg.label, pattern: derivation.ok ? derivation.pattern : null,
          }).catch(() => {});
        })();
        sendResponse({ ok: true, armed: true });
        break;
      }
      case "ebt:add-tracker":
        sendResponse({ ok: true, tracker: await addTracker(msg) });
        break;
      case "ebt:delete-tracker": {
        const trackers = await getStore(TRACKERS_KEY, []);
        await setStore(TRACKERS_KEY, trackers.filter((t) => t.id !== msg.id));
        sendResponse({ ok: true });
        break;
      }
      case "ebt:read-tracker":
        sendResponse(await readTracker(msg.id, msg.tabId));
        break;
      case "ebt:derive-pattern":
        sendResponse(await derivePattern(msg.id, msg.trainingText));
        break;
      case "ebt:trace":
        sendResponse({ ok: true, trace: await getStore(TRACE_KEY, []) });
        break;
      default:
        sendResponse({ ok: false, reason: "unknown-message" });
    }
  })();
  return true;
});
