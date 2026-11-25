// Service worker: storage CRUD, message routing, optional Ember fallback, trace log.

import { parseBalance } from "./lib/parse.js";
import { learnPattern, readWithFallback } from "./lib/fallback.js";

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
  const learned = await learnPattern({ settings, label: t.label, trainingText });
  if (learned.trace) {
    const trace = await getStore(TRACE_KEY, []);
    trace.push({ ...learned.trace, trackerId, purpose: "derive-regex" });
    await setStore(TRACE_KEY, trace);
  }
  if (!learned.ok) return { ok: false, reason: learned.reason, pattern: learned.pattern };
  t.pattern = learned.pattern;
  await setStore(TRACKERS_KEY, trackers);
  return { ok: true, pattern: learned.pattern };
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
    // Deterministic read first, Ember fallback last - the shared, tested
    // orchestration in lib/fallback.js owns precedence and the consent gate.
    const settings = await getStore(SETTINGS_KEY, {});
    let pageText;
    const result = await readWithFallback({
      text: res.text,
      pattern: t.pattern,
      settings,
      label: t.label,
      getPageText: async () => {
        if (pageText === undefined) {
          const sample = await chrome.tabs.sendMessage(tabId, { type: "ebt:page-text" });
          pageText = sample?.text || "";
        }
        return pageText;
      },
    });
    if (result.trace) {
      const trace = await getStore(TRACE_KEY, []);
      trace.push({ ...result.trace, trackerId });
      await setStore(TRACE_KEY, trace);
    }
    if (!result.ok) return result;
    await recordReading(trackerId, { value: result.parsed.value, unit: result.parsed.unit, raw: result.parsed.raw, source: result.source });
    return { ok: true, source: result.source, parsed: result.parsed };
  }

  // The trained selector no longer resolves: report the honest re-teach state.
  return { ok: false, reason: res?.reason || "read-failed", needsRefresh: res?.reason === "selector-not-found" };
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
