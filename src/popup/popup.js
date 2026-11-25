// Popup: train a new tracker on the active tab, read existing trackers.

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
    meta.textContent = `${t.urlPattern} · ${fmtReading(t)}`;
    li.append(label, actions, meta);
    list.appendChild(li);
  }
}

async function readTracker(t) {
  status(`Reading ${t.label}...`);
  const tab = await activeTab();
  if (!tab?.id) return status("No active tab.", true);
  if (!tab.url?.startsWith(t.urlPattern)) {
    return status(`Open ${t.urlPattern} first (sign in if needed), then read again.`, true);
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
  await chrome.runtime.sendMessage({ type: "ebt:arm-training", tabId: tab.id, label });
  window.close();
});

render();
