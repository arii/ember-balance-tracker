// Popup: train a new tracker on the active tab, read existing trackers.
import { summarizeTrace } from "../lib/trace.js";
import { BUILD_ID } from "../lib/build.js";

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

function fmtReading(t) {
  const last = t.history?.[t.history.length - 1];
  if (!last) return "never read";
  const unit = last.unit ? ` ${last.unit === "$" ? "" : last.unit}` : "";
  const val = last.unit === "$" ? `$${last.value}` : `${last.value}${unit}`;
  const when = new Date(last.ts).toLocaleString();
  return `${val} · ${when} · via ${last.source}`;
}

async function render() {
  const { trackers } = await chrome.runtime.sendMessage({ type: "ebt:list" });
  const list = $("#tracker-list");
  list.innerHTML = "";
  $("#empty").style.display = trackers.length ? "none" : "block";
  for (const t of trackers) {
    const li = document.createElement("li");
    const label = document.createElement("span");
    label.className = "t-label";
    label.textContent = t.label;
    const actions = document.createElement("span");
    actions.className = "t-actions";
    const readBtn = document.createElement("button");
    readBtn.className = "secondary";
    readBtn.textContent = "Read now";
    readBtn.addEventListener("click", () => readTracker(t));
    const delBtn = document.createElement("button");
    delBtn.className = "secondary";
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "ebt:delete-tracker", id: t.id });
      render();
    });
    actions.append(readBtn, delBtn);
    const meta = document.createElement("span");
    meta.className = "t-meta";
    meta.textContent = `${t.urlPattern} · ${fmtReading(t)}${t.pattern ? " · Ember rule ✓" : t.emberStatus && !t.emberStatus.ok ? ` · Ember: no rule learned (${t.emberStatus.reason}); reads use the saved page element` : ""}`;
    li.append(label, actions, meta);
    list.appendChild(li);
  }
}

async function readTracker(t) {
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
    await chrome.storage.session.set({ ebtNotice: `Found your ${t.label} tab — click "Read now" to read it.` });
    await chrome.tabs.update(found.id, { active: true });
    if (found.windowId !== undefined) await chrome.windows.update(found.windowId, { focused: true }).catch(() => {});
    return;
  }
  const res = await chrome.runtime.sendMessage({ type: "ebt:read-tracker", id: t.id, tabId: tab.id });
  if (res?.ok) {
    const p = res.parsed;
    status(`${t.label}: ${p.unit === "$" ? "$" + p.value : p.value + (p.unit ? " " + p.unit : "")} (via ${res.source})`);
    render();
  } else if (res?.needsRefresh) {
    status(`Can't find the balance on this page. Refresh the page (sign in if asked), then try again.`, true);
  } else {
    status(`Couldn't read ${t.label}: ${res?.reason || "unknown error"}.`, true);
  }
}

$("#train-btn").addEventListener("click", async () => {
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

render();
renderEmberLine();
showNotice();
