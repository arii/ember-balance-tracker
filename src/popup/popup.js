// Popup: train a new tracker on the active tab, read existing trackers.
import { summarizeTrace } from "../lib/trace.js";
import { BUILD_ID } from "../lib/build.js";
import { formatValue, formatMeta, titleFor, isStale, isUnverified, rowState } from "../lib/format.js";
import { describeReadFailure } from "../lib/messages.js";
import { trackersForTab, matchesTab, readButtonLabel, autoReadSummary } from "../lib/autoread.js";

const $ = (sel) => document.querySelector(sel);
const status = (msg, isError = false) => {
  const el = $("#status");
  el.textContent = msg;
  el.classList.toggle("error", isError);
};

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

let reading = new Set();
let trainTouched = false;

async function render() {
  const { trackers } = await chrome.runtime.sendMessage({ type: "ebt:list" });
  const tabNow = await activeTab();
  const list = $("#tracker-list");
  list.innerHTML = "";
  $("#empty").style.display = trackers.length ? "none" : "block";
  if (!trainTouched) $("#train-details").open = trackers.length === 0;
  for (const t of trackers) {
    const li = document.createElement("li");
    li.title = titleFor(t);
    li.classList.add(`row-${rowState(t)}`);
    const label = document.createElement("span");
    label.className = "t-label";
    label.textContent = t.label;
    const value = document.createElement("span");
    value.className = "t-value";
    const last = t.history?.[t.history.length - 1];
    value.textContent = formatValue(last);
    if (!last) {
      value.classList.add("no-reading");
      if (reading.has(t.id)) value.textContent = "Reading...";
    }
    const meta = document.createElement("span");
    meta.className = "t-meta";
    if (t.lastFailure && last && t.lastFailure.ts > last.ts) meta.classList.add("stale");
    meta.textContent = last ? formatMeta(t) : "";
    const actions = document.createElement("span");
    actions.className = "t-actions";
    const readBtn = document.createElement("button");
    readBtn.className = "secondary";
    readBtn.textContent = reading.has(t.id) ? "Reading..." : readButtonLabel(t, tabNow?.url);
    readBtn.disabled = reading.has(t.id);
    readBtn.addEventListener("click", () => readTracker(t));
    const retrainBtn = document.createElement("button");
    retrainBtn.className = "secondary";
    retrainBtn.textContent = "Re-track";
    retrainBtn.addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.url?.startsWith(t.urlPattern)) {
        status(`Open ${t.urlPattern} first, then click Re-track.`, true);
        return;
      }
      try {
        const v = await chrome.runtime.sendMessage({ type: "ebt:version" });
        if (v.build !== BUILD_ID) {
          status("The extension is still running old code. Reload it from chrome://extensions and try again.", true);
          return;
        }
      } catch {
        status("Could not verify extension version.", true);
        return;
      }
      const res = await chrome.runtime.sendMessage({ type: "ebt:arm-training", tabId: tab.id, label: t.label, trackerId: t.id }).catch(() => null);
      if (!res?.ok) {
        status(`Could not start picker: ${res?.reason || "unknown error"}`, true);
        return;
      }
      window.close();
    });
    const delBtn = document.createElement("button");
    delBtn.className = "secondary";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      const res = await chrome.runtime.sendMessage({ type: "ebt:delete-tracker", id: t.id });
      render();
      if (res?.ok) {
        lastDeletedTracker = t;
        status(`Deleted ${t.label}.`);
        $("#undo-btn").hidden = false;
      } else {
        status(`Could not delete: ${res?.reason || "unknown"}.`, true);
      }
    });
    // Balance first: the row shows the value; actions live in a closed menu.
    // Only an action the row needs right now stays inline, so stale, unverified
    // and unreadable rows still say what to do.
    const onTab = matchesTab(t, tabNow?.url);
    const needsFix = isStale(t) || isUnverified(t);
    const menu = document.createElement("details");
    menu.className = "more";
    const sum = document.createElement("summary");
    sum.textContent = "More";
    sum.title = "Refresh, re-track or delete";
    const menuItems = document.createElement("span");
    menuItems.className = "more-items";
    if (onTab) menuItems.append(readBtn);
    const retrainInline = onTab && needsFix;
    if (!retrainInline) menuItems.append(retrainBtn);
    menuItems.append(delBtn);
    menu.append(sum, menuItems);
    const inline = [];
    if (!onTab) inline.push(readBtn);
    else if (retrainInline) inline.push(retrainBtn);
    actions.append(...inline, menu);
    li.append(label, value, meta, actions);
    list.appendChild(li);
  }
}

let lastDeletedTracker = null;
function hideUndo() { $("#undo-btn").hidden = true; }
$("#undo-btn").addEventListener("click", async () => {
  const t = lastDeletedTracker;
  if (!t) return;
  const res = await chrome.runtime.sendMessage({ type: "ebt:restore-tracker", tracker: t });
  if (res?.ok) {
    $("#undo-btn").hidden = true;
    render();
    status(`Restored ${t.label}.`);
  } else {
    $("#undo-btn").hidden = true;
    status(`Could not restore: ${res?.reason || "unknown"}.`, true);
  }
});
async function readTracker(t) {
  hideUndo();
  status(`Reading ${t.label}...`);
  const tab = await activeTab();
  if (!tab?.id) return status("No active tab.", true);
  if (!tab.url?.startsWith(t.urlPattern)) {
    // Find the dashboard's already-open tab instead of making the user hunt
    // for it. Page access still needs a click on that tab (activeTab grants
    // cover only the tab the extension was invoked on), so switch there and
    // ask for one more click; the notice below survives the popup closing.
    const tabs = await chrome.tabs.query({});
    const found = tabs.find((x) => x.url?.startsWith(t.urlPattern));
    if (!found?.id) return status(`Open ${t.urlPattern} first (sign in if needed), then read again.`, true);
    await chrome.storage.session.set({ ebtNotice: `Found your ${t.label} tab. Click the Ember icon there and it reads automatically.` });
    await chrome.tabs.update(found.id, { active: true });
    if (found.windowId !== undefined) await chrome.windows.update(found.windowId, { focused: true }).catch(() => {});
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "ebt:read-tracker", id: t.id, tabId: tab.id });
  if (res?.ok) {
    const p = res.parsed;
    status(`${t.label}: ${formatValue(p)} (via ${res.source})`);
    render();
  } else if (res?.reason === "anchor-mismatch" || res?.reason === "anchor-ambiguous") {
    status(describeReadFailure(res.reason, t.label), true);
    render();
  } else if (res?.needsRefresh) {
    status(`Can't find the balance on this page. Refresh the page (sign in if asked), then try again.`, true);
    render();
  } else {
    status(describeReadFailure(res?.reason, t.label), true);
    render();
  }
}

$("#train-details").addEventListener("toggle", () => { trainTouched = true; });
$("#train-btn").addEventListener("click", async () => {
  hideUndo();
  const label = $("#label").value.trim();
  if (!label) return status("Enter a label first.", true);
  const tab = await activeTab();
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return status("Open a regular web page first.", true);
  // Arm and close: the background completes the pick, stores the tracker,
  // and (if enabled) asks Muse Ember for a reusable extraction regex.
  try {
    const version = await chrome.runtime.sendMessage({ type: "ebt:version" });
    if (!version?.ok || version.build !== BUILD_ID) return status("Ember was updated but is still running old code. Open chrome://extensions, click reload on Ember, then try again.", true);
    const result = await chrome.runtime.sendMessage({ type: "ebt:arm-training", tabId: tab.id, label });
    if (!result?.ok || !result.armed) return status(`Could not start picker: ${result?.reason || "no accessible frame"}.`, true);
    window.close();
  } catch (e) {
    status(`Could not start picker: ${e?.message || e}.`, true);
  }
});

async function renderEmberLine() {
  const line = $("#ember-line");
  const { settings } = await chrome.storage.local.get("settings");
  const { emberTrace } = await chrome.storage.local.get("emberTrace");
  const s = summarizeTrace(emberTrace || []);
  const spend = s.calls
    ? ` · ${s.calls} call${s.calls === 1 ? "" : "s"}${s.costUsd == null ? " (cost unknown)" : ` · ≈$${s.costUsd.toFixed(6)}`}`
    : "";
  line.textContent = settings?.emberEnabled ? `Ember AI: on${spend} · ` : "Ember AI: off (reads are local and free) · ";
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "Settings";
  link.addEventListener("click", (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  line.appendChild(link);
}

async function showNotice() {
  const { ebtNotice } = await chrome.storage.session.get("ebtNotice");
  if (ebtNotice) {
    status(ebtNotice);
    await chrome.storage.session.remove("ebtNotice");
  }
}

// Read on open: the icon click granted this tab, so every tracker for it is
// read now without another click. Other tabs stay unread until opened.
async function autoRead() {
  const tab = await activeTab();
  const { trackers } = await chrome.runtime.sendMessage({ type: "ebt:list" });
  const mine = trackersForTab(trackers, tab?.url);
  if (!tab?.id || !mine.length) return;
  reading = new Set(mine.map((t) => t.id));
  status(`Reading ${mine.length} balance${mine.length === 1 ? "" : "s"}...`);
  await render();
  const results = [];
  for (const t of mine) {
    results.push((await chrome.runtime.sendMessage({ type: "ebt:read-tracker", id: t.id, tabId: tab.id })) || { ok: false });
    reading.delete(t.id);
    await render();
  }
  reading = new Set();
  await render();
  const failed = results.find((r) => !r.ok);
  if (failed) status(`${autoReadSummary(results)} ${describeReadFailure(failed.reason, "A balance")}`, true);
  else status(autoReadSummary(results));
}

render();
renderEmberLine();
showNotice().then(autoRead);
