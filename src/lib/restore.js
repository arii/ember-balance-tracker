export function restoreTracker(trackers, tracker) {
  if (
    tracker === null ||
    typeof tracker !== "object" ||
    typeof tracker.id !== "string" ||
    typeof tracker.label !== "string" ||
    typeof tracker.selector !== "string" ||
    typeof tracker.urlPattern !== "string" ||
    !Array.isArray(tracker.history)
  ) {
    return { ok: false, reason: "invalid" };
  }
  if (trackers.some((t) => t.id === tracker.id)) {
    return { ok: false, reason: "duplicate" };
  }
  return { ok: true, trackers: [...trackers, tracker] };
}
