// Popup: train a new tracker on the active tab, read existing trackers.
import { summarizeTrace } from "../lib/trace.js";
import { BUILD_ID } from "../lib/build.js";
import { formatValue, formatMeta, titleFor, isStale, isUnverified, rowState } from "../lib/format.js";
import { displayValue, readingView, foreignSameSiteFrames } from "../lib/display.js";
import { describeReadFailure } from "../lib/messages.js";
import { trackersForTab, matchesTab, readButtonLabel, autoReadSummary, planRefreshAll, summarizeRefreshAll, originPattern } from "../lib/autoread.js";

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
  $("#refresh-all").hidden = trackers.length === 0;
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
    value.textContent = displayValue(t) ?? formatValue(last);
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
    retrainBtn.title = "Pick the number on the page again (use this after the page layout changed)";
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
    // Only an action the row needs right now stays inline: a failed (stale) read
    // offers Re-track; an unverified but working read is labelled, not nagged.
    const onTab = matchesTab(t, tabNow?.url);
    const needsFix = isStale(t); // unverified rows keep their label; Re-track is in the menu, not forced
    const menu = document.createElement("details");
    menu.className = "more";
    const sum = document.createElement("summary");
    sum.textContent = "More";
    sum.title = "Refresh, re-track or delete";
    const menuItems = document.createElement("span");
    menuItems.className = "more-items";
    const retrainInline = onTab && needsFix;
    if (!retrainInline) menuItems.append(retrainBtn);
    const view = readingView(t);
    if (view) {
      const modeBtn = document.createElement("button");
      modeBtn.className = "secondary";
      const inPercent = t.display === "percent";
      modeBtn.textContent = inPercent ? "Show amount" : "Show % left";
      modeBtn.addEventListener("click", async () => {
        const res = await chrome.runtime.sendMessage({ type: "ebt:set-display", id: t.id, display: inPercent ? "amount" : "percent" });
        if (res?.ok) { status(""); return render(); }
        status(res?.reason === "no-total"
          ? "Percent needs a total. This page does not show one: use Set total and enter the starting amount."
          : `Could not change the display: ${res?.reason || "unknown"}.`, true);
      });
      const totalIn = document.createElement("input");
      totalIn.type = "number"; totalIn.min = "0"; totalIn.step = "any";
      totalIn.className = "total-in";
      totalIn.placeholder = view.total === null ? "Start $" : String(view.total);
      totalIn.title = "Starting amount, used only to show percent left. Not read from the page.";
      totalIn.setAttribute("aria-label", `Starting amount for ${t.label}`);
      const totalBtn = document.createElement("button");
      totalBtn.className = "secondary";
      totalBtn.textContent = "Set total";
      totalBtn.addEventListener("click", async () => {
        const n = Number(totalIn.value);
        const res = await chrome.runtime.sendMessage({ type: "ebt:set-display", id: t.id, total: totalIn.value === "" ? null : n });
        if (res?.ok) { status(""); return render(); }
        status("Enter a starting amount greater than zero.", true);
      });
      menuItems.append(modeBtn);
      if (view.totalSource !== "page") menuItems.append(totalIn, totalBtn);
    }
    menuItems.append(delBtn);
    menu.append(sum, menuItems);
    const inline = [];
    if (!onTab) inline.push(readBtn);
    else { inline.push(readBtn); if (retrainInline) inline.push(retrainBtn); }
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
// The Refresh all report describes one run. Any later read makes it obsolete.
function clearRefreshReport() {
  const report = $("#refresh-report");
  report.replaceChildren();
  report.hidden = true;
}

async function readTracker(t) {
  hideUndo();
  clearRefreshReport();
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
    status(""); // the row already shows the new value and "just now"
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
  line.textContent = settings?.emberEnabled ? `Ember AI: on${spend} · ` : "Ember AI: off · ";
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
// Same-site frames the extension cannot read (activeTab covers this page's
// origin only). Offer to open the frame itself, which then reads like any page.
async function showFrameNote() {
  const note = $("#frame-note");
  note.hidden = true;
  const tab = await activeTab();
  if (!tab?.id || !tab.url) return;
  const res = await chrome.runtime.sendMessage({ type: "ebt:frames", tabId: tab.id }).catch(() => null);
  const frames = foreignSameSiteFrames(tab.url, res?.srcs);
  if (!frames.length) return;
  note.textContent = "";
  const msg = document.createElement("span");
  msg.textContent = `This page embeds ${frames[0].host} (a subdomain of this site) in a frame Ember cannot read. If that is where the number is, open it on its own, then click the Ember icon there. `;
  const open = document.createElement("button");
  open.className = "secondary";
  open.type = "button";
  open.textContent = `Open ${frames[0].host}`;
  open.addEventListener("click", async () => { await chrome.tabs.update(tab.id, { url: frames[0].url }); window.close(); });
  note.append(msg, open);
  note.hidden = false;
}

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
    results.push((await chrome.runtime.sendMessage({ type: "ebt:read-tracker", id: t.id, tabId: tab.id, auto: true })) || { ok: false });
    reading.delete(t.id);
    await render();
  }
  reading = new Set();
  await render();
  const failedIdx = results.findIndex((r) => !r.ok);
  const failed = failedIdx >= 0 ? results[failedIdx] : null;
  if (failed) {
    const hint = failed.reason === "unparseable" ? " Automatic reads are local only; press Refresh to let Ember AI try if you turned it on." : "";
    status(`${autoReadSummary(results)} ${describeReadFailure(failed.reason, mine[failedIdx].label)}${hint}`, true);
  }
  else status(""); // success is visible in the rows
}

render();
renderEmberLine();
showFrameNote();
showNotice().then(autoRead);

$("#refresh-all").addEventListener("click", async () => {
  hideUndo();
  clearRefreshReport();
  const { trackers } = await chrome.runtime.sendMessage({ type: "ebt:list" });
  const tab = await activeTab();
  const openTabs = (await chrome.tabs.query({})).filter((x) => x.url && x.id !== undefined).map((x) => ({ id: x.id, url: x.url }));
  const origins = [...new Set(openTabs.map((x) => originPattern(x.url)).filter(Boolean))];
  const granted = [];
  for (const o of origins) if (await chrome.permissions.contains({ origins: [o] })) granted.push(o);
  const plan = planRefreshAll(trackers, tab?.url, openTabs, granted);
  status(`Refreshing ${plan.length} balance${plan.length === 1 ? "" : "s"}...`);
  const results = {};
  for (const p of plan) {
    if (p.action !== "read") continue;
    reading.add(p.id);
    results[p.id] = (await chrome.runtime.sendMessage({ type: "ebt:read-tracker", id: p.id, tabId: p.tabId ?? tab.id, auto: true })) || { ok: false };
    reading.delete(p.id);
  }
  const lines = summarizeRefreshAll(plan, results);
  const report = $("#refresh-report");
  // Only what needs attention is listed; refreshed rows show their new value in the list below.
  report.replaceChildren(...lines.map((l, i) => {
    if (!/not refreshed/.test(l)) return null;
    const li = document.createElement("li"); li.textContent = l;
    if (/not refreshed/.test(l)) li.className = "error";
    if (plan[i].action === "switch") {
      const sw = document.createElement("button"); sw.className = "secondary"; sw.textContent = "Switch to tab";
      sw.addEventListener("click", async () => {
        const t = trackers.find((x) => x.id === plan[i].id);
        const found = (await chrome.tabs.query({})).find((x) => x.url?.startsWith(t.urlPattern));
        if (found?.id) { await chrome.tabs.update(found.id, { active: true }); if (found.windowId !== undefined) await chrome.windows.update(found.windowId, { focused: true }).catch(() => {}); }
      });
      li.append(" ", sw);
    }
    if (plan[i].action === "allow") {
      const p = plan[i];
      const al = document.createElement("button"); al.className = "secondary"; al.textContent = `Allow ${p.host}`;
      // chrome.permissions.request must run inside this click, one site per click.
      al.addEventListener("click", async () => {
        al.disabled = true;
        let ok = false;
        try { ok = await chrome.permissions.request({ origins: [p.origin] }); } catch { ok = false; }
        if (!ok) {
          li.textContent = `${p.label}: not refreshed (you did not allow ${p.host}).`;
          return;
        }
        const res = (await chrome.runtime.sendMessage({ type: "ebt:read-tracker", id: p.id, tabId: p.tabId, auto: true })) || { ok: false };
        li.textContent = summarizeRefreshAll([{ id: p.id, label: p.label, action: "read" }], { [p.id]: res })[0];
        li.className = res.ok ? "" : "error";
        await render();
      });
      li.append(" ", al);
    }
    return li;
  }).filter(Boolean));
  report.hidden = report.children.length === 0;
  const bad = lines.filter((l) => /not refreshed/.test(l)).length;
  await render();
  status(bad ? "" : `Refreshed all ${lines.length}.`);
});

