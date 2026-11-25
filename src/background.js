// Service worker: storage CRUD, message routing, optional Ember fallback, trace log.

import { parseBalance } from "./lib/parse.js";
import { learnPattern, readWithFallback } from "./lib/fallback.js";
import { budgetAllows, worstCaseCost, TRACE_MODEL, MAX_TIER_BODY_BYTES } from "./lib/trace.js";

const TRACKERS_KEY = "trackers"; // [{id,label,urlPattern,selector,createdAt,history:[{ts,value,unit,raw,source}]}]
const SETTINGS_KEY = "settings"; // {emberEnabled, allowPageText, apiBase, apiKey, maxSpendUsd}
const DEFAULT_MAX_SPEND_USD = 2; // hard cap approved by the user; editable on the options page
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
  const learned = await learnPattern({ settings, label: t.label, trainingText, preSend: reserveForSend });
  await settleReservation(learned, { trackerId, purpose: "derive-regex" });
  if (!learned.ok) return { ok: false, reason: learned.reason, pattern: learned.pattern };
  t.pattern = learned.pattern;
  await setStore(TRACKERS_KEY, trackers);
  return { ok: true, pattern: learned.pattern };
}

// The service worker is single-threaded; this module-level queue makes
// check -> reserve and settle read-modify-write cycles atomic across
// concurrent tracker reads.
let budgetQueue = Promise.resolve();
const withBudgetLock = (fn) => {
  const run = budgetQueue.then(fn);
  budgetQueue = run.then(() => {}, () => {});
  return run;
};

// Budget gate for the ACTUAL model HTTP path only. The client serializes the
// exact request body first and calls this with its real UTF-8 byte count and
// output cap, before fetch; a denial means no request is sent. Deterministic
// DOM/pattern reads never reach this gate and keep working at zero cost when
// the AI budget is exhausted or unknown. A persisted reservation survives a
// worker restart and counts at its bounded worst case, so a crashed call
// fails closed instead of vanishing. Exported for tests.
export async function reserveForSend({ bodyBytes, maxTokens }) {
  return withBudgetLock(async () => {
    if (!Number.isFinite(bodyBytes) || bodyBytes <= 0 || !Number.isFinite(maxTokens) || maxTokens <= 0) {
      return { allowed: false, reason: "budget-request-invalid" };
    }
    if (bodyBytes > MAX_TIER_BODY_BYTES) {
      // Sanity cap on what we send, not a pricing guarantee: Meta documents
      // no tokens-per-byte bound, so reservations price at the long-context
      // rate regardless (see worstCaseCost in trace.js). Refuse, don't reprice.
      return { allowed: false, reason: "budget-tier-bound-exceeded" };
    }
    const settings = await getStore(SETTINGS_KEY, {});
    const cap = settings.maxSpendUsd ?? DEFAULT_MAX_SPEND_USD;
    const trace = await getStore(TRACE_KEY, []);
    const check = budgetAllows(trace, cap); // invalid cap fails closed inside
    if (!check.allowed) return check;
    const reservation = worstCaseCost({ maxTokens });
    if (check.spentUsd + reservation > cap) {
      return { allowed: false, reason: "budget-exceeded", budget: { ...check, reservation } };
    }
    const reservationId = crypto.randomUUID();
    trace.push({
      ts: new Date().toISOString(), reservationId, pending: true, reservedUsd: reservation,
      model: TRACE_MODEL, ok: false, status: null, error: "reservation-pending",
      usageKnown: false, promptTokens: null, completionTokens: null, totalTokens: null, costUsd: null,
    });
    await setStore(TRACE_KEY, trace);
    return { allowed: true, reservationId, reservedUsd: reservation };
  });
}

// After the call: the reservation becomes the actual usage record. Client
// invariant: a sent request always yields a trace carrying its reservationId,
// so a traceless result means no request happened and nothing was reserved.
// Exported for tests.
export async function settleReservation(result, extra = {}) {
  if (!result.trace) return;
  await withBudgetLock(async () => {
    const trace = await getStore(TRACE_KEY, []);
    const idx = trace.findIndex((e) => e.pending && e.reservationId === result.trace.reservationId);
    const entry = { ...result.trace, ...extra };
    if (idx >= 0) trace[idx] = entry; else trace.push(entry);
    await setStore(TRACE_KEY, trace);
  });
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
      preSend: reserveForSend,
      getPageText: async () => {
        if (pageText === undefined) {
          const sample = await chrome.tabs.sendMessage(tabId, { type: "ebt:page-text" });
          pageText = sample?.text || "";
        }
        return pageText;
      },
    });
    await settleReservation(result, { trackerId });
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
