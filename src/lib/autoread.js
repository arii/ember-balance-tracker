// Pure helpers for reading on popup open. The popup is opened by clicking the
// toolbar icon, which grants activeTab for that one tab, so every tracker whose
// page is the active tab can be read with no further click. No new permissions.

export function matchesTab(tracker, tabUrl) {
  return typeof tabUrl === "string" && typeof tracker?.urlPattern === "string" && tabUrl.startsWith(tracker.urlPattern);
}

export function trackersForTab(trackers, tabUrl) {
  return (trackers || []).filter((t) => matchesTab(t, tabUrl));
}

export function readButtonLabel(tracker, tabUrl) {
  return matchesTab(tracker, tabUrl) ? "Refresh" : "Go to tab";
}

export function autoReadSummary(results) {
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  if (!results.length) return "";
  if (!failed) return `Read ${ok} balance${ok === 1 ? "" : "s"} on this page.`;
  return `Read ${ok} of ${results.length} on this page; ${failed} need attention.`;
}

// Reading on popup open must never spend. Prior consent covers a read the user asked
// for with a click, not an automatic one, so automatic reads run with the paid Ember
// fallback switched off (selector, saved pattern and DOM parse only). The manual
// Refresh / Go to tab flow keeps the existing consent and spend-cap gates.
export function localOnlySettings(settings) {
  return { ...(settings || {}), emberEnabled: false };
}

// A tab's tracked balances are "due" when they have never been read, the last read
// failed, or the last good reading is older than this. Used only to label the
// toolbar icon: the extension cannot read a page without a click (activeTab), and
// no polling or host permission is added.
export const DUE_AFTER_MS = 5 * 60_000;

export function dueForTab(trackers, tabUrl, now = Date.now()) {
  return trackersForTab(trackers, tabUrl).filter((t) => {
    const last = t.history?.[t.history.length - 1];
    if (!last) return true;
    if (t.lastFailure && t.lastFailure.ts > last.ts) return true;
    return now - new Date(last.ts).getTime() > DUE_AFTER_MS;
  });
}

export function badgeFor(trackers, tabUrl, now = Date.now()) {
  const due = dueForTab(trackers, tabUrl, now);
  if (!due.length) return { text: "", title: "Ember Balance Tracker" };
  return { text: "\u21BB", title: `Ember: ${due.length} balance${due.length === 1 ? "" : "s"} on this tab may be out of date. Click to refresh.` };
}

// Refresh all: what can really be done for each saved balance with activeTab only.
// A tracker on the active tab is read now (local only, never the paid fallback). One on
// another open tab cannot be read until the icon is clicked there. One with no open tab
// needs the site opened. Nothing is reported as refreshed unless a read succeeded.
export function planRefreshAll(trackers, activeUrl, openUrls) {
  return (trackers || []).map((t) => {
    if (matchesTab(t, activeUrl)) return { id: t.id, label: t.label, action: "read" };
    if ((openUrls || []).some((u) => matchesTab(t, u))) return { id: t.id, label: t.label, action: "switch" };
    return { id: t.id, label: t.label, action: "open" };
  });
}

export function summarizeRefreshAll(plan, results) {
  const lines = [];
  for (const p of plan) {
    if (p.action === "read") {
      const r = results[p.id];
      lines.push(r?.ok ? `${p.label}: refreshed.` : `${p.label}: not refreshed (${r?.reason || "read failed"}). Showing the last good value.`);
    } else if (p.action === "switch") {
      lines.push(`${p.label}: not refreshed (open in another tab). Switch to it and click the Ember icon.`);
    } else {
      lines.push(`${p.label}: not refreshed (page not open). Open it, then click the Ember icon.`);
    }
  }
  return lines;
}
