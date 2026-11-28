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
  return `Read ${ok} of ${results.length} on this page; ${failed} could not be read.`;
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

// Refresh all: what can really be done for each saved balance. A tracker on the active
// tab is read now (local only, never the paid fallback). One on another open tab is read
// if the user already allowed Ember on that site, or after one "Allow" click for that
// exact site (a browser permission prompt; the user can remove it in chrome://extensions).
// Meta pages are never offered a permission and stay manual. A tracker with no open
// tab needs the site opened. Nothing is reported as refreshed unless a read succeeded.
export function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

// The one origin Ember may ask for, or null when it must not ask (not https).
export function originPattern(url) {
  try {
    const u = new URL(url);
    return u.protocol === "https:" ? `${u.origin}/*` : null;
  } catch { return null; }
}

export function isMetaHost(host) {
  return typeof host === "string" && (host === "meta.ai" || host.endsWith(".meta.ai"));
}

export function planRefreshAll(trackers, activeUrl, openTabs, grantedOrigins = []) {
  return (trackers || []).map((t) => {
    const base = { id: t.id, label: t.label };
    if (matchesTab(t, activeUrl)) return { ...base, action: "read" };
    const tab = (openTabs || []).find((x) => matchesTab(t, x.url));
    if (!tab) return { ...base, action: "open" };
    const origin = originPattern(tab.url);
    const host = hostOf(tab.url);
    if (!origin || isMetaHost(host)) return { ...base, action: "switch" };
    if (grantedOrigins.includes(origin)) return { ...base, action: "read", tabId: tab.id };
    return { ...base, action: "allow", tabId: tab.id, origin, host };
  });
}

const REASON_TEXT = {
  "selector-not-found": "number not found; the page may have changed or you may be signed out",
  "anchor-mismatch": "page layout changed, use Re-track",
  "anchor-ambiguous": "more than one matching number, use Re-track",
  empty: "number is empty right now",
};

export function summarizeRefreshAll(plan, results) {
  const lines = [];
  for (const p of plan) {
    if (p.action === "read") {
      const r = results[p.id];
      lines.push(r?.ok ? `${p.label}: refreshed.` : `${p.label}: not refreshed (${REASON_TEXT[r?.reason] || "read failed"}). Showing the last good value.`);
    } else if (p.action === "allow") {
      lines.push(`${p.label}: not refreshed (needs your OK to read ${p.host}). Click Allow to read it now.`);
    } else if (p.action === "switch") {
      lines.push(`${p.label}: not refreshed (open in another tab). Switch to it and click the Ember toolbar icon.`);
    } else {
      lines.push(`${p.label}: not refreshed (page not open). Open it, then click the Ember toolbar icon.`);
    }
  }
  return lines;
}
