export function describeReadFailure(reason, label) {
  const displayLabel =
    typeof label === "string" && label.length > 0 ? label : "this balance";

  switch (reason) {
    case "anchor-ambiguous":
      return `The page now shows more than one "${displayLabel}" number, so Ember will not guess. Showing the last good value as stale. Open the right page and use Re-track to pick the correct number.`;
    case "anchor-mismatch":
      return `The "${displayLabel}" label is no longer next to the tracked number, so the layout changed. Showing the last good value as stale. Use Re-track to pick the number again.`;
    case "selector-not-found":
      return `Ember could not find the "${displayLabel}" number on this page. Refresh the page (sign in if asked), then read again.`;
    case "empty":
      return `The "${displayLabel}" number on this page is empty right now. Refresh the page and read again.`;
    case "stale-pick":
      return `The number you clicked changed before it was saved. Try picking it again.`;
    default:
      return `Could not read "${displayLabel}" (${reason || "unknown error"}).`;
  }
}
