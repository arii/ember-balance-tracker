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
