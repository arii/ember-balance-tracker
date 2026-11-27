// Service worker: storage CRUD, message routing, optional Ember fallback, trace log.

import { parseBalance } from "./lib/parse.js";
import { BUILD_ID } from "./lib/build.js";
import { restoreTracker } from "./lib/restore.js";
import { learnPattern, readWithFallback } from "./lib/fallback.js";
import { budgetAllows, worstCaseCost, TRACE_MODEL, MAX_TIER_BODY_BYTES } from "./lib/trace.js";

let storeUpdateQueue = Promise.resolve();
function enqueueStoreUpdate(fn) {
  const p = storeUpdateQueue.then(fn);
  storeUpdateQueue = p.catch(() => {});
  return p;
}

async function updateTrackers(mutate) {
  return enqueueStoreUpdate(async () => {
    const trackers = await getStore(TRACKERS_KEY, []);
    const result = await mutate(trackers);
    await setStore(TRACKERS_KEY, trackers);
    return result;
  });
}

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

// Pending training arm: session storage survives a service worker restart
// while the user aims, but never persists past the browser session.
const PENDING_KEY = "pendingTraining"; // {tabId, label, ts} | null
async function getSession(key, fallback) {
  const o = await chrome.storage.session.get(key);
  return o[key] ?? fallback;
}
async function setSession(key, value) {
  await chrome.storage.session.set({ [key]: value });
}

async function addTracker({ label, selector, anchor = null, url, pattern = null }) {
  return updateTrackers((trackers) => {
    const tracker = {
      id: crypto.randomUUID(),
      label,
      selector,
      anchor,
      pattern, // model-derived deterministic extraction regex, validated at training time
      urlPattern: new URL(url).origin,
      createdAt: new Date().toISOString(),
      history: [],
    };
    trackers.push(tracker);
    return tracker;
  });
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
  // Keep the outcome visible in the popup instead of failing silently.
  const result = learned.ok
    ? { ok: true, pattern: learned.pattern }
    : { ok: false, reason: learned.reason, pattern: learned.pattern };
  await updateTrackers((trackers) => {
    const existing = trackers.find((x) => x.id === trackerId);
    if (!existing) return;
    existing.emberStatus = { ok: !!learned.ok, reason: learned.ok ? null : learned.reason, ts: new Date().toISOString() };
    if (learned.ok) existing.pattern = learned.pattern;
  });
  return result;
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
  return updateTrackers((trackers) => {
    const t = trackers.find((x) => x.id === trackerId);
    if (!t) return null;
    t.history.push({ ts: new Date().toISOString(), verified: false, healed: false, ...reading });
    if (t.history.length > 500) t.history = t.history.slice(-500);
    delete t.lastFailure;
    return t;
  });
}

async function recordFailure(trackerId, reason) {
  return updateTrackers((trackers) => {
    const t = trackers.find((x) => x.id === trackerId);
    if (!t) return null;
    t.lastFailure = { ts: new Date().toISOString(), reason };
    return t;
  });
}

// Arm the picker in every reachable frame. allFrames file injection can
// silently skip subframes (verified in real Chrome: the frame never gets the
// message listener), so enumerate frames, ping each for the listener, inject
// by explicit frameId where it is missing (reliable), then arm per frame.
// Only accessible frames are enumerated; cross-origin frames without host
// permission remain unsupported. No host permissions are requested here.
export async function armAllFrames(tabId) {
  let frames;
  try {
    frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.href });
  } catch {
    return { armed: false, frameCount: 0 };
  }
  let armedCount = 0;
  for (const f of frames || []) {
    const listening = await chrome.tabs.sendMessage(tabId, { type: "ebt:read", selector: "body" }, { frameId: f.frameId }).catch(() => null);
    if (!listening) {
      try {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [f.frameId] }, files: ["src/content/content.js"] });
      } catch { continue; } // inaccessible frame (e.g. cross-origin)
    }
    const r = await chrome.tabs.sendMessage(tabId, { type: "ebt:start-training" }, { frameId: f.frameId }).catch(() => null);
    if (r?.ok) armedCount++;
  }
  return { armed: armedCount > 0, frameCount: (frames || []).length };
}

// Self-contained: serialized into every frame by scripting.executeScript,
// so these must not close over module scope.
function ebtAnchor(el) {
  const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const ownText = normalize(el.innerText || el.textContent || "");
  let ancestor = el.parentElement;
  for (let i = 0; i < 4 && ancestor; i++) {
    const lines = [];
    const walk = (node) => {
      if (node.nodeType === 3) {
        const t = normalize(node.textContent);
        if (t) lines.push(t);
      } else if (node.nodeType === 1) {
        for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
      }
    };
    walk(ancestor);
    for (const line of lines) {
      if (line !== ownText && line.length <= 60 && /[a-z]/.test(line) && !/^[\s$€£%0-9.,+\-()kKmM]*$/.test(line)) {
        return line;
      }
    }
    ancestor = ancestor.parentElement;
  }
  return null;
}

function readAtFunc(selector, anchor) {
  function ebtAnchor(el) {
    const normalize = (s) => s.replace(/\s+/g, " ").trim().toLowerCase();
    const ownText = normalize(el.innerText || el.textContent || "");
    let ancestor = el.parentElement;
    for (let i = 0; i < 4 && ancestor; i++) {
      const lines = [];
      const walk = (node) => {
        if (node.nodeType === 3) {
          const t = normalize(node.textContent);
          if (t) lines.push(t);
        } else if (node.nodeType === 1) {
          for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
        }
      };
      walk(ancestor);
      for (const line of lines) {
        if (line !== ownText && line.length <= 60 && /[a-z]/.test(line) && !/^[\s$€£%0-9.,+\-()kKmM]*$/.test(line)) {
          return line;
        }
      }
      ancestor = ancestor.parentElement;
    }
    return null;
  }
  const el = document.querySelector(selector);
  const text = el ? (el.innerText || el.textContent || "").trim() : "";
  if (anchor) {
    const candidates = [];
    const all = document.querySelectorAll("*");
    for (const c of all) {
      if (!c.children.length) {
        const t = (c.innerText || c.textContent || "").trim();
        if (t && /\d/.test(t) && /^[\s$€£+-]*\d[\d.,]*\s*[a-z%]{0,12}(\s+[a-z]{1,12})?$/i.test(t.trim()) && ebtAnchor(c) === anchor) {
          candidates.push(c);
        }
      }
    }
    if (candidates.length > 1) {
      return { ok: false, reason: "anchor-ambiguous" };
    }
    if (el && text && ebtAnchor(el) === anchor && (candidates.length === 0 || (candidates.length === 1 && candidates[0] === el))) {
      return { ok: true, text, verified: true };
    }
    if (candidates.length === 1) {
      return { ok: true, text: (candidates[0].innerText || candidates[0].textContent || "").trim(), verified: true, healed: true };
    }
    return { ok: false, reason: el ? "anchor-mismatch" : "selector-not-found" };
  }
  if (!el) return { ok: false, reason: "selector-not-found" };
  if (!text) return { ok: false, reason: "empty" };
  return { ok: true, text, verified: false };
}

function pageTextFunc(maxChars) {
  const t = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
  return t.slice(0, maxChars);
}

// Pure: merge per-frame executeScript results into one read. A hit in any
// frame wins; otherwise the most informative failure wins. Exported for tests.
export function pickFrameResult(results) {
  if (!Array.isArray(results) || results.length === 0) return { ok: false, reason: "no-frames" };
  for (const r of results) if (r?.result?.ok) return { ok: true, text: r.result.text, verified: !!r.result.verified, healed: !!r.result.healed };
  const other = results.map((r) => r?.result).find((x) => x && !x.ok && x.reason !== "selector-not-found");
  if (other) return { ok: false, reason: other.reason || "read-failed" };
  return { ok: false, reason: "selector-not-found" };
}

// Pure: combine per-frame visible text for the Ember fallback. A frame's
// innerText never includes child frames, so concatenation does not duplicate.
// Exported for tests.
export function joinFrameTexts(results, maxChars = 4000) {
  const seen = new Set();
  let out = "";
  for (const r of results || []) {
    const t = typeof r?.result === "string" ? r.result.trim() : "";
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out = out ? out + "\n" + t : t;
    if (out.length >= maxChars) break;
  }
  return out.slice(0, maxChars);
}

async function readTracker(trackerId, tabId) {
  const trackers = await getStore(TRACKERS_KEY, []);
  const t = trackers.find((x) => x.id === trackerId);
  if (!t) return { ok: false, reason: "unknown-tracker" };

  // Read every frame: a only-first-response tabs.sendMessage broadcast could
  // return another frame's miss, but executeScript reports all frames.
  let res;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, func: readAtFunc, args: [t.selector, t.anchor || null],
    });
    res = pickFrameResult(results);
  } catch {
    await recordFailure(trackerId, "inject-failed");
    return { ok: false, reason: "inject-failed" };
  }

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
      lastUnit: [...(t.history || [])].reverse().find((h) => h && h.unit)?.unit ?? null,
      getPageText: async () => {
        if (pageText === undefined) {
          const samples = await chrome.scripting.executeScript({
            target: { tabId, allFrames: true }, func: pageTextFunc, args: [4000],
          }).catch(() => []);
          pageText = joinFrameTexts(samples, 4000);
        }
        return pageText;
      },
    });
    await settleReservation(result, { trackerId });
    if (!result.ok) {
      await recordFailure(trackerId, result.reason || "read-failed");
      return result;
    }
    await recordReading(trackerId, { value: result.parsed.value, unit: result.parsed.unit, raw: result.parsed.raw, source: result.source, verified: res.verified, healed: res.healed });
    return { ok: true, source: result.source, parsed: result.parsed, verified: res.verified, healed: res.healed };
  }

  await recordFailure(trackerId, res?.reason || "read-failed");
  return { ok: false, reason: res?.reason || "read-failed", needsRefresh: res?.reason === "selector-not-found" || res?.reason === "anchor-mismatch" };
}



chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
    switch (msg?.type) {
      case "ebt:list":
        sendResponse({ ok: true, trackers: await getStore(TRACKERS_KEY, []) });
        break;
      case "ebt:version":
        sendResponse({ ok: true, build: BUILD_ID });
        break;
      case "ebt:arm-training": {
        // Await arming before acknowledging success. The popup stays open on
        // failure; session storage survives worker restarts after a real arm.
        const prev = await getSession(PENDING_KEY, null);
        if (prev && prev.tabId !== msg.tabId) {
          await chrome.tabs.sendMessage(prev.tabId, { type: "ebt:cancel-training" }).catch(() => {});
        }
        await setSession(PENDING_KEY, { tabId: msg.tabId, label: msg.label, trackerId: msg.trackerId || null, ts: Date.now() });
        const armResult = await armAllFrames(msg.tabId);
        if (!armResult.armed) await setSession(PENDING_KEY, null);
        sendResponse({ ok: armResult.armed, ...armResult, ...(!armResult.armed ? { reason: "no-accessible-frame" } : {}) });
        break;
      }
      case "ebt:picked": {
        const pending = await getSession(PENDING_KEY, null);
        if (!pending || sender?.tab?.id !== pending.tabId || !msg.picked) {
          sendResponse({ ok: false, reason: "stale-pick" });
          break;
        }
        await setSession(PENDING_KEY, null);
        if (pending.trackerId) {
          const trackers = await getStore(TRACKERS_KEY, []);
          const tracker = trackers.find(t => t.id === pending.trackerId);
          if (!tracker) {
            await chrome.tabs.sendMessage(pending.tabId, { type: "ebt:cancel-training" }).catch(() => {});
            sendResponse({ ok: false, reason: "unknown-tracker" });
            break;
          }
          if (new URL(msg.picked.url).origin !== tracker.urlPattern) {
            await chrome.tabs.sendMessage(pending.tabId, { type: "ebt:cancel-training" }).catch(() => {});
            sendResponse({ ok: false, reason: "origin-mismatch" });
            break;
          }
          await updateTrackers((trackers) => {
            const existing = trackers.find(t => t.id === pending.trackerId);
            if (!existing) return; // should not happen due to earlier check
            existing.selector = msg.picked.selector;
            existing.anchor = msg.picked.anchor || null;
            delete existing.lastFailure;
          });
          let derivation = null;
          const parsed = parseBalance(msg.picked.text);
          await recordReading(tracker.id, {
            value: parsed.value, unit: parsed.unit,
            raw: msg.picked.text, source: "retrain",
            verified: !!tracker.anchor, healed: false,
          });
          if (!tracker.pattern) {
            derivation = await derivePattern(tracker.id, msg.picked.text);
          }
          await chrome.tabs.sendMessage(pending.tabId, {
            type: "ebt:trained", label: pending.label, pattern: derivation && derivation.ok ? derivation.pattern : null,
          }, { frameId: 0 }).catch(() => {});
          await chrome.tabs.sendMessage(pending.tabId, { type: "ebt:cancel-training" }).catch(() => {});
          sendResponse({ ok: true, trackerId: tracker.id });
        } else {
          const tracker = await addTracker({ label: pending.label, selector: msg.picked.selector, anchor: msg.picked.anchor || null, url: msg.picked.url });
          await recordReading(tracker.id, {
            value: parseBalance(msg.picked.text).value, unit: parseBalance(msg.picked.text).unit,
            raw: msg.picked.text, source: "training",
          });
          const derivation = await derivePattern(tracker.id, msg.picked.text);
          await chrome.tabs.sendMessage(pending.tabId, {
            type: "ebt:trained", label: pending.label, pattern: derivation.ok ? derivation.pattern : null,
          }, { frameId: 0 }).catch(() => {});
          await chrome.tabs.sendMessage(pending.tabId, { type: "ebt:cancel-training" }).catch(() => {});
          sendResponse({ ok: true, trackerId: tracker.id });
        }
        break;
      }
      case "ebt:pick-cancelled": {
        const pending = await getSession(PENDING_KEY, null);
        if (pending && sender?.tab?.id === pending.tabId) {
          await setSession(PENDING_KEY, null);
          await chrome.tabs.sendMessage(pending.tabId, { type: "ebt:cancel-training" }).catch(() => {});
        }
        sendResponse({ ok: true });
        break;
      }
      case "ebt:add-tracker":
        sendResponse({ ok: true, tracker: await addTracker(msg) });
        break;
      case "ebt:delete-tracker": {
        await updateTrackers((trackers) => {
          const idx = trackers.findIndex((t) => t.id === msg.id);
          if (idx !== -1) trackers.splice(idx, 1);
        });
        sendResponse({ ok: true });
        break;
      }
      case "ebt:restore-tracker": {
        const result = await enqueueStoreUpdate(async () => {
          const trackers = await getStore(TRACKERS_KEY, []);
          const res = restoreTracker(trackers, msg.tracker);
          if (res.ok) {
            await setStore(TRACKERS_KEY, res.trackers);
          }
          return res;
        });
        sendResponse(result);
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
    } catch (e) {
      // Never fail silently: a throwing handler used to leave picks unsaved
      // with no signal anywhere. Respond with the reason and log it.
      console.error("ebt handler error", msg?.type, e);
      try { sendResponse({ ok: false, reason: "handler-error: " + String(e?.message || e) }); } catch {}
    }
  })();
  return true;
});
